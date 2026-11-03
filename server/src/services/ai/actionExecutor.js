// actionExecutor.js — the only place a Co-Pilot-proposed write actually
// reaches GHL.
//
// Called from routes/ai.js when a REP clicks Confirm on an ActionCard —
// never from a propose tool, never from the model. Re-validates the action
// is still 'pending' — or 'failed', which is allowed to retry (see
// retryAction in actionStore.js) — and dispatches to the SAME write
// functions every non-AI write in this app already goes through — nothing
// here is a new way to write to GHL, only a new way to have arrived at
// deciding to. resolveAction's WHERE clause still makes a double-click or a
// truly stale retry a no-op, not a second write.

import { getActiveInstall, explainInactiveInstall } from '../ghlClient.js';
import {
  createGhlContact, updateGhlContact, ContactWriteError
} from '../ghlContactWrite.js';
import {
  updateGhlOpportunity, setGhlOpportunityStatus, deleteGhlOpportunity,
  createGhlOpportunity, addGhlOpportunityFollowers, removeGhlOpportunityFollowers,
  OpportunityWriteError
} from '../ghlOpportunityWrite.js';
import { addDealContact, removeDealContact, AssociationError } from '../ghlAssociations.js';
import { applyClearedCustomFields } from '../opportunityFields.js';

import { sendGhlMessage, MessageWriteError } from '../ghlMessageWrite.js';
import {
  createGhlTask, setGhlTaskCompleted, updateGhlTask, deleteGhlTask, TaskWriteError
} from '../ghlTaskWrite.js';
import {
  createGhlNote, updateGhlNote, deleteGhlNote, NoteWriteError
} from '../ghlNoteWrite.js';
import {
  addGhlContactTags, removeGhlContactTags, TagWriteError
} from '../ghlTagWrite.js';
import {
  createGhlBusiness, updateGhlBusiness, deleteGhlBusiness, BusinessWriteError
} from '../ghlBusinessWrite.js';
import { getAction, resolveAction, retryAction } from './actionStore.js';
import { COMPOSER_POINTER } from './tools/registry.js';
import { rawQuery, withTenant } from '../../db.js';
import {
  recordPendingDealLink, ENTITY_TASK, ENTITY_NOTE
} from '../pendingDealLink.js';
import { logger } from '../../utils/logger.js';

// The To recipients of an email proposal, in order. `to` was a single object
// before the card allowed several; both shapes are read so an older pending
// proposal still confirms.
const toRecipients = (payload) => {
  const t = payload?.recipients?.to;
  const arr = Array.isArray(t) ? t : (t ? [t] : []);
  return arr.filter((r) => r?.email);
};

