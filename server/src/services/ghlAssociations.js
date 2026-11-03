// ghlAssociations.js — attach and detach notes/tasks to opportunities and
// businesses.
//
// WHAT AN "ASSOCIATION" IS IN GHL. Two different things share the word, and
// conflating them is the trap:
//
//   an ASSOCIATION is a fixed, system-defined SCHEMA — "tasks can link to
//     opportunities". You never create one. They exist as constants whose id
//     and key are the same literal string, e.g. TASK_OPPORTUNITY_ASSOCIATION.
//
//   a RELATION is one actual link between two records. That is what we create.
//
// So there is no discovery step and no id to store. The ids below are the ids.
//
// WHY THEY ARE HARDCODED RATHER THAN LOOKED UP. Every TASK_*, NOTE_* and
// BUSINESSES_OPPORTUNITIES_* association is on GHL's INTERNAL_ASSOCIATIONS
// list, and their service filters that list out of GET /associations and
// GET /associations/objectKey/:objectKey. Listing will never return them.
// GET /associations/key/:name does resolve them (it reads the constant map
// before touching its database), but that call can only ever return the string
// we already passed in, so it is a round trip for nothing.
//
// This is the "derive vs look up" rule applied in the other direction: the
// knowledge is fixed, so pin it in one place with the constraints written down.

import { ghlRequest } from './ghlClient.js';
import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';
import {
  ASSOCIATIONS, NOTE_OBJECT_KEYS, AssociationError, relationId,
  translateOAuthChannelBlock
} from './associationConstants.js';

// Re-exported so callers have one import for the whole feature.
export { ASSOCIATIONS, NOTE_OBJECT_KEYS, AssociationError };

// The /notes/:id family is v3, unlike most of the API. Not the app-wide
// 2021-07-28 that ghlClient sends by default.
const NOTE_API_VERSION = 'v3';

// ── TASK RELATIONS ARE NOT WRITABLE OVER OAUTH ───────────────────────────
//
// Confirmed at source level, not inferred from an error message. GHL's
// tasks.service.ts rejects any task write carrying `relations` when the
// request arrives on the OAuth channel:
//
//   const isOAuthChannel = request.channel === Channel.OAUTH
//   if (isOAuthChannel && 'relations' in body) {
//     throw new BadRequestException('Relations cannot be modified via OAuth channel')
//   }
//
// That check sits in the task service, so EVERY route into it is closed —
// POST /associations/relations (which calls tasksService.update internally),
// /associations/relations/bulk, PUT /locations/:id/tasks/:id with relations,
// and task create with relations. There is no fourth surface to try.
//
// WHAT STILL WORKS FOR TASKS:
//   read  — GET /locations/:locationId/tasks/:taskId returns `relations`
//   write — the CONTACT link only, as a plain field:
//           PUT /locations/:locationId/tasks/:taskId  { contactId }
//           (scope: locations/tasks.write)
//
// So task → opportunity and task → business links cannot be created or
// removed by this app at all. Not a scope, not a version, not a retry: it
// needs a platform change at GHL. The read path is unaffected, so the deals a
// task is linked to still display correctly — taskWriter mirrors them out of
// the task payload into task_relations.
//
// NOTES ARE DIFFERENT and deliberately so: they have a purpose-built endpoint
// (PUT /notes/:id/relations) that is NOT subject to this check. Note relation
// writes fail today only for want of the `notes.write` scope, which is a
// fixable configuration problem. Do not collapse the two cases — one is
// waiting on a scope, the other on GHL.

