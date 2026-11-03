// businessContactRelationWriter.js — keeps contacts.business_id in step with
// GHL's BUSINESSES_CONTACTS_ASSOCIATION relation events.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────
//
// "Add business to deal" writes PATCH /contacts/:id { businessId } — the
// contact IS the deal's link to a business (migration 056). GHL accepted the
// write, the UI painted the business optimistically, and 2.5s later it
// vanished. The logs showed why: GHL fires NO ContactUpdate for a business
// link change. It models it as a relation swap instead —
//
//   RelationDelete  BUSINESSES_CONTACTS_ASSOCIATION  (old business ↔ contact)
//   RelationCreate  BUSINESSES_CONTACTS_ASSOCIATION  (new business ↔ contact)
//
// — and nothing handled those. opportunityContactWriter correctly rejects
// them (not an opp↔contact pair), the task/note writer only knows its own
// two associations, so both events were silently dropped. contacts.business_id
// has exactly two writers — the contact upsert (needs a ContactUpdate that
// never comes) and the daily sync — so the link was never recorded locally.
// The reconcile refetch found the old empty column and overwrote the paint.
//
// ── THE DELETE IS CONDITIONAL ────────────────────────────────────────
//
// GHL sends the delete and the create back-to-back, and nothing guarantees
// their order of arrival. A blind `SET business_id = NULL` on the delete
// would wipe the NEW link if the create happened to land first. So the
// delete only clears the column when it still points at the business being
// unlinked — if it already names the new one, the delete is stale and is
// left alone.
//
// Best-effort throughout: a relation is a link, and losing one must never
// fail the webhook that carried it.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const BUSINESS_CONTACT = 'BUSINESSES_CONTACTS_ASSOCIATION';

// Which end is which, BY OBJECT KEY. The associationId is checked too, but
// the keys are the authority — the same correction opportunityContactWriter
// carries, where an opaque associationId drifted away from the constant.
function pickBusinessContact(event) {
  const a = { key: event.firstObjectKey, id: event.firstRecordId };
  const b = { key: event.secondObjectKey, id: event.secondRecordId };
  if (a.key === 'business' && b.key === 'contact') return { businessId: a.id, contactId: b.id };
  if (b.key === 'business' && a.key === 'contact') return { businessId: b.id, contactId: a.id };
  return null;
}

/** A business was linked to a contact: record it on the contact. */
export async function handleBusinessContactRelationCreate(install, event) {
  const locationId = install.location_id;
  const pair = pickBusinessContact(event);
  if (!pair) return; // not ours — the router fans every relation to each writer

  try {
    const { rowCount } = await rawQuery(
      `UPDATE contacts
          SET business_id = $3
        WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL`,
      [locationId, pair.contactId, pair.businessId]
    );
    logger.info(
      { locationId, contactId: pair.contactId, businessId: pair.businessId, updated: rowCount },
      'businessContactRelation: contact ↔ business linked'
    );
  } catch (err) {
    logger.warn({ err, locationId, ...pair }, 'businessContactRelation: link write failed (non-fatal)');
  }
}

/** A business was unlinked from a contact: clear it — but only if it is
 *  still the one pointed at. See the header on why. */
export async function handleBusinessContactRelationDelete(install, event) {
  const locationId = install.location_id;
  const pair = pickBusinessContact(event);
  if (!pair) return;

  try {
    const { rowCount } = await rawQuery(
      `UPDATE contacts
          SET business_id = NULL
        WHERE location_id = $1 AND contact_id = $2
          AND business_id = $3
          AND deleted_at IS NULL`,
      [locationId, pair.contactId, pair.businessId]
    );
    logger.info(
      { locationId, contactId: pair.contactId, businessId: pair.businessId, cleared: rowCount },
      rowCount
        ? 'businessContactRelation: contact ↔ business unlinked'
        : 'businessContactRelation: stale unlink ignored — contact already points elsewhere'
    );
  } catch (err) {
    logger.warn({ err, locationId, ...pair }, 'businessContactRelation: unlink write failed (non-fatal)');
  }
}

export { BUSINESS_CONTACT, pickBusinessContact };
