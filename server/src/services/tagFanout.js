// tagFanout.js — keeps a deal's tags in step with its contacts' tags.
//
// GHL has no opportunity tags. Migration 048 states it plainly: "There is no
// opportunity-level tag API — no tags[] field on the opportunity object, no
// webhook for opportunity tags." A tag belongs to a CONTACT, and in the
// product a contact's tags are taken to reach that contact's opportunities.
//
// So the deals list tag filter — an EXISTS against tag_history where
// entity_type = 'opportunity' — matched nothing, for every tag, always.
//
// Migration 134 seeds those rows. This keeps them true afterwards: when a
// contact's tags change, every deal that contact is on is recomputed; when a
// contact is linked to or unlinked from a deal, that deal is recomputed.
//
// ── WHAT A DEAL'S TAGS ARE ───────────────────────────────────────────
//
// The UNION of the current tags of every contact on the deal — the primary
// (opportunities.contact_id) and every additional one (opportunity_contacts).
// That is the same membership contactIsOnDeal() enforces for writes, so
// "on this deal" means one thing across the app.
//
// ── WHY RECOMPUTE THE DEAL, NOT APPLY THE DELTA ──────────────────────
//
// A tag removed from one contact does NOT mean the deal loses it: another
// contact on the same deal may still carry it. Applying the contact's own
// diff to the deal would drop a tag the deal still has. So each affected
// deal is recomputed from the full union and reconciled as a whole.
//
// ── BEST EFFORT ──────────────────────────────────────────────────────
//
// Every entry point swallows its own errors. A tag is a filter facet; losing
// one must never fail the webhook that carried the real change, because
// that would cost the contact write itself.

import { rawQuery } from '../db.js';
import { reconcileTags } from './tagHistoryWriter.js';
import { logger } from '../utils/logger.js';

// Rows this service owns. A tag applied directly to an opportunity (if GHL
// ever gains the concept) would carry its own event name and must not be
// closed by a contact's tags disappearing.
const DETECTED_VIA = 'contact_fanout';

/**
 * Every deal this contact is on — primary or additional.
 */
async function dealsForContact(locationId, contactId) {
  const { rows } = await rawQuery(
    `SELECT opportunity_id FROM opportunities
      WHERE location_id = $1 AND contact_id = $2
      UNION
     SELECT opportunity_id FROM opportunity_contacts
      WHERE location_id = $1 AND contact_id = $2`,
    [locationId, contactId]
  );
  return rows.map((r) => r.opportunity_id);
}

/**
 * The tags a deal should currently carry: the union across all its contacts.
 *
 * Returns the shape reconcileTags expects — {id, name} — taking the lowest
 * tag_id when two contacts recorded different ids for the same name, since
 * the name is the identity (see tagHistoryWriter's note on the diff key).
 */
async function tagsForDeal(locationId, opportunityId) {
  const { rows } = await rawQuery(
    `SELECT th.tag_name AS name, MIN(th.tag_id) AS id
       FROM tag_history th
      WHERE th.location_id = $1
        AND th.entity_type = 'contact'
        AND th.removed_at IS NULL
        AND th.tag_name IS NOT NULL
        AND btrim(th.tag_name) <> ''
        AND th.entity_id IN (
          SELECT contact_id FROM opportunities
           WHERE location_id = $1 AND opportunity_id = $2 AND contact_id IS NOT NULL
          UNION
          SELECT contact_id FROM opportunity_contacts
           WHERE location_id = $1 AND opportunity_id = $2
        )
      GROUP BY th.tag_name`,
    [locationId, opportunityId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Recompute one deal's tags from its contacts. Safe to call repeatedly —
 * reconcileTags is a diff, so an unchanged deal writes nothing.
 */
export async function fanoutToDeal(locationId, opportunityId) {
  if (!locationId || !opportunityId) return { opened: 0, closed: 0 };
  const tags = await tagsForDeal(locationId, opportunityId);
  return reconcileTags({
    locationId,
    entityType: 'opportunity',
    entityId: opportunityId,
    currentTags: tags,
    detectedVia: DETECTED_VIA
  });
}

/**
 * A contact's tags changed — update every deal they are on.
 *
 * Called from the ContactTagUpdate webhook, AFTER the contact's own
 * reconcile, so the union this reads already includes the change.
 */
export async function fanoutFromContact(locationId, contactId) {
  if (!locationId || !contactId) return { deals: 0 };
  try {
    const dealIds = await dealsForContact(locationId, contactId);
    for (const id of dealIds) {
      try {
        await fanoutToDeal(locationId, id);
      } catch (err) {
        // One bad deal must not stop the others.
        logger.warn({ err, locationId, opportunityId: id }, 'tagFanout: deal recompute failed');
      }
    }
    if (dealIds.length) {
      logger.info({ locationId, contactId, deals: dealIds.length }, 'tagFanout: contact tags fanned out');
    }
    return { deals: dealIds.length };
  } catch (err) {
    logger.warn({ err, locationId, contactId }, 'tagFanout: fanout from contact failed');
    return { deals: 0 };
  }
}

/**
 * A contact was linked to or unlinked from a deal — recompute that deal.
 *
 * Linking brings that contact's tags onto the deal; unlinking removes any
 * the remaining contacts do not also carry. Both fall out of recomputing
 * the union, which is why this is the same call either way.
 */
export async function fanoutOnRelationChange(locationId, opportunityId) {
  if (!locationId || !opportunityId) return;
  try {
    await fanoutToDeal(locationId, opportunityId);
  } catch (err) {
    logger.warn({ err, locationId, opportunityId }, 'tagFanout: relation-change recompute failed');
  }
}