// ── Notes ────────────────────────────────────────────────────────────────
//
// Notes get a PURPOSE-BUILT endpoint and we use it over the generic relations
// API. PUT /notes/{id}/relations validates the object keys, verifies the target
// records exist, and re-syncs the note's attachments in the same call — three
// things the generic endpoint does not do.
//
// TWO BEHAVIOURS THAT WILL BITE IF NOT PLANNED FOR:
//
//   1. A note cannot be orphaned. If a `remove` would leave the note with zero
//      relations and it has no contactId, GHL returns
//      400 "Note must have at least one relation". So detaching the last
//      relation is not a supported operation — the caller must keep the contact
//      link, which our notes always have.
//
//   2. The opportunity cap is 1, so `add` on a note that already has a
//      different opportunity REPLACES it rather than failing. That is the
//      behaviour we want (a note is about one deal) but it means "add" is
//      really "set", and the previous link is gone.
//
// `type` is an enum of exactly add | remove, and `relations` needs at least one
// entry.
async function putNoteRelations(install, noteId, type, relations) {
  if (!noteId) {
    throw new AssociationError('A note id is required', { field: 'noteId' });
  }
  if (!Array.isArray(relations) || relations.length === 0) {
    throw new AssociationError('At least one relation is required', { field: 'relations' });
  }
  for (const r of relations) {
    if (!NOTE_OBJECT_KEYS.has(r?.objectKey)) {
      throw new AssociationError(
        `A note can only link to ${[...NOTE_OBJECT_KEYS].join(', ')}`,
        { field: 'objectKey' }
      );
    }
    if (!r?.recordId || typeof r.recordId !== 'string') {
      throw new AssociationError('Each relation needs a recordId', { field: 'recordId' });
    }
  }

  const params = new URLSearchParams({ locationId: install.location_id });
  const { data } = await ghlRequest(install, {
    method: 'PUT',
    url: `/notes/${encodeURIComponent(noteId)}/relations?${params.toString()}`,
    // PINNED TO v3. ghlClient sends `Version: 2021-07-28` on every request,
    // and the /notes/:id family is v3. A v3 path called with the v1 header is
    // rejected as 401 "The token is not authorized for this scope." — which
    // reads exactly like a dead token and is not one. This is the same trap
    // that halted a sub-account when /notes/:id was called with the v1
    // header; see the note in noteWriter.js.
    headers: { Version: NOTE_API_VERSION },
    // SCOPE-OPTIONAL — the important half.
    //
    // Without this, the 401 above marked the install reauth_required, which
    // halts EVERY sync for the location: a failed deal-link on one note took
    // down conversation, call-recording and opportunity sync with it. A 401
    // from one endpoint proves that endpoint is unavailable, not that the
    // token is dead — a dead token 401s everything.
    scopeOptional: true,
    data: { type, relations }
  });
  const note = data?.note || null;
  logger.info(
    {
      noteId, type,
      relations: relations.map((r) => `${r.objectKey}:${r.recordId}`),
      // Present when the cap-1 opportunity link replaced an existing one.
      // Logged because it is a silent deletion from the caller's point of view.
      overridden: data?.overRiddenRelations || undefined
    },
    'ghlAssociations: note relations updated'
  );
  return note;
}

/**
 * Attach an opportunity and/or a business to an existing note.
 *
 * Both are optional; passing neither is a no-op rather than an error, so a
 * caller can pass whatever the user selected without branching.
 *
 * Returns the updated note, or null when there was nothing to do.
 */
export async function setNoteRelations(install, noteId, { opportunityId, businessId } = {}) {
  const relations = [];
  if (opportunityId) relations.push({ objectKey: 'opportunity', recordId: opportunityId });
  if (businessId) relations.push({ objectKey: 'business', recordId: businessId });
  if (relations.length === 0) return null;
  return putNoteRelations(install, noteId, 'add', relations);
}

/**
 * Detach an opportunity and/or a business from a note.
 *
 * The contact link is never touched — see the orphaning rule above. A note
 * created through our app always has one, so removing the deal or company link
 * leaves a valid note rather than a 400.
 */
export async function removeNoteRelations(install, noteId, { opportunityId, businessId } = {}) {
  const relations = [];
  if (opportunityId) relations.push({ objectKey: 'opportunity', recordId: opportunityId });
  if (businessId) relations.push({ objectKey: 'business', recordId: businessId });
  if (relations.length === 0) return null;
  return putNoteRelations(install, noteId, 'remove', relations);
}

