// opportunityPatch.js — validate and map a deal edit for GHL's opportunity
// endpoints.
//
// Dependency-free, like contactPatch / taskPatch / notePatch / tagPatch /
// businessPatch: no config, no database, no network, so the mapping can be unit
// tested directly. This is where silent data loss would live.
//
// Endpoints (API version 2021-04-15):
//   PUT  /opportunities/{id}          — the general edit
//   PUT  /opportunities/{id}/status   — status on its own, and the ONLY way to
//                                       attach a lost reason
//   POST /opportunities/              — create
//   DELETE /opportunities/{id}
//
// Scope is opportunities.write. Pipelines are a SEPARATE scope family
// (pipelines.write / pipelines.create) and are deliberately not wired — see
// the note at the bottom of this file.

// Fields the update endpoint accepts, mapped from our own names where they
// differ. Anything not listed is dropped rather than passed through: an unknown
// key makes GHL reject the whole request, so one typo would lose the valid
// fields alongside it.
const WRITABLE = new Map([
  ['name', 'name'],
  ['status', 'status'],
  ['pipelineStageId', 'pipelineStageId'],
  ['pipelineId', 'pipelineId'],
  ['monetaryValue', 'monetaryValue'],
  ['assignedTo', 'assignedTo'],
  ['forecastExpectedCloseDate', 'forecastExpectedCloseDate'],
  ['forecastProbability', 'forecastProbability'],
  ['customFields', 'customFields'],
  // Our UI's names for the same things. Accepted so a client using either works
  // — `value` and `stage` are what the deal card calls them.
  ['value', 'monetaryValue'],
  ['expectedCloseDate', 'forecastExpectedCloseDate'],
  ['owner', 'assignedTo']
]);

// GHL's enum. `all` appears in their docs for create/update but is a SEARCH
// filter only — sending it on a write is rejected.
export const STATUSES = ['open', 'won', 'lost', 'abandoned'];

// locationId is required on CREATE and rejected on UPDATE; the caller supplies
// it from the session, never the client. Named so it is dropped quietly rather
// than 422-ing an edit made from a whole record.
//
// contactId is NO LONGER here — see PRIMARY_CONTACT below.
const CALLER_OWNED = new Set(['locationId', 'id', 'lostReasonId']);

// Changing which contact a deal belongs to.
//
// contactId is marked @HideApiProperty on PUT /opportunities/:id, so it does
// not appear in the marketplace docs — but the service still applies it:
//
//     if (body.contactId) opportunity.contactId = body.contactId
//
// It validates the contact exists and is not deleted, then updates; an
// invalid id returns 400. On CREATE it is required and fully documented.
//
// WHY IT IS SEPARATED FROM THE ORDINARY FIELD MAP. Reassigning a deal's
// primary contact is not the same kind of edit as renaming it: it is
// undocumented on this verb, so it can be withdrawn without notice, and it
// changes which contact GHL files future notes and tasks against. Keeping it
// out of FIELD_MAP means it can only be set by a caller that means to, never
// swept in from a whole-record PATCH.
const PRIMARY_CONTACT = 'contactId';

export class OpportunityWriteError extends Error {
  // `reason` is a machine-readable code for cases the message alone cannot
  // convey — 'reauth_required' vs 'not_installed' need different fixes and
  // used to share one message. Null for ordinary validation errors.
  constructor(message, { status = 400, field = null, reason = null } = {}) {
    super(message);
    this.name = 'OpportunityWriteError';
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * GHL normalises forecastExpectedCloseDate to a DATE ONLY (YYYY-MM-DD).
 *
 * Sending a full timestamp is accepted and then truncated, which means the
 * value we echo back can differ from the one we sent — so normalise here and
 * store what they will actually keep.
 */
export function toForecastDate(value, { field = 'forecastExpectedCloseDate' } = {}) {
  if (value === null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new OpportunityWriteError('That close date is not a valid date', { field });
    }
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') {
    throw new OpportunityWriteError('Close date must be a date', { field });
  }

  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // Guard JS's silent rollover: new Date('2026-02-31') is 3 March.
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(raw)) {
      throw new OpportunityWriteError('That close date is not a valid date', { field });
    }
    return raw;
  }

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new OpportunityWriteError(
      'Close date must be a date like 2026-04-23', { field }
    );
  }
  return d.toISOString().slice(0, 10);
}

