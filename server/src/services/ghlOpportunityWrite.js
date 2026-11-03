// ghlOpportunityWrite.js — push deal edits to GoHighLevel.
//
// FLOW — the contacts pattern, and this time for the strongest reason of the
// five write paths in this app.
//
// Opportunities have FULL webhook coverage: OpportunityUpdate,
// OpportunityStatusUpdate, OpportunityStageUpdate, OpportunityMonetaryValueUpdate,
// OpportunityAssignedToUpdate and OpportunityDelete (see routes/webhooks.js).
// Every one of them lands in stageHistoryWriter, which does far more than write
// a row:
//
//   • opens and closes stage_history rows, which is the entire basis of the
//     "days in stage" and velocity reporting
//   • records field-level changes into opportunity_field_history
//   • reconciles tags, refreshes associations, re-resolves the contact
//
// So this service does NOT write Postgres. Writing the opportunities row here
// as well would produce a row whose stage_history disagrees with it — and
// stage_history is the one table in this schema that cannot be rebuilt from
// current state. That is why there is no applyEcho here, unlike tasks and
// businesses.
//
// The cost is a visible round trip: an edit takes as long as the webhook takes
// to arrive. Correct trade — the alternative is corrupt history.
//
// SCOPE. opportunities.write. The opportunities.readonly we already hold for
// the sync is not enough, and PIPELINE writes need a different scope family
// again (see the note at the end of opportunityPatch.js — deliberately unwired).

import { ghlRequest } from './ghlClient.js';
import { rejectionMessage, logRejection } from './ghlRejection.js';
import {
  buildOpportunityPatch, buildStatusPatch, buildFollowerList,
  OpportunityWriteError
} from './opportunityPatch.js';
import { logger } from '../utils/logger.js';
import { markOpportunityDeletedLocally } from './opportunitiesSync.js';

export {
  buildOpportunityPatch, buildStatusPatch, buildFollowerList, OpportunityWriteError
};

function translateGhlError(err, { opportunityId = null, verb, install = null }) {
  const status = err.response?.status;
  const body = err.response?.data;
  const detail = body?.message || body?.error
    || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);

  if (status === 401 || status === 403) {
    return new OpportunityWriteError(
      'This app cannot change deals yet — the opportunities.write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (status === 404) {
    // Logged with GHL's body: a 404 here is almost always a mistyped or
    // stale id, and without the id in the log there is nothing to check.
    logger.warn({ status, opportunityId, detail, body }, `ghlOpportunityWrite: ${verb} — GHL has no such deal`);
    // GHL has just told us the deal is gone. If we still hold it as live,
    // the OpportunityDelete webhook was missed — record the delete now, so
    // the deal stops appearing in the pipeline and being offered for edits,
    // instead of waiting for the nightly sweep to notice. Fire-and-forget:
    // the caller's error is about THIS write, and the heal must not delay
    // or alter it.
    if (install && opportunityId) {
      markOpportunityDeletedLocally(install, opportunityId, { via: `ghl 404 on ${verb}` })
        .catch(() => {});
    }
    return new OpportunityWriteError(
      `That deal no longer exists in your CRM (id ${opportunityId || '(none)'}) — it has now been marked deleted here too`,
      { status: 404 }
    );
  }
  if (status === 422 || status === 400) {
    // A stage id from the wrong pipeline is the commonest rejection here, and
    // GHL's own message for it does not say so.
    if (detail && /stage/i.test(detail)) {
      return new OpportunityWriteError(
        `That stage cannot be used: ${detail}`,
        { status: 422, field: 'pipelineStageId' }
      );
    }
    // GHL's own text is LOGGED, never shown — services/ghlRejection.js
    // explains why: it names a field for a validation error, but a raw
    // record id for a missing one, and the whole sales team sees these.
    logRejection('ghlOpportunityWrite', { status, detail, body });
    const rej = rejectionMessage('deal', detail);
    return new OpportunityWriteError(rej.message, { status: rej.status, detail });
  }
  logger.error(
    { err, status, opportunityId, body },
    `ghlOpportunityWrite: ${verb} failed`
  );
  return new OpportunityWriteError(
    `Could not ${verb} the deal — try again`, { status: 502 }
  );
}

const enc = encodeURIComponent;

/**
 * PUT /opportunities/{id}
 *
 * Send only the changed fields. Does not touch Postgres — OpportunityUpdate
 * fires and stageHistoryWriter owns the row.
 *
 * NOTE: status is accepted here, but a LOST status with a reason must go
 * through setGhlOpportunityStatus instead — this endpoint has no lostReasonId,
 * so the reason would be silently dropped. routes/deals.js enforces that.
 */
export async function updateGhlOpportunity(install, opportunityId, input, { allowPrimaryContact = false } = {}) {
  if (!opportunityId) throw new OpportunityWriteError('Which deal?', { status: 400 });
  const { patch, dropped } = buildOpportunityPatch(input, { create: false, allowPrimaryContact });

  if (dropped.length) {
    logger.warn(
      { opportunityId, dropped },
      'ghlOpportunityWrite: ignored fields not writable on the opportunity endpoint'
    );
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      url: `/opportunities/${enc(opportunityId)}`,
      data: patch
    });
    logger.info(
      { opportunityId, fields: Object.keys(patch) },
      'ghlOpportunityWrite: deal updated'
    );
    return data?.opportunity || null;
  } catch (err) {
    throw translateGhlError(err, { opportunityId, verb: 'update', install });
  }
}