// ── Tasks ────────────────────────────────────────────────────────────────
//
// Tasks have no dedicated relations endpoint, so these go through the generic
// POST /associations/relations.
//
// ORIENTATION IS NOT SYMMETRIC. firstRecordId must be the record whose object
// key is the association's firstObjectKey. For task↔opportunity that means
// firstRecordId is the TASK id and secondRecordId the opportunity — never the
// reverse. Passing them the other way round does not error usefully, it creates
// a link GHL reads as "an opportunity associated with a task-shaped record".
//
// The response id is SYNTHETIC: `${taskId}-${relatedRecordId}`, not a Mongo
// ObjectId, because a task relation is pushed onto the task document rather
// than stored as its own row. That is why associationId is REQUIRED on delete —
// their handler splits the composite id and derives the object key from the
// association.


// "The deal on a task", from the association's own object keys. ASSOCIATIONS
// entries carry no display name, and inventing one per entry would be a second
// place to keep in step with the first.
const OBJECT_WORDS = {
  task: 'task', note: 'note', opportunity: 'deal',
  business: 'company', contact: 'contact'
};
// NOTE: deal↔contact is NOT affected by the task block. It is a real Mongo
// relation and does not route through tasksService, so createRelation and
// deleteRelation still work for OPPORTUNITIES_CONTACTS. The translation below
// is defensive — it fires only on GHL's specific "via OAuth channel" message,
// so a working path is untouched.
function describeAssoc(assoc) {
  const subject = OBJECT_WORDS[assoc?.firstObjectKey] || assoc?.firstObjectKey;
  const target = OBJECT_WORDS[assoc?.secondObjectKey] || assoc?.secondObjectKey;
  if (!subject || !target) return 'That link';
  return `The ${target} on a ${subject}`;
}

async function createRelation(install, assoc, firstRecordId, secondRecordId, opts = {}) {
  if (!firstRecordId || !secondRecordId) {
    throw new AssociationError('Both record ids are required', { field: 'recordId' });
  }
  const params = new URLSearchParams();
  // If the task belongs to a recurring series, apply the same relation to the
  // template so future occurrences inherit it. Off by default: a rep linking
  // today's task to a deal has not necessarily decided that every future
  // occurrence belongs to it.
  if (opts.updateFutureTasks) params.set('updateFutureTasks', 'true');
  const qs = params.toString();

  let data;
  try {
    ({ data } = await ghlRequest(install, {
    method: 'POST',
    url: `/associations/relations${qs ? `?${qs}` : ''}`,
    // Scope-optional for blast radius, not because we expect a 401: a failed
    // task-to-deal link must not halt every sync for the location. See the
    // note on putNoteRelations.
    scopeOptional: true,
    data: {
      locationId: install.location_id,
      associationId: assoc.id,
      firstRecordId,
      secondRecordId,
      // OPPORTUNITY↔CONTACT NEEDS THE PIPELINE.
      //
      // GHL validates this association against the opportunity's pipeline and
      // rejects the write without it:
      //   "Pipeline ID is required for opportunity contact association"
      // A rep adding a second person to a deal saw that message verbatim.
      //
      // Only sent when the caller supplies one — a task or note relation has
      // no pipeline, and an undefined key here would be sent as null and
      // rejected in the other direction.
      ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {})
    }
    }));
  } catch (err) {
    // GHL closes /associations/relations to marketplace apps
    // (restrictOAuthChannel). Left raw this surfaced as a 500 internal_error.
    const oauthBlocked = translateOAuthChannelBlock(err, describeAssoc(assoc));
    if (oauthBlocked !== err) throw oauthBlocked;
    // translateOAuthChannelBlock only recognises ONE specific 400 shape and
    // returns anything else untouched — so a different rejection (already
    // linked, a validation error, a missing scope) fell straight through as
    // the raw axios error, which is neither an AssociationError nor an
    // OpportunityWriteError. sendDealError (routes/deals.js) only translates
    // those two types, so this reached the client as a bare 500
    // internal_error with no field and no explanation — exactly the failure
    // mode the OAuth-block translation above was already built to avoid, just
    // for every OTHER kind of GHL rejection instead of that one.
    throw translateRelationError(err, describeAssoc(assoc));
  }
  logger.info(
    { associationId: assoc.id, firstRecordId, secondRecordId, id: data?.id },
    'ghlAssociations: relation created'
  );
  return data || null;
}