/**
 * monetaryValue is a number to GHL.
 *
 * Our UI shows "£26,000" and a rep may type it back that way, so strip the
 * formatting rather than rejecting it — but reject anything genuinely
 * ambiguous instead of guessing.
 */
export function toMonetaryValue(value, { field = 'monetaryValue' } = {}) {
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OpportunityWriteError('That value is not a number', { field });
    }
    if (value < 0) {
      throw new OpportunityWriteError('A deal value cannot be negative', { field });
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new OpportunityWriteError('Value must be a number', { field });
  }

  // Currency symbols, thousands separators and spaces come off; anything else
  // left over means it was not a number.
  const cleaned = value.trim().replace(/[£$€,\s]/g, '');
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new OpportunityWriteError(
      'Value must be a number, like 26000', { field }
    );
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new OpportunityWriteError('That value is not a number', { field });
  }
  if (n < 0) {
    throw new OpportunityWriteError('A deal value cannot be negative', { field });
  }
  return n;
}

/**
 * Validate and normalise a deal patch before it reaches GHL.
 *
 * @param {object} input
 * @param {object} opts
 * @param {boolean} opts.create true for POST — name, status and pipelineId
 *   become required (contactId and locationId are the caller's to supply)
 * @returns {{ patch: object, dropped: string[] }}
 */
export function buildOpportunityPatch(input = {}, { create = false, allowPrimaryContact = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new OpportunityWriteError('Nothing to save', { status: 400 });
  }

  const patch = {};
  const dropped = [];

  for (const [key, value] of Object.entries(input)) {
    // The primary contact, opt-in only. On CREATE it is required and
    // documented; on UPDATE it is hidden but applied. Either way a caller has
    // to ask for it — see PRIMARY_CONTACT — so a whole-record PATCH from the
    // deal editor cannot silently reassign a deal to a different person.
    if (key === PRIMARY_CONTACT) {
      if (!create && !allowPrimaryContact) {
        dropped.push(key);
        continue;
      }
      if (value === undefined) continue;
      const id = typeof value === 'string' ? value.trim() : '';
      if (!id) {
        // Not nullable: an opportunity without a contact cannot hold notes or
        // tasks, and GHL rejects the write anyway.
        throw new OpportunityWriteError(
          'A deal must have a contact — pick one rather than clearing it',
          { status: 400, field: 'contactId' }
        );
      }
      patch.contactId = id;
      continue;
    }
    if (CALLER_OWNED.has(key)) {
      dropped.push(key);
      continue;
    }
    if (!WRITABLE.has(key)) {
      dropped.push(key);
      continue;
    }
    if (value === undefined) continue;

    const target = WRITABLE.get(key);

    if (target === 'monetaryValue') {
      patch.monetaryValue = toMonetaryValue(value);
      continue;
    }
    if (target === 'forecastExpectedCloseDate') {
      patch.forecastExpectedCloseDate = toForecastDate(value);
      continue;
    }
    if (target === 'forecastProbability') {
      if (value === null) { patch.forecastProbability = null; continue; }
      const n = typeof value === 'string' ? Number(value.trim()) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new OpportunityWriteError(
          'Probability must be a number', { field: 'forecastProbability' }
        );
      }
      if (n < 0 || n > 100) {
        throw new OpportunityWriteError(
          'Probability must be between 0 and 100', { field: 'forecastProbability' }
        );
      }
      patch.forecastProbability = n;
      continue;
    }
    if (target === 'status') {
      if (typeof value !== 'string' || !STATUSES.includes(value.trim().toLowerCase())) {
        throw new OpportunityWriteError(
          `Status must be one of: ${STATUSES.join(', ')}`, { field: 'status' }
        );
      }
      patch.status = value.trim().toLowerCase();
      continue;
    }
    if (target === 'customFields') {
      if (!Array.isArray(value)) {
        throw new OpportunityWriteError(
          'Custom fields must be a list', { field: 'customFields' }
        );
      }
      // OPPORTUNITIES USE camelCase `fieldValue`.
      //
      // Contacts use field_value (snake). Same concept, two objects, two
      // spellings — and GHL accepts the wrong one on the request and then
      // SILENTLY IGNORES it, so the wrong spelling gives a successful save
      // and an unchanged field. Nothing tells the rep.
      //
      // The comment here previously said field_value and the value was
      // passed through unreshaped, so whichever spelling a caller happened
      // to use went straight to the wire. Normalised now, so a caller may
      // send either and the correct one is always what GHL receives.
      patch.customFields = value.map((f, i) => {
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          throw new OpportunityWriteError(
            `Custom field ${i + 1} is not valid`, { field: 'customFields' }
          );
        }
        const id = typeof f.id === 'string' ? f.id.trim() : '';
        const key = typeof f.key === 'string' ? f.key.trim() : '';
        if (!id && !key) {
          throw new OpportunityWriteError(
            `Custom field ${i + 1} has no id`, { field: 'customFields' }
          );
        }
        const raw = f.fieldValue !== undefined ? f.fieldValue : f.field_value;
        return {
          ...(id ? { id } : { key }),
          // An empty string is a deliberate clear. Dropping the key would
          // leave the old value in place.
          fieldValue: raw === undefined || raw === null ? '' : raw
        };
      });
      continue;
    }

    // name, pipelineStageId, pipelineId, assignedTo — plain strings.
    if (value === null) {
      patch[target] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new OpportunityWriteError(`${key} must be text`, { field: key });
    }
    patch[target] = value.trim();
  }

  if (create) {
    if (!patch.name) {
      throw new OpportunityWriteError('A deal needs a name', { field: 'name' });
    }
    if (!patch.pipelineId) {
      throw new OpportunityWriteError('A deal needs a pipeline', { field: 'pipelineId' });
    }
    // Required by the API even though every deal this app creates starts open.
    if (!patch.status) patch.status = 'open';
  } else {
    if (Object.keys(patch).length === 0) {
      throw new OpportunityWriteError('Nothing to update', { status: 400 });
    }
    // GHL rejects an empty name, so an edit that blanks it would fail anyway.
    if ('name' in patch && !patch.name) {
      throw new OpportunityWriteError(
        'A deal needs a name — it cannot be cleared', { field: 'name' }
      );
    }
  }

  return { patch, dropped };
}