/**
 * PUT /opportunities/{id}/status
 *
 * Its own endpoint because it is the ONLY way to attach a lost reason. Marking
 * a deal lost through the general update drops the reason without complaint.
 *
 * Returns { success, succeded } — both spellings, the second being GHL's typo.
 * Neither is read: a non-throwing response is the success signal.
 */
export async function setGhlOpportunityStatus(install, opportunityId, { status, lostReasonId }) {
  if (!opportunityId) throw new OpportunityWriteError('Which deal?', { status: 400 });
  const body = buildStatusPatch({ status, lostReasonId });

  try {
    await ghlRequest(install, {
      method: 'PUT',
      url: `/opportunities/${enc(opportunityId)}/status`,
      data: body
    });
    logger.info(
      { opportunityId, ...body },
      'ghlOpportunityWrite: deal status set'
    );
    return true;
  } catch (err) {
    throw translateGhlError(err, { opportunityId, verb: 'update', install });
  }
}

/**
 * POST /opportunities/
 *
 * locationId and contactId come from the caller — the route takes locationId
 * from the session and checks contactId against our own contacts under RLS, so
 * a client cannot create a deal in another tenant or against someone else's
 * contact.
 *
 * The row is NOT inserted here: OpportunityCreate owns that, including the
 * opening stage_history row that only the webhook path knows how to write.
 */
export async function createGhlOpportunity(install, { contactId, ...input }) {
  if (!contactId) {
    throw new OpportunityWriteError(
      'A deal needs a contact', { status: 400, field: 'contactId' }
    );
  }
  const { patch, dropped } = buildOpportunityPatch(input, { create: true });
  if (dropped.length) {
    logger.warn({ dropped }, 'ghlOpportunityWrite: ignored non-writable fields');
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: '/opportunities/',
      data: { ...patch, contactId, locationId: install.location_id }
    });
    const opp = data?.opportunity || null;
    logger.info(
      { opportunityId: opp?.id, contactId, fields: Object.keys(patch) },
      'ghlOpportunityWrite: deal created'
    );
    return opp;
  } catch (err) {
    throw translateGhlError(err, { verb: 'create' });
  }
}

/**
 * DELETE /opportunities/{id}
 *
 * Nothing is written locally: OpportunityDelete fires and stageHistoryWriter
 * closes the open stage_history row as well as marking the opportunity. Doing
 * it here would leave that row open forever, which silently inflates every
 * "days in stage" figure that deal contributes to.
 */
export async function deleteGhlOpportunity(install, opportunityId) {
  if (!opportunityId) throw new OpportunityWriteError('Which deal?', { status: 400 });

  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/opportunities/${enc(opportunityId)}`
    });
  } catch (err) {
    throw translateGhlError(err, { opportunityId, verb: 'delete', install });
  }

  logger.info({ opportunityId }, 'ghlOpportunityWrite: deal deleted');
  return true;
}

/**
 * POST /opportunities/{id}/followers
 *
 * Additive, like contact tags: only the ids given are added, so this cannot
 * remove a follower it was not told about.
 */
export async function addGhlOpportunityFollowers(install, opportunityId, input) {
  if (!opportunityId) throw new OpportunityWriteError('Which deal?', { status: 400 });
  const followers = buildFollowerList(input, { verb: 'add' });

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: `/opportunities/${enc(opportunityId)}/followers`,
      data: { followers }
    });
    logger.info(
      { opportunityId, requested: followers, added: data?.followersAdded },
      'ghlOpportunityWrite: followers added'
    );
    return { followers: data?.followers || [], followersAdded: data?.followersAdded || [] };
  } catch (err) {
    throw translateGhlError(err, { opportunityId, verb: 'update', install });
  }
}

/**
 * DELETE /opportunities/{id}/followers
 *
 * Removes only the ids given. `isRemoveAllFollowers` exists on their API and is
 * deliberately NOT exposed — "remove everyone" from a per-deal screen is a
 * click away from a change nobody can undo, and removing them by name is one
 * extra call.
 */
export async function removeGhlOpportunityFollowers(install, opportunityId, input) {
  if (!opportunityId) throw new OpportunityWriteError('Which deal?', { status: 400 });
  const followers = buildFollowerList(input, { verb: 'remove' });

  try {
    const { data } = await ghlRequest(install, {
      method: 'DELETE',
      url: `/opportunities/${enc(opportunityId)}/followers`,
      data: { followers }
    });
    logger.info(
      { opportunityId, requested: followers, removed: data?.followersRemoved },
      'ghlOpportunityWrite: followers removed'
    );
    return {
      followers: data?.followers || [],
      followersRemoved: data?.followersRemoved || []
    };
  } catch (err) {
    throw translateGhlError(err, { opportunityId, verb: 'update', install });
  }
}

/**
 * GET /opportunities/lost-reason
 *
 * The location's lost-reason list, for the picker shown when a deal is marked
 * lost. Read-only: create/update/delete on lost reasons are not OAuth-exposed.
 */
export async function fetchGhlLostReasons(install) {
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: '/opportunities/lost-reason',
      params: { locationId: install.location_id, limit: 100 }
    });
    const rows = data?.lostReasons || data?.data || [];
    return rows
      .map((r) => ({ id: r.id || r._id, label: r.name || r.label }))
      .filter((r) => r.id && r.label);
  } catch (err) {
    // A missing list is not a failed edit — the caller falls back to marking
    // the deal lost without a reason.
    logger.warn(
      { err, status: err.response?.status },
      'ghlOpportunityWrite: could not fetch lost reasons'
    );
    return [];
  }
}