// General-purpose fallback for createRelation's catch — same shape as
// ghlContactWrite.js's translateContactError / ghlOpportunityWrite.js's
// error handling: GHL's own detail is logged (it often names the actual
// problem, e.g. "Contact is already associated with this opportunity"), the
// rep sees a sanitised-but-informative message keyed off the status.
// Exported for testing only — see __tests__/relationErrorTranslation.test.mjs.
// Not part of the module's real public surface (nothing outside this file
// should call it directly; go through createRelation/deleteRelation/
// removeDealContact instead), but it's pure and dependency-free, so it can
// be checked in isolation the same way translateOAuthChannelBlock is.
export function translateRelationError(err, what) {
  const status = err.response?.status;
  const body = err.response?.data;
  const detail = body?.message || body?.error
    || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);

  if (status === 401 || status === 403) {
    return new AssociationError(
      'This app cannot make that change yet — reauthorise it in your CRM.',
      { status: 403 }
    );
  }
  if (status === 404) {
    return new AssociationError(`${what} could not be found — it may have been removed`, { status: 404 });
  }
  if (status === 400 || status === 422) {
    logger.warn({ status, detail, body }, 'ghlAssociations: relation rejected by the CRM');
    const already = /already/i.test(detail || '');
    return new AssociationError(
      already
        ? `${what} is already linked`
        : `Your CRM would not allow that — ${detail || 'check the values and try again'}`,
      { status: already ? 409 : 422 }
    );
  }
  logger.error({ err, status, detail, body }, 'ghlAssociations: relation create failed');
  return new AssociationError('Could not save that link — try again', { status: 502 });
}