/**
 * Validate a status change for PUT /opportunities/{id}/status.
 *
 * Kept separate from the general patch because a lost reason can ONLY be
 * attached here — the update endpoint has no lostReasonId, so marking a deal
 * lost with a reason through the general edit silently drops the reason.
 */
export function buildStatusPatch({ status, lostReasonId } = {}) {
  if (typeof status !== 'string' || !STATUSES.includes(status.trim().toLowerCase())) {
    throw new OpportunityWriteError(
      `Status must be one of: ${STATUSES.join(', ')}`, { field: 'status' }
    );
  }
  const s = status.trim().toLowerCase();
  const body = { status: s };

  if (lostReasonId !== undefined && lostReasonId !== null && lostReasonId !== '') {
    if (typeof lostReasonId !== 'string') {
      throw new OpportunityWriteError(
        'Lost reason must be an id', { field: 'lostReasonId' }
      );
    }
    // A reason on a won deal is meaningless and GHL ignores it — refuse rather
    // than let a caller believe it was recorded.
    if (s !== 'lost') {
      throw new OpportunityWriteError(
        'A lost reason only applies when a deal is marked lost',
        { field: 'lostReasonId' }
      );
    }
    body.lostReasonId = lostReasonId.trim();
  }

  return body;
}

/**
 * Followers, for POST/DELETE /opportunities/{id}/followers.
 *
 * Max 10 per call, per GHL. Additive on both sides — like contact tags, and
 * unlike the general update, these cannot destroy a follower they were not
 * given.
 */
export function buildFollowerList(input, { verb = 'change' } = {}) {
  const raw = Array.isArray(input) ? input : input?.followers;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpportunityWriteError(
      `Which people do you want to ${verb}?`, { field: 'followers' }
    );
  }
  if (raw.length > 10) {
    throw new OpportunityWriteError(
      'At most 10 followers can be changed at once', { field: 'followers' }
    );
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new OpportunityWriteError(
        'Each follower must be a user id', { field: 'followers' }
      );
    }
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// PIPELINES ARE DELIBERATELY NOT WRITABLE HERE.
//
// They need their own scopes (pipelines.create / pipelines.write) which this
// app does not request, and the semantics are dangerous for a per-deal UI:
//
//   • PUT pipelines/{id} REPLACES the whole stages array. A stage sent without
//     its id is treated as new, and every opportunity in a stage that vanished
//     is moved to the lowest remaining one — silently, in bulk.
//   • DELETE is a HARD delete of the pipeline AND every opportunity in it.
//
// Both are location-wide changes triggered from a screen about one deal. If
// pipeline editing is ever wanted it belongs in the Control panel, with its own
// confirmation, not here.