// One proposal, one or several GHL sends.
//
// An email to several people goes out in one of two shapes, chosen on the
// card (recipientMode):
//
//   'separate' — a COPY PER To contact, each addressed to that person alone
//                and filed in their own conversation, CC/BCC repeated on
//                each. The default for a new email: every recipient reads
//                their own name in To, and their reply threads back to
//                them. (GHL's send takes one To address, so this is also
//                the only way for more than one person to BE the To.)
//   'together' — ONE email: the first To as GHL's To, the other Tos as CC.
//                The default for a reply, which belongs to one thread, and
//                the right shape when the people need to see each other.
//
// SMS and WhatsApp are untouched: one contact, one send.
async function sendMessageProposal(install, payload, confirmedBy) {
  const base = {
    type: payload.type,
    subject: payload.subject,
    message: payload.message,
    html: payload.html,
    // Present only when the composer had to disambiguate — see
    // ghlMessageWrite.buildMessageSend.
    conversationProviderId: payload.conversationProviderId,
    // WHO IS SENDING. The rep who pressed Confirm, so GHL records the
    // message against them — the conversation shows their name, not
    // the app's, and an emailFrom from their two-way-sync mailbox is
    // sent as that user. It was omitted, so every send was anonymous.
    userId: confirmedBy || undefined
  };
  const reply = payload.replyMessageId ? {
    replyMessageId: payload.replyMessageId,
    threadId: payload.threadId,
    // With explicit recipients the wire mode is a plain reply: reply_all
    // would have GHL re-add everyone from the original, including anyone
    // the rep removed from the card. The card's chips are the whole list.
    emailReplyMode: payload.recipients ? 'reply' : payload.emailReplyMode
  } : {};
  const cc = (payload.recipients?.cc || []).map((r) => r?.email).filter(Boolean);
  const bcc = (payload.recipients?.bcc || []).map((r) => r?.email).filter(Boolean);
  const tos = payload.type === 'Email' ? toRecipients(payload) : [];

  const separate = payload.type === 'Email'
    && tos.length > 1
    && (payload.recipientMode || (payload.replyMessageId ? 'together' : 'separate')) === 'separate';

  if (!separate) {
    // A single To that is the contact's own address is the wire shape every
    // email used before recipients existed: no emailTo at all, GHL sends to
    // the contact. Kept identical on purpose — an explicit emailTo is only
    // needed when the rep addressed someone other than the contact.
    const firstTo = tos[0]?.email;
    const explicitTo = firstTo && tos[0]?.contactId !== payload.contactId ? firstTo : undefined;
    return sendGhlMessage(install, {
      ...base,
      contactId: payload.contactId,
      ...reply,
      emailTo: explicitTo,
      emailCc: [...tos.slice(1).map((r) => r.email), ...cc],
      emailBcc: bcc
    });
  }

  // A copy per To. The reply fields belong to the original thread's own
  // contact only — for anyone else it is a fresh email with the same
  // subject, because their conversation has no such thread to reply into.
  const results = [];
  const failures = [];
  for (const r of tos) {
    const isThreadOwner = r.contactId === payload.contactId;
    try {
      const out = await sendGhlMessage(install, {
        ...base,
        contactId: r.contactId || payload.contactId,
        ...(isThreadOwner ? reply : {}),
        emailTo: r.email,
        emailCc: cc,
        emailBcc: bcc
      });
      results.push({ contactId: r.contactId, email: r.email, ...out });
    } catch (err) {
      failures.push({ contactId: r.contactId, email: r.email, error: err?.message || String(err) });
    }
  }
  logger.info(
    { locationId: install.location_id, sent: results.length, failed: failures.length },
    'ai: send_message — separate copy per recipient'
  );
  if (failures.length) {
    // Honest about a partial send: the ones that went out are named, so the
    // rep does not resend them; the ones that failed are named with why.
    const sentTo = results.map((x) => x.email).join(', ');
    const failedTo = failures.map((x) => `${x.email} (${x.error})`).join('; ');
    throw new MessageWriteError(
      (sentTo ? `Sent to ${sentTo}. ` : '') + `Could not send to ${failedTo}`,
      // Always a failure status: a 2xx would let the card show the send as
      // complete when part of it was not.
      { status: 502 }
    );
  }
  return {
    messageId: results[0]?.messageId || null,
    emailMessageId: results[0]?.emailMessageId || null,
    conversationId: results[0]?.conversationId || null,
    status: results[0]?.status || null,
    copies: results
  };
}

// Shared by any action_type whose payload only carries a taskId — the
// propose tool never has (and shouldn't guess) the task's own contactId,
// since none of the read tools that surface a taskId (search_tasks,
// get_deal_tasks_and_notes) return one in their row shape. Resolved here
// instead, from the same table those tools themselves read.
async function contactIdForTask(locationId, taskId) {
  const { rows } = await rawQuery(
    `SELECT contact_id FROM tasks WHERE location_id = $1 AND task_id = $2`,
    [locationId, taskId]
  );
  return rows[0]?.contact_id || null;
}

// Same reasoning as contactIdForTask — get_deal_tasks_and_notes/search_notes
// give the model a real noteId but no contact_id column, so it's resolved
// here from our own row instead of asked of the model.
async function contactIdForNote(locationId, noteId) {
  const { rows } = await rawQuery(
    `SELECT contact_id FROM notes WHERE location_id = $1 AND note_id = $2`,
    [locationId, noteId]
  );
  return rows[0]?.contact_id || null;
}

// removeDealContact takes GHL's own relation_id, a real Mongo ObjectId no
// lookup tool exposes to the model (search_deals/get_deal_contacts surface
// contactId, not the relation row) — resolved here from opportunity_contacts,
// the table the RelationCreate webhook itself populates. See
// ghlAssociations.js's own comment on why a derived id can't be guessed here.
async function relationIdForOppContact(locationId, opportunityId, contactId) {
  const { rows } = await rawQuery(
    `SELECT relation_id FROM opportunity_contacts
      WHERE location_id = $1 AND opportunity_id = $2 AND contact_id = $3`,
    [locationId, opportunityId, contactId]
  );
  return rows[0]?.relation_id || null;
}

