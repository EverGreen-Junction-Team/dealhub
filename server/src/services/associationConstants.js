// associationConstants.js — GHL's fixed association definitions and the pure
// helpers that depend on nothing.
//
// SPLIT OUT OF ghlAssociations.js so it can be unit tested. That module imports
// ghlClient and db, which import config, which throws without DATABASE_URL — so
// a test importing it needs a database to assert a string constant. Every other
// *Patch.js module in this codebase is dependency-free for the same reason.
//
// WHAT AN "ASSOCIATION" IS IN GHL. Two different things share the word:
//
//   an ASSOCIATION is a fixed, system-defined SCHEMA — "tasks can link to
//     opportunities". You never create one. They exist as constants whose id
//     and key are the same literal string, e.g. TASK_OPPORTUNITY_ASSOCIATION.
//
//   a RELATION is one actual link between two records. That is what we create.
//
// So there is no discovery step and no id to store. The ids below are the ids.
//
// WHY HARDCODED RATHER THAN LOOKED UP. Every TASK_*, NOTE_* and
// BUSINESSES_OPPORTUNITIES_* association is on GHL's INTERNAL_ASSOCIATIONS
// list, and their service filters that list out of GET /associations and
// GET /associations/objectKey/:objectKey. Listing will never return them.
// GET /associations/key/:name does resolve them, but can only ever return the
// string we already passed in — a round trip for nothing.

// The associations we use, with the constraints that decide how we call them.
//
// `cap` is GHL's limit on how many SECOND records one FIRST record may hold.
// It is the field that changes behaviour, not documentation: a cap of 1 means
// adding a second one REPLACES the first silently rather than erroring, so a
// note's opportunity link is a set-not-append operation while a task's is a
// genuine append.
export const ASSOCIATIONS = {
  TASK_OPPORTUNITY: {
    id: 'TASK_OPPORTUNITY_ASSOCIATION',
    firstObjectKey: 'task',
    secondObjectKey: 'opportunity',
    cap: 10
  },
  TASK_BUSINESS: {
    id: 'TASK_BUSINESS_ASSOCIATION',
    firstObjectKey: 'task',
    secondObjectKey: 'business',
    cap: 10
  },
  NOTE_OPPORTUNITY: {
    id: 'NOTE_OPPORTUNITY_ASSOCIATION',
    firstObjectKey: 'note',
    secondObjectKey: 'opportunity',
    // ONE. Adding a second opportunity silently replaces the first, which
    // comes back in the response as overRiddenRelations.
    cap: 1
  },
  NOTE_BUSINESS: {
    id: 'NOTE_BUSINESS_ASSOCIATION',
    firstObjectKey: 'note',
    secondObjectKey: 'business',
    cap: 1000
  },
  // Adding a person to a deal. Unlike the four above this one is NOT on GHL's
  // internal list — it is returned by GET /associations — but it is kept here
  // so every association this app writes is declared in one place.
  //
  // Orientation: opportunity FIRST. firstRecordId is the deal, secondRecordId
  // the contact. The reverse creates a link GHL reads as a contact with an
  // opportunity-shaped record attached.
  //
  // A deal holds up to 25 contacts; a contact can be on up to 1000 deals.
  OPPORTUNITY_CONTACT: {
    id: 'OPPORTUNITIES_CONTACTS_ASSOCIATION',
    firstObjectKey: 'opportunity',
    secondObjectKey: 'contact',
    cap: 25
  }
};

// The object keys GHL's notes endpoints accept. A key outside this set is
// rejected by their validator, so it is worth failing locally with a message
// that names the allowed values.
export const NOTE_OBJECT_KEYS = new Set(['contact', 'opportunity', 'business', 'appointment']);

export class AssociationError extends Error {
  // `reason` is a machine-readable code for the cases a message alone cannot
  // convey — currently 'oauth_channel_blocked', which no scope or retry fixes.
  constructor(message, { status = 400, field = null, reason = null } = {}) {
    super(message);
    this.name = 'AssociationError';
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Translate GHL's restrictOAuthChannel refusal into something actionable.
 *
 *   POST /associations/relations
 *     → 400 {"message":"Relations cannot be modified via OAuth channel"}
 *
 * This is a DELIBERATE platform restriction on marketplace apps, not a
 * misconfiguration: the generic relations API is closed to the OAuth channel
 * the same way note restore is. No scope grants it, a retry never succeeds,
 * and a reinstall changes nothing.
 *
 * Worth translating rather than letting it fall through: the raw error reached
 * the client as a 500 `internal_error`, which reads as a bug in this app and
 * sends whoever is debugging it looking for one. Returns the original error
 * untouched when it is anything else.
 */
export function translateOAuthChannelBlock(err, what) {
  const body = err?.response?.data;
  const message = typeof body?.message === 'string' ? body.message : '';
  if (err?.response?.status !== 400 || !/via OAuth channel/i.test(message)) return err;
  // 409, not 501.
  //
  // 501 was the more literal reading — the upstream will never implement this
  // — but any 5xx makes pino-http attach a synthetic stack trace and log the
  // line as a request failure. That is not configurable: it keys off
  // `statusCode >= 500` independently of customLogLevel. A deliberate,
  // correct refusal was therefore indistinguishable from a crash in the log
  // stream, which is exactly the confusion this translation exists to remove.
  //
  // 409 says "the request is fine, the current state will not permit it",
  // which is what this is, and is already what the app returns for a
  // disconnected sub-account. `reason` carries the specific cause.
  return new AssociationError(
    `${what} cannot be changed from this app — your CRM does not allow it over `
    + 'the marketplace connection. It has to be done in the CRM itself.',
    { status: 409, reason: 'oauth_channel_blocked' }
  );
}


// The relation id GHL synthesises for a task relation: `${first}-${second}`,
// NOT a Mongo ObjectId, because a task relation is pushed onto the task
// document rather than stored as its own row.
//
// Their DELETE handler SPLITS this string and derives the object key from the
// associationId, which is why associationId is required on delete and why the
// order here is a contract rather than a convenience.
export function relationId(firstRecordId, secondRecordId) {
  return `${firstRecordId}-${secondRecordId}`;
}
