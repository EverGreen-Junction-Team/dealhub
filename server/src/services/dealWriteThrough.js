// dealWriteThrough.js — a deal change WE made, in our own database at once.
//
// ── WHY ──────────────────────────────────────────────────────────────────
//
// Every deal write goes to GHL, and our copy used to change only when GHL's
// webhook came back. That is usually a second or two — sometimes far longer —
// and in that gap every screen showed the OLD deal: a card dragged on the board
// vanished, a stage picked on the Deal hub snapped back, a new deal was missing
// from the list. The dashboard papered over it with 2.5-second timers that
// guessed at a round trip nobody controls.
//
// ── HOW ──────────────────────────────────────────────────────────────────
//
// Straight after GHL accepts a write, the route runs the SAME handler a webhook
// runs (handleOpportunityEvent) with a minimal event. That handler fetches the
// opportunity back from GHL and writes it — so what we store is GHL's own
// answer, not our guess at it, and stage_history is kept by the one path that
// has always kept it.
//
// ── THE WEBHOOK STILL VALIDATES ──────────────────────────────────────────
//
// When GHL's webhook arrives it goes through the handler as before: it fetches
// GHL's copy again and overwrites ours. If GHL changed something after our
// write (an automation moving the deal on, say), the webhook's version wins.
// If nothing changed, the stage is already current and no second stage row is
// opened (the handler compares against the open row).
//
// ── NEVER FAILS THE REQUEST ─────────────────────────────────────────────
//
// GHL has already accepted the change by the time this runs. A failure or a
// slow read-back here must not turn a successful save into an error, so it is
// bounded by a time limit and reports `false` instead of throwing. The route
// passes that on as `mirrored`, and the dashboard falls back to waiting for
// the webhook when it is false.

import { handleOpportunityEvent, markOpportunityDeleted } from './stageHistoryWriter.js';
import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';

// Long enough for GHL's read-back plus our transaction on a normal day; short
// enough that a slow GHL never holds a save for long. Past it the write carries
// on in the background and the request answers `mirrored: false`.
export const WRITE_THROUGH_TIMEOUT_MS = 6000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Write GHL's current copy of one deal into our database now.
 *
 *   eventType   which webhook this stands in for. 'OpportunityStageUpdate'
 *               when the stage may have changed (it opens/closes stage rows),
 *               'OpportunityCreate' for a new deal, else 'OpportunityUpdate'.
 *   contactId   the deal's primary contact. Required: the handler drops an
 *               event without one.
 *   expectStageId  the stage we asked GHL for. Checked against what GHL hands
 *               back, and a disagreement logged — the webhook will settle it.
 *
 * Resolves true when our row now holds GHL's copy, false otherwise. Never throws.
 */
export async function mirrorOpportunity(install, opportunityId, {
  eventType = 'OpportunityUpdate', contactId = null, expectStageId = null,
  timeoutMs = WRITE_THROUGH_TIMEOUT_MS, handler = handleOpportunityEvent
} = {}) {
  const locationId = install?.location_id;
  if (!locationId || !opportunityId) return false;

  const event = {
    type: eventType,
    locationId,
    id: opportunityId,
    opportunityId,
    contactId: contactId || undefined,
    // Our own clock: this is the moment the change was made. The webhook
    // carries GHL's, and for an unchanged stage it opens no new row.
    timestamp: new Date().toISOString(),
    source: 'dealhub-write-through'
  };

  const work = (async () => {
    const written = await handler(install, eventType, event, { writeThrough: true });
    if (written && expectStageId) {
      const stored = await withTenant(locationId, async (client) => {
        const { rows } = await client.query(
          `SELECT current_stage_id FROM opportunities
            WHERE location_id = $1 AND opportunity_id = $2`,
          [locationId, opportunityId]
        );
        return rows[0]?.current_stage_id || null;
      });
      if (stored !== expectStageId) {
        logger.warn(
          { locationId, opportunityId, expectStageId, stored },
          'deal write-through: GHL read-back shows a different stage — the webhook will settle it'
        );
      }
    }
    return !!written;
  })().catch((err) => {
    logger.warn({ err, locationId, opportunityId, eventType }, 'deal write-through failed — waiting for the webhook instead');
    return false;
  });

  const result = await withTimeout(work, timeoutMs);
  if (result === 'timeout') {
    logger.warn({ locationId, opportunityId, eventType, timeoutMs }, 'deal write-through slow — answering now, finishing in the background');
    return false;
  }
  return result;
}

/** A deal we deleted, marked deleted in our database now. Never throws. */
export async function mirrorOpportunityDeleted(install, opportunityId, { mark = markOpportunityDeleted } = {}) {
  const locationId = install?.location_id;
  if (!locationId || !opportunityId) return false;
  try {
    return await mark(locationId, opportunityId);
  } catch (err) {
    logger.warn({ err, locationId, opportunityId }, 'deal delete write-through failed — waiting for the webhook instead');
    return false;
  }
}
