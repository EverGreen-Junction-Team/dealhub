// pendingDealLink.js — the deal a rep picked when creating a note or task.
//
// Why this exists at all: at create time the pick has nowhere to live. GHL
// refuses it (the Associations API is closed to us on both entities) and our
// own row does not exist yet, because the CREATE webhook owns the INSERT and
// arrives after the HTTP response. Without somewhere to park it the pick was
// dropped and the webhook inferred a deal from the attribution rule instead —
// the contact's earliest open deal, which is only coincidentally the one the
// rep chose. See migration 069.
//
// The flow:
//
//   route    createGhlNote() -> id -> recordPendingDealLink(id, dealB)
//   webhook  NoteCreate      -> consumePendingDealLink(id) -> dealB, manual
//
// CONSUMPTION IS A DELETE. The intent answers exactly one webhook — the
// create. A later edit of the same note is a different event and must not
// pick up a stale pick.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

export const ENTITY_NOTE = 'note';
export const ENTITY_TASK = 'task';
// A message sent from the Deal Hub composer. Same problem as a note: the send
// returns an id before the OutboundMessage webhook writes our row, and on a
// contact with two open deals the attribution rule cannot know which one the
// rep was looking at. Consumed by attributionEngine.attributeMessage.
export const ENTITY_MESSAGE = 'message';
const ENTITIES = new Set([ENTITY_NOTE, ENTITY_TASK, ENTITY_MESSAGE]);

/**
 * Park the rep's pick until the create webhook arrives.
 *
 * NULL opportunityId is recorded, not skipped: "created with no deal" is as
 * much a decision as naming one, and it must suppress the rule the same way.
 *
 * Never throws. The note or task is ALREADY written in GHL by the time this
 * runs, so a failure here must not turn a successful create into an error —
 * the cost is the old behaviour (the rule guesses), not a lost record.
 */
export async function recordPendingDealLink(
  locationId, entityType, entityId, opportunityId, createdBy = null, createdVia = null
) {
  if (!locationId || !entityId || !ENTITIES.has(entityType)) return false;
  try {
    await rawQuery(
      `INSERT INTO pending_deal_links
         (location_id, entity_type, entity_id, opportunity_id, created_by, created_via)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET
         opportunity_id = EXCLUDED.opportunity_id,
         created_by     = EXCLUDED.created_by,
         created_via    = EXCLUDED.created_via,
         created_at     = now(),
         expires_at     = now() + interval '1 hour'`,
      [locationId, entityType, entityId, opportunityId || null, createdBy, createdVia]
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, locationId, entityType, entityId, opportunityId },
      'pendingDealLink: could not record the pick — the rule will attribute this one'
    );
    return false;
  }
}

/**
 * Take the pick, if one is waiting. Deletes the row.
 *
 * Returns { opportunityId } when the rep chose (including an explicit "no
 * deal", which returns { opportunityId: null }), or null when there is
 * nothing waiting — the caller should then run the rule as before.
 *
 * The two are NOT the same and the caller must not conflate them:
 *   { opportunityId: null }  the rep said "no deal"   -> do not infer
 *   null                      nobody chose             -> infer
 *
 * Expired rows are treated as absent. A webhook an hour late is not evidence
 * of anything, and a stale intent must never attach to a later record.
 */
export async function consumePendingDealLink(locationId, entityType, entityId) {
  if (!locationId || !entityId || !ENTITIES.has(entityType)) return null;
  try {
    const { rows } = await rawQuery(
      `DELETE FROM pending_deal_links
        WHERE location_id = $1 AND entity_type = $2 AND entity_id = $3
        RETURNING opportunity_id, created_by, created_via, expires_at`,
      [locationId, entityType, entityId]
    );
    if (!rows.length) return null;
    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date()) {
      logger.info(
        { locationId, entityType, entityId },
        'pendingDealLink: intent had expired — falling back to the rule'
      );
      return null;
    }
    return {
      opportunityId: rows[0].opportunity_id || null,
      createdBy: rows[0].created_by || null,
      createdVia: rows[0].created_via || null
    };
  } catch (err) {
    // A read failure must not stop the webhook writing the record.
    logger.warn(
      { err, locationId, entityType, entityId },
      'pendingDealLink: could not read the pick — the rule will attribute this one'
    );
    return null;
  }
}

/**
 * Drop intents whose webhook never came. Called by the daily sweep.
 *
 * Without this, a create whose webhook was lost leaves a row for ever.
 */
export async function sweepExpiredDealLinks() {
  try {
    const { rowCount } = await rawQuery(
      `DELETE FROM pending_deal_links WHERE expires_at < now()`
    );
    if (rowCount) {
      logger.info({ rowCount }, 'pendingDealLink: swept expired intents');
    }
    return rowCount || 0;
  } catch (err) {
    logger.warn({ err }, 'pendingDealLink: sweep failed');
    return 0;
  }
}