export class ActionExecutionError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'ActionExecutionError';
    this.status = status;
  }
}

/**
 * Confirm a pending action — a rep clicked Confirm, optionally after
 * editing the proposed fields in the ActionCard.
 *
 * @param {string} locationId
 * @param {string} actionId
 * @param {object} [edits]     fields the rep changed before confirming;
 *                             merged over the model's proposed_payload, so
 *                             an edit to one field doesn't require
 *                             resending every field.
 * @param {string} [confirmedBy]  GHL user id, for the audit trail.
 */
export async function confirmAction(locationId, actionId, edits = null, confirmedBy = null) {
  const action = await getAction(locationId, actionId);
  if (!action) throw new ActionExecutionError('That proposal no longer exists', { status: 404 });

  if (action.status === 'failed') {
    // A failed confirm is usually our own bug or a transient GHL error, not
    // proof the proposal was wrong — let a rep retry it with the same or
    // edited fields instead of leaving it a permanent dead end. Flips the
    // row back to 'pending' right here, right before we attempt the write
    // again, so the single-attempt-in-flight guarantee below still holds.
    const retried = await retryAction(locationId, actionId);
    if (!retried) {
      // Lost a race with another retry/confirm on this row — re-fetch and
      // fall through to the normal status check below.
      const fresh = await getAction(locationId, actionId);
      if (fresh && fresh.status !== 'pending') {
        throw new ActionExecutionError(
          `This proposal was already ${fresh.status}`, { status: 409 }
        );
      }
    }
  } else if (action.status !== 'pending') {
    // Not an error worth alarming a rep over — a double-click on Confirm, or
    // two tabs open on the same answer, lands here. The UI reads this as
    // "already handled" rather than a failure.
    throw new ActionExecutionError(
      `This proposal was already ${action.status}`, { status: 409 }
    );
  }

  // A message drafted by the Deal Hub Co-Pilot BEFORE sending moved to the
  // timeline composer can still sit, pending, in an old chat. Deal Hub runs
  // carry their deal id; Insights AI runs carry none — so only the deal's
  // old drafts are refused here, with the same pointer Co-Pilot now gives.
  // withTenant, not rawQuery: ai_runs is under RLS.
  if (action.action_type === 'send_message' && action.run_id) {
    const { rows } = await withTenant(locationId, (client) => client.query(
      `SELECT opportunity_id FROM ai_runs WHERE id = $1 AND location_id = $2`,
      [action.run_id, locationId]
    ));
    if (rows[0]?.opportunity_id) {
      throw new ActionExecutionError(COMPOSER_POINTER, { status: 409 });
    }
  }

  const payload = edits ? { ...action.proposed_payload, ...edits } : action.proposed_payload;

  const install = await getActiveInstall(locationId);
  if (!install) {
    const { message } = await explainInactiveInstall(locationId);
    throw new ActionExecutionError(message, { status: 409 });
  }

  try {
    const result = await runWrite(install, action.action_type, payload, confirmedBy);
    await resolveAction(locationId, actionId, {
      status: 'confirmed', editedPayload: edits, result, confirmedBy
    });
    return { status: 'confirmed', result };
  } catch (err) {
    // A CRM rejection (bad phone format, deal already won, etc.) is not a
    // system failure — it's exactly the case an editable ActionCard exists
    // for. Recorded as 'failed', not silently left 'pending': a rep who
    // clicked Confirm and hit a wall needs to see why and can then edit and
    // retry, rather than the card just vanishing or reverting with no
    // explanation.
    const message = err.message || 'Could not complete this action';
    await resolveAction(locationId, actionId, {
      status: 'failed', editedPayload: edits, result: { error: message }, confirmedBy
    });
    logger.warn({ err, locationId, actionId, actionType: action.action_type }, 'ai: action confirm failed');
    throw new ActionExecutionError(message, { status: err.status || 502 });
  }
}

export async function rejectAction(locationId, actionId, rejectedBy = null) {
  const action = await getAction(locationId, actionId);
  if (!action) throw new ActionExecutionError('That proposal no longer exists', { status: 404 });

  if (action.status === 'failed') {
    // A rep can also just dismiss a failed proposal instead of retrying it —
    // same retry-then-resolve dance as confirmAction, so resolveAction's
    // pending-only guard still applies.
    await retryAction(locationId, actionId);
  } else if (action.status !== 'pending') {
    throw new ActionExecutionError(
      `This proposal was already ${action.status}`, { status: 409 }
    );
  }
  const resolved = await resolveAction(locationId, actionId, { status: 'rejected', confirmedBy: rejectedBy });
  if (!resolved) {
    const fresh = await getAction(locationId, actionId);
    throw new ActionExecutionError(
      `This proposal was already ${fresh?.status || 'resolved'}`, { status: 409 }
    );
  }
  return { status: 'rejected' };
}

