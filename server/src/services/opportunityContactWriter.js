// opportunityContactWriter.js — RelationCreate / RelationDelete handlers.
//
// Deal Hub needs the FULL contact list per opportunity (primary + followers),
// not just opportunities.contact_id. GHL exposes this via
// OPPORTUNITIES_CONTACTS_ASSOCIATION, delivered on:
//
//   • RelationCreate — new (opp, contact) link
//   • RelationDelete — link removed
//
// Payload shape (from marketplace docs):
//   {
//     id, firstObjectKey: 'opportunity', firstRecordId: <opp_id>,
//     secondObjectKey: 'contact', secondRecordId: <contact_id>,
//     associationId: 'OPPORTUNITIES_CONTACTS_ASSOCIATION', primary: true|false,
//     pipelineId, locationId
//   }
//
// We only care about opp↔contact rows here. Other association types (custom
// object relations, tag associations, etc.) are silently ignored.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';
import { fanoutOnRelationChange } from './tagFanout.js';

const OPP_CONTACT_ASSOC = 'OPPORTUNITIES_CONTACTS_ASSOCIATION';

// Some payloads swap first/second keys. Return { oppId, contactId } or null
// if this relation isn't opp↔contact.
function pickOppContact(event) {
  const a = { key: event.firstObjectKey, id: event.firstRecordId };
  const b = { key: event.secondObjectKey, id: event.secondRecordId };
  if (a.key === 'opportunity' && b.key === 'contact')
    return { oppId: a.id, contactId: b.id };
  if (b.key === 'opportunity' && a.key === 'contact')
    return { oppId: b.id, contactId: a.id };
  return null;
}

export async function handleRelationCreate(install, event) {
  const locationId = install.location_id;
  const relationId = event.id;
  const associationId = event.associationId || null;

  // WHICH RELATIONS ARE OURS — BY OBJECT KEY, NOT BY associationId.
  //
  // This used to require associationId === 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
  // and return early otherwise. GHL does not send that string: the live
  // payload carries a Mongo ObjectId —
  //
  //   "associationId": "6aab95944b0508155d99556b",
  //   "firstObjectKey": "contact",  "secondObjectKey": "opportunity"
  //
  // — so EVERY real RelationCreate was logged as "ignoring non-OPP_CONTACT
  // association" and dropped. Adding someone to a deal returned 201, GHL
  // created the relation, the webhook arrived and applied cleanly... and
  // opportunity_contacts never gained a row. The rail refetched, got a
  // byte-identical body (correctly, a 304) and the person never appeared,
  // with no error anywhere to explain it.
  //
  // Only the PRIMARY contact ever showed, because stageHistoryWriter writes
  // that row itself with the canonical string hardcoded.
  //
  // pickOppContact already identifies the relation the reliable way — by the
  // object keys, which the payload does carry and which cannot drift the way
  // an opaque id can. That is the test now.
  const pair = pickOppContact(event);
  if (!pair) {
    logger.debug(
      { relationId, associationId },
      'relationCreate: not an opportunity↔contact relation — ignoring'
    );
    return;
  }

  await rawQuery(
    `INSERT INTO opportunity_contacts
       (location_id, relation_id, opportunity_id, contact_id,
        is_primary, pipeline_id, association_id,
        last_synced_at, last_seen_via, raw_relation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'webhook', $8)
     ON CONFLICT (location_id, relation_id) DO UPDATE SET
       opportunity_id = EXCLUDED.opportunity_id,
       contact_id     = EXCLUDED.contact_id,
       is_primary     = EXCLUDED.is_primary,
       pipeline_id    = COALESCE(EXCLUDED.pipeline_id, opportunity_contacts.pipeline_id),
       last_synced_at = now(),
       last_seen_via  = 'webhook',
       raw_relation   = EXCLUDED.raw_relation`,
    [
      locationId, relationId, pair.oppId, pair.contactId,
      // NORMALISED, not passed through. Thirteen read sites filter on the
      // canonical string, and stageHistoryWriter writes it for the primary
      // contact — storing GHL's ObjectId here instead would insert a row
      // that every one of those reads then filters straight back out.
      !!event.primary, event.pipelineId || null, OPP_CONTACT_ASSOC, event
    ]
  );

  logger.info(
    { locationId, oppId: pair.oppId, contactId: pair.contactId, primary: !!event.primary },
    'relationCreate: opportunity ↔ contact stored'
  );

  // The deal's tags are the union of its contacts' tags (see tagFanout.js),
  // so linking someone brings their tags onto the deal. Recomputed rather
  // than added, because the union is the definition. Best-effort inside.
  await fanoutOnRelationChange(locationId, pair.oppId);
}

export async function handleRelationDelete(install, event) {
  const locationId = install.location_id;
  const relationId = event.id;

  // WHICH DEAL, read BEFORE the delete. The event carries only the relation
  // id, so once the row is gone there is nothing left to tell us which deal
  // to recompute — and the deal would keep a tag only the unlinked contact
  // carried, with no event ever coming to correct it.
  const { rows: before } = await rawQuery(
    `SELECT opportunity_id FROM opportunity_contacts
      WHERE location_id = $1 AND relation_id = $2`,
    [locationId, relationId]
  );
  const oppId = before[0]?.opportunity_id || null;

  const { rowCount } = await rawQuery(
    `DELETE FROM opportunity_contacts
       WHERE location_id = $1 AND relation_id = $2`,
    [locationId, relationId]
  );
  logger.info(
    { locationId, relationId, deleted: rowCount },
    'relationDelete: opportunity ↔ contact removed'
  );

  // Unlinking drops any tag the remaining contacts do not also carry. Falls
  // out of recomputing the union, which is why this is the same call as the
  // create path.
  if (oppId) await fanoutOnRelationChange(locationId, oppId);
}