async function deleteRelation(install, assoc, firstRecordId, secondRecordId) {
  if (!firstRecordId || !secondRecordId) {
    throw new AssociationError('Both record ids are required', { field: 'recordId' });
  }
  const id = relationId(firstRecordId, secondRecordId);
  const params = new URLSearchParams({
    locationId: install.location_id,
    // Required, not optional: the composite id above is not an ObjectId, so
    // their handler needs the association to know what it is looking at.
    associationId: assoc.id
  });
  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/associations/relations/${encodeURIComponent(id)}?${params.toString()}`,
      scopeOptional: true
    });
  } catch (err) {
    // Same two-layer translation as createRelation above — see its comment
    // for why relying on translateOAuthChannelBlock alone left every OTHER
    // kind of rejection here as a raw, untranslated 500 internal_error too.
    const oauthBlocked = translateOAuthChannelBlock(err, describeAssoc(assoc));
    if (oauthBlocked !== err) throw oauthBlocked;
    throw translateRelationError(err, describeAssoc(assoc));
  }
  logger.info(
    { associationId: assoc.id, relationId: id },
    'ghlAssociations: relation deleted'
  );
  return true;
}

/**
 * Attach an opportunity and/or a business to a task.
 *
 * Sequential rather than parallel: both writes touch the same task document
 * (task relations live on the document, not in a relations collection), so
 * firing them together risks one overwriting the other's relations array.
 */
export async function setTaskRelations(
  install, taskId, { opportunityId, businessId, updateFutureTasks = false } = {}
) {
  const out = {};
  if (opportunityId) {
    out.opportunity = await createRelation(
      install, ASSOCIATIONS.TASK_OPPORTUNITY, taskId, opportunityId, { updateFutureTasks }
    );
  }
  if (businessId) {
    out.business = await createRelation(
      install, ASSOCIATIONS.TASK_BUSINESS, taskId, businessId, { updateFutureTasks }
    );
  }
  return Object.keys(out).length ? out : null;
}

/** Detach an opportunity and/or a business from a task. */
export async function removeTaskRelations(
  install, taskId, { opportunityId, businessId } = {}
) {
  if (opportunityId) {
    await deleteRelation(install, ASSOCIATIONS.TASK_OPPORTUNITY, taskId, opportunityId);
  }
  if (businessId) {
    await deleteRelation(install, ASSOCIATIONS.TASK_BUSINESS, taskId, businessId);
  }
  return true;
}


// ── Target validation ────────────────────────────────────────────────────
//
// Check that the opportunity and business a caller wants to link actually exist
// in THIS location before calling GHL.
//
// GHL validates them too, but its error does not say which of the two ids was
// wrong, so the UI cannot mark the offending control. One local query buys a
// message that names the field.
//
// BUSINESSES ARE CHECKED LENIENTLY, and this is the important asymmetry:
// businesses sync on a daily cron with NO webhooks, so a company created in GHL
// this morning is genuinely absent from our table until tonight. Rejecting that
// link would block a legitimate action for up to a day. So a missing business
// is a warning, not an error — GHL is the authority and will reject a truly
// bogus id.
//
// Opportunities have full webhook coverage, so a missing one really is missing
// and is rejected.
export async function assertRelationTargets(
  locationId, { opportunityId, businessId } = {}
) {
  if (!opportunityId && !businessId) return;

  await withTenant(locationId, async (client) => {
    if (opportunityId) {
      const { rows } = await client.query(
        `SELECT 1 FROM opportunities
          WHERE location_id = $1 AND opportunity_id = $2
            AND is_deleted = false AND deleted_at IS NULL
          LIMIT 1`,
        [locationId, opportunityId]
      );
      if (rows.length === 0) {
        throw new AssociationError('That deal no longer exists', {
          status: 404, field: 'opportunityId'
        });
      }
    }
    if (businessId) {
      const { rows } = await client.query(
        `SELECT 1 FROM businesses
          WHERE location_id = $1 AND business_id = $2
            AND deleted_at IS NULL
          LIMIT 1`,
        [locationId, businessId]
      );
      if (rows.length === 0) {
        logger.warn(
          { locationId, businessId },
          'ghlAssociations: business not in our table yet — businesses sync daily, letting GHL decide'
        );
      }
    }
  });
}

// ── Deal ↔ contact ───────────────────────────────────────────────────────
//
// "Add someone to this deal". The People rail had an input for this that
// searched nothing and saved nothing — it typed into local state and printed
// "Add-contact search wires up next".
//
// Goes through the generic relations endpoint, like task relations, with the
// opportunity FIRST (see the orientation note on ASSOCIATIONS). Our
// opportunity_contacts table is keyed on GHL's relation_id and populated by
// the RelationCreate webhook, so nothing is written locally — the webhook
// does that, exactly as it does for a link made in GHL.

/**
 * Link a contact to a deal.
 *
 * `pipelineId` is the DEAL's own pipeline, and GHL requires it on this
 * association specifically — see the note in createRelation. The caller has
 * it already (resolveDealForWrite selects pipeline_id), so it is passed in
 * rather than re-read here.
 */
export async function addDealContact(install, opportunityId, contactId, pipelineId = null) {
  if (!opportunityId || !contactId) {
    throw new AssociationError('A deal and a contact are both required', {
      field: !opportunityId ? 'opportunityId' : 'contactId'
    });
  }
  return createRelation(
    install, ASSOCIATIONS.OPPORTUNITY_CONTACT, opportunityId, contactId,
    { pipelineId }
  );
}

/**
 * Unlink a contact from a deal.
 *
 * Takes GHL's own relation_id rather than deriving one. The composite
 * `${first}-${second}` form works for TASK and NOTE relations because those
 * live on the parent document, but an opportunity↔contact relation is a real
 * row with a Mongo ObjectId — which is why opportunity_contacts is keyed on
 * relation_id. Guessing the id here would delete nothing and report success.
 */
export async function removeDealContact(install, relationId) {
  if (!relationId) {
    throw new AssociationError('A relation id is required to unlink', {
      field: 'relationId'
    });
  }
  const params = new URLSearchParams({ locationId: install.location_id });
  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/associations/relations/${encodeURIComponent(relationId)}?${params.toString()}`,
      scopeOptional: true
    });
  } catch (err) {
    const oauthBlocked = translateOAuthChannelBlock(err, 'The people on a deal');
    if (oauthBlocked !== err) throw oauthBlocked;
    throw translateRelationError(err, 'The people on a deal');
  }
  logger.info(
    { relationId, associationId: ASSOCIATIONS.OPPORTUNITY_CONTACT.id },
    'ghlAssociations: deal contact unlinked'
  );
  return true;
}