// `confirmedBy` is the GHL user id of the rep who clicked Confirm. It is NOT
// cosmetic: a task written without an owner lands with assigned_to NULL, and
// the Tasks tab filters on exactly that column — so the rep who asked for the
// task could not find it afterwards under their own name. Threaded through to
// the two writes that can carry a person.
async function runWrite(install, actionType, payload, confirmedBy = null) {
  switch (actionType) {
    case 'create_contact':
      return createGhlContact(install, {
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        phone: payload.phone
      });

    case 'attach_contact':
      return addDealContact(install, payload.opportunityId, payload.contactId);

    case 'remove_contact': {
      const relationId = await relationIdForOppContact(
        install.location_id, payload.opportunityId, payload.contactId
      );
      if (!relationId) {
        throw new AssociationError('That contact is not linked to this deal', { status: 404 });
      }
      return removeDealContact(install, relationId);
    }

    case 'create_deal':
      return createGhlOpportunity(install, {
        contactId: payload.contactId,
        name: payload.name,
        monetaryValue: payload.value ?? undefined,
        pipelineId: payload.pipelineId,
        pipelineStageId: payload.pipelineStageId ?? undefined
      });

    case 'update_deal': {
      const edit = {};
      if (payload.name != null) edit.name = payload.name;
      if (payload.value != null) edit.value = payload.value;
      if (payload.pipelineId != null) edit.pipelineId = payload.pipelineId;
      if (payload.pipelineStageId != null) edit.pipelineStageId = payload.pipelineStageId;
      if (payload.closeDate) edit.forecastExpectedCloseDate = payload.closeDate;
      // Custom fields, in GHL's [{ id, field_value }] shape. The card lets
      // the rep change `value` before confirming, so that is what is read;
      // `field_value` is what the deal PATCH route sends and what
      // applyClearedCustomFields looks at.
      const customFields = Array.isArray(payload.customFields)
        ? payload.customFields
            .filter((f) => f && f.id)
            .map((f) => ({ id: f.id, field_value: f.value == null ? '' : f.value }))
        : [];
      if (customFields.length) edit.customFields = customFields;
      if (!Object.keys(edit).length) {
        throw new OpportunityWriteError('Nothing to change on this deal', { status: 400 });
      }
      const out = await updateGhlOpportunity(install, payload.opportunityId, edit);
      // A cleared field never comes back on the webhook — see the note on
      // applyClearedCustomFields for why the receiver has to record it.
      await applyClearedCustomFields(install.location_id, payload.opportunityId, customFields);
      return out;
    }

    case 'change_owner':
      return updateGhlOpportunity(install, payload.opportunityId, {
        assignedTo: payload.ownerUserId
      });

    case 'change_status':
      return setGhlOpportunityStatus(install, payload.opportunityId, {
        status: payload.status,
        lostReasonId: payload.lostReasonId || undefined
      });

    case 'send_message':
      return sendMessageProposal(install, payload, confirmedBy);

    case 'create_task': {
      const task = await createGhlTask(install, payload.contactId, {
        title: payload.title,
        body: payload.body,
        dueDate: payload.dueDate,
        // Whoever confirmed it owns it. An explicit assignee on the payload
        // wins — the proposal may name someone else deliberately — but the
        // fallback must never be "nobody": that is the bug this fixes.
        // undefined, NOT null: buildTaskPatch skips an undefined value but
        // forwards an explicit null to GHL as a field to clear. With no
        // confirming user known there is nothing to say about the owner, and
        // saying "set it to nothing" is a different statement from saying
        // nothing at all.
        assignedTo: payload.assignedTo || confirmedBy || undefined
      });
      // Park the deal choice and the provenance for TaskCreate.
      //
      // Our row does not exist yet — the webhook owns the INSERT — so this
      // is the only moment the two facts are known. Without it an AI task
      // fell back to the attribution RULE for its deal (the contact's
      // earliest open one, right only by coincidence) and recorded no
      // creator at all.
      //
      // Non-fatal by design, like the manual route's own call: the task is
      // already written in GHL, and failing here would tell a rep their task
      // did not save when it did.
      await recordPendingDealLink(
        install.location_id, ENTITY_TASK, task?.id,
        payload.opportunityId || null, confirmedBy || null, 'ai'
      );
      return task;
    }

    case 'complete_task': {
      const contactId = await contactIdForTask(install.location_id, payload.taskId);
      if (!contactId) throw new TaskWriteError('Could not find that task', { status: 404 });
      return setGhlTaskCompleted(
        install, { contactId, taskId: payload.taskId }, payload.completed !== false
      );
    }

    case 'update_task': {
      const contactId = await contactIdForTask(install.location_id, payload.taskId);
      if (!contactId) throw new TaskWriteError('Could not find that task', { status: 404 });
      const edit = {};
      if (payload.title != null) edit.title = payload.title;
      if (payload.body != null) edit.body = payload.body;
      if (payload.dueDate != null) edit.dueDate = payload.dueDate;
      return updateGhlTask(install, { contactId, taskId: payload.taskId }, edit);
    }

    case 'delete_task': {
      const contactId = await contactIdForTask(install.location_id, payload.taskId);
      if (!contactId) throw new TaskWriteError('Could not find that task', { status: 404 });
      return deleteGhlTask(install, { contactId, taskId: payload.taskId });
    }

    case 'create_note': {
      const note = await createGhlNote(install, payload.contactId, {
        body: payload.body,
        pinned: payload.pinned === true,
        // GHL's note API takes a userId and we already store it as
        // notes.author_user_id — the AI path simply never sent one, so an
        // AI-written note showed no author while a hand-written one did.
        userId: payload.userId || confirmedBy || undefined
      });
      await recordPendingDealLink(
        install.location_id, ENTITY_NOTE, note?.id,
        payload.opportunityId || null, confirmedBy || null, 'ai'
      );
      return note;
    }

    case 'update_note': {
      const contactId = await contactIdForNote(install.location_id, payload.noteId);
      if (!contactId) throw new NoteWriteError('Could not find that note', { status: 404 });
      const edit = {};
      if (payload.body != null) edit.body = payload.body;
      if (payload.pinned != null) edit.pinned = payload.pinned;
      return updateGhlNote(install, { contactId, noteId: payload.noteId }, edit);
    }

    case 'delete_note': {
      const contactId = await contactIdForNote(install.location_id, payload.noteId);
      if (!contactId) throw new NoteWriteError('Could not find that note', { status: 404 });
      return deleteGhlNote(install, { contactId, noteId: payload.noteId });
    }

    case 'add_tags':
      return addGhlContactTags(install, payload.contactId, { tags: payload.tags });

    case 'remove_tags':
      return removeGhlContactTags(install, payload.contactId, { tags: payload.tags });

    case 'update_contact': {
      const edit = {};
      for (const k of ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'companyName']) {
        if (payload[k] != null) edit[k] = payload[k];
      }
      return updateGhlContact(install, payload.contactId, edit);
    }

    case 'delete_deal':
      return deleteGhlOpportunity(install, payload.opportunityId);

    case 'create_business':
      return createGhlBusiness(install, {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        website: payload.website,
        address: payload.address,
        city: payload.city
      });

    case 'update_business': {
      const edit = {};
      for (const k of ['name', 'email', 'phone', 'website', 'address', 'city']) {
        if (payload[k] != null) edit[k] = payload[k];
      }
      return updateGhlBusiness(install, payload.businessId, edit);
    }

    case 'delete_business':
      return deleteGhlBusiness(install, payload.businessId);

    case 'add_followers':
      return addGhlOpportunityFollowers(install, payload.opportunityId, {
        followers: payload.followerUserIds
      });

    case 'remove_followers':
      return removeGhlOpportunityFollowers(install, payload.opportunityId, {
        followers: payload.followerUserIds
      });

    default:
      throw new ActionExecutionError(`Unknown action type: ${actionType}`, { status: 400 });
  }
}

// Re-exported so routes/ai.js can distinguish a validation-style rejection
// (400/404/409, safe to show verbatim) from the underlying write errors —
// same convention ContactWriteError/OpportunityWriteError/AssociationError
// already follow elsewhere in this codebase.
export {
  ContactWriteError, OpportunityWriteError, AssociationError, MessageWriteError,
  TaskWriteError, NoteWriteError, TagWriteError, BusinessWriteError
};
