// attributionEngine.js — Stage 2 · message → opportunity attribution.
//
// Runs the 5-rule set (v1) on every message write:
//
//   1. earliest_open_opp_v2      The contact's EARLIEST-CREATED open opp  0.95
//   2. stage_containment_v1      Msg timestamp inside exactly 1 stage     0.90
//   3. only_active_at_time_v1    Multiple opps but only 1 active then     0.75
//   4. single_lifetime_opp_v1    Contact has exactly 1 lifetime opp       0.60
//   5. terminal                  0 opps / 2+ concurrent / ambiguous
//
// Rule 1 changed on 2026-09-08 (was single_open_opp_v1, which required
// EXACTLY one open opp and returned null otherwise). Two open deals now pick
// the earliest rather than declining. Rules 2-4 are therefore reached only
// when the contact has NO open opportunity — they remain useful for exactly
// that case. See docs/MESSAGE-DEAL-LINKING-RULE.md.
//
// "The contact's opps" = every opportunity where this contact appears in
// opportunity_contacts (primary OR follower) — falling back to
// opportunities.contact_id only when opportunity_contacts hasn't been
// backfilled yet. Followers must attribute the same as primaries, otherwise
// a follower's outbound SMS lands with status='unassigned' even when the
// deal is obvious.
//
// Every decision writes a row to message_opportunity_map. Existing "current"
// row for the message is superseded (mapped_at stamped on old row) before
// the new row is inserted — full history preserved.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';
import { consumePendingDealLink, ENTITY_MESSAGE } from './pendingDealLink.js';

const RULE_VERSION = 'v1';

// The rule name for a message sent from the Deal Hub composer. Not a guess:
// the rep sent it from that deal's page, which is the strongest evidence of
// intent there is. hasManualMapping treats it like a manual link so a re-sync
// cannot move it — but it stays mapping_status 'mapped', because nobody MOVED
// it, and the timeline's "Moved" pill must not claim otherwise.
const COMPOSER_RULE = 'composer_send';

// Resolve every opp id linked to this contact (primary or follower).
// Reads opportunity_contacts first — that table holds all links per the
// OPPORTUNITIES_CONTACTS_ASSOCIATION webhook + backfill. If nothing comes
// back (e.g. backfill hasn't run yet for this location), we fall back to
// opportunities.contact_id so pre-relation-table behaviour still works.
async function contactOppIds(locationId, contactId) {
  const { rows } = await rawQuery(
    `SELECT opportunity_id FROM opportunity_contacts
      WHERE location_id = $1 AND contact_id = $2`,
    [locationId, contactId]
  );
  if (rows.length > 0) return rows.map((r) => r.opportunity_id);

  const legacy = await rawQuery(
    `SELECT opportunity_id FROM opportunities
      WHERE location_id = $1 AND contact_id = $2 AND is_deleted = false`,
    [locationId, contactId]
  );
  return legacy.rows.map((r) => r.opportunity_id);
}

// Rule 1 — the contact's EARLIEST-CREATED open opportunity.
//
// Agreed with James on 2026-09-08; see docs/MESSAGE-DEAL-LINKING-RULE.md.
//
//   exactly one open   → link to it
//   more than one open → link to the EARLIEST-CREATED one
//   none open          → fall through (rules 2-4, then unlinked)
//
// This used to require exactly one (`rows.length !== 1` returned null), so a
// contact with two open deals fell through to the weaker rules and usually
// ended `ambiguous` — the message appeared on no deal at all. James's point:
// a default that leaves most messages unlinked is worse than a default that
// picks the obvious one and lets a manager move it.
//
// "Open" is strict: GHL's statuses are open / won / lost / abandoned, and only
// `open` counts. Won is closed for this purpose.
//
// Ordering is by GHL's own created timestamp ALONE. `imported_at` is when our
// sync first saw the deal — for anything backfilled that is months after the
// fact, so using it as a fallback would let a recently-imported old deal
// masquerade as the earliest. A deal with no GHL date sorts last instead, and
// only wins when it is the only candidate.
//
// The id is the final tiebreak so the result is deterministic: two deals
// created in the same millisecond would otherwise return in arbitrary order
// and the mapping would flap between re-runs.
async function ruleSingleOpenOpp(locationId, oppIds) {
  if (oppIds.length === 0) return null;
  const { rows } = await rawQuery(
    `SELECT opportunity_id
       FROM opportunities
      WHERE location_id = $1
        AND opportunity_id = ANY($2::text[])
        AND status = 'open'
        AND is_deleted = false
        AND deleted_at IS NULL
      -- created_at_ghl ONLY. imported_at is when OUR sync first saw the
      -- deal, not when it was created, so a backfilled deal would sort as
      -- though created on the day we imported it — and could win
      -- "earliest" over a deal that genuinely predates it.
      --
      -- NULLS LAST so a deal with no GHL date never wins the tiebreak by
      -- default: in Postgres, ASC puts NULLs last only if you say so.
      ORDER BY created_at_ghl ASC NULLS LAST, opportunity_id ASC
      LIMIT 1`,
    [locationId, oppIds]
  );
  if (rows.length === 0) return null;
  return {
    opportunityId: rows[0].opportunity_id,
    mappingStatus: 'mapped',
    rule: 'earliest_open_opp',
    confidence: 0.95
  };
}

// Terminal — nothing matched. Classify the reason.
async function terminalClassification(locationId, oppIds, messageTs) {
  if (oppIds.length === 0) {
    return { mappingStatus: 'unassigned', rule: 'terminal_no_opp', confidence: 1.00 };
  }
  const { rows } = await rawQuery(
    `SELECT status, is_deleted, deleted_at, won_at, lost_at, abandoned_at, created_at_ghl
       FROM opportunities
      WHERE location_id = $1 AND opportunity_id = ANY($2::text[])`,
    [locationId, oppIds]
  );
  const openAtTime = rows.filter((o) => {
    if (o.is_deleted) return false;
    if (o.status !== 'open') return false;
    if (messageTs && o.created_at_ghl && new Date(o.created_at_ghl) > messageTs) return false;
    return true;
  });
  if (openAtTime.length >= 2) {
    return { mappingStatus: 'excluded_multi_open', rule: 'terminal_multi_open', confidence: 1.00 };
  }
  return { mappingStatus: 'ambiguous', rule: 'terminal_ambiguous', confidence: 0.50 };
}

// Shared: run the 5-rule engine for a (contact, timestamp) pair and return
// the raw decision — no side effects, no writes to message_opportunity_map.
// This is the seam that tasks + notes attribution reuses: they don't have
// a mapping-map of their own (they stamp opportunity_id directly on the
// row), but the DECISION LOGIC is identical to messages.
export async function resolveOppForContact(locationId, contactId, atTimestamp) {
  if (!contactId) return null;
  const oppIds = await contactOppIds(locationId, contactId);

  // RULE 1 DECIDES, OR NOTHING DOES.
  //
  // Rules 2-4 predate the agreed rule and do NOT check status:
  //
  //   stage_containment   matches a stage window. A deal marked lost keeps
  //                       left_at NULL — it is still "in" its last stage —
  //                       so a message sent AFTER the loss falls inside the
  //                       window and links to a closed deal.
  //   single_lifetime_opp matches the contact's only deal, open or not.
  //   only_active_at_time does check status, but is reached only in cases
  //                       rule 1 has already settled.
  //
  // Caught in live testing: a message sent two minutes after a deal was
  // marked lost linked to it via stage_containment at 0.90 confidence.
  //
  // They existed as fallbacks for the OLD rule 1, which declined whenever a
  // contact had two open deals. That rule now returns the earliest open deal
  // instead, so it answers every case the agreed rule covers — and when it
  // finds nothing, the agreed answer is "leave the message unlinked on the
  // contact record", not "try something looser".
  //
  // See docs/MESSAGE-DEAL-LINKING-RULE.md. The three rules are DELETED rather
  // than left unused: dead code that still looks like a rule invites someone
  // to wire it back into the chain, which is exactly the bug above.
  return (
    (await ruleSingleOpenOpp(locationId, oppIds)) ||
    (await terminalClassification(locationId, oppIds, atTimestamp))
  );
}

// Public entry — decide the current mapping for one message.
// Called by messageWriter.upsertMessage after the message row is written.
export async function attributeMessage({
  locationId,
  messageId,
  contactId,
  messageTimestamp,
  detectedVia = 'live'   // 'live' | 'sync' | 'backfill' | 'manual'
}) {
  if (!messageId || !contactId) return null;

  // A human decision outranks the engine, permanently. Without this a
  // re-sync, a backfill or the retrospective pass would quietly revert a
  // sales manager's correction — and nothing would show that it had happened.
  if (await hasManualMapping(locationId, messageId)) {
    logger.debug(
      { locationId, messageId, detectedVia },
      'attribution: skipped — this message was mapped manually'
    );
    return null;
  }

  // Sent from a deal's composer? Then that deal, not the rule's pick.
  const pick = await consumePendingDealLink(locationId, ENTITY_MESSAGE, messageId);
  if (pick?.opportunityId) {
    return await recordDecision({
      locationId,
      messageId,
      decision: {
        opportunityId: pick.opportunityId,
        mappingStatus: 'mapped',
        rule: COMPOSER_RULE,
        confidence: 1.0
      },
      detectedVia: 'composer'
    });
  }

  const decision = await resolveOppForContact(locationId, contactId, messageTimestamp);
  return await recordDecision({
    locationId, messageId, decision, detectedVia
  });
}

// Write the mapping row + supersede any prior current row for this message.
// Also updates messages.opportunity_id + messages.stage_history_id when the
// decision is `mapped` (kept in sync as a materialisation of the current
// mapping — makes downstream queries cheaper than joining every time).
async function recordDecision({ locationId, messageId, decision, detectedVia }) {
  try {
    // 1. Supersede the current row for this message (if any)
    await rawQuery(
      `UPDATE message_opportunity_map
          SET superseded_at = now()
        WHERE location_id = $1 AND message_id = $2
          AND superseded_at IS NULL`,
      [locationId, messageId]
    );

    // 2. Insert new current row
    await rawQuery(
      `INSERT INTO message_opportunity_map
         (location_id, message_id, opportunity_id, stage_history_id,
          mapping_status, rule, rule_version, confidence,
          reviewed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        locationId, messageId,
        decision.opportunityId || null,
        decision.stageHistoryId || null,
        decision.mappingStatus,
        decision.rule,
        RULE_VERSION,
        decision.confidence,
        `system:${detectedVia}`
      ]
    );

    // 3. Materialise on messages (only when mapped — never NULL-out a value
    //    Layer 2 might have set from stage-transition fetch).
    if (decision.mappingStatus === 'mapped' && decision.opportunityId) {
      await rawQuery(
        `UPDATE messages
            SET opportunity_id   = $3,
                stage_history_id = COALESCE($4, stage_history_id)
          WHERE location_id = $1 AND message_id = $2
            AND (opportunity_id IS NULL OR opportunity_id = $3)`,
        [locationId, messageId, decision.opportunityId, decision.stageHistoryId || null]
      );
    }

    return decision;
  } catch (err) {
    logger.warn(
      { err, locationId, messageId, decision },
      'attributionEngine: recordDecision failed (non-fatal)'
    );
    return null;
  }
}

/**
 * Is this message's current mapping a human decision?
 *
 * A manual link outranks the engine permanently. Re-running attribution — on a
 * backfill, a re-sync, or the retrospective pass — must leave it alone, or a
 * sales manager's correction silently reverts the next time anything sweeps.
 *
 * Checked by attributeMessage before it writes.
 */
export async function hasManualMapping(locationId, messageId) {
  const { rows } = await rawQuery(
    `SELECT 1 FROM message_opportunity_map
      WHERE location_id = $1 AND message_id = $2
        AND superseded_at IS NULL
        AND (mapping_status = 'manually_resolved' OR rule = '${COMPOSER_RULE}')
      LIMIT 1`,
    [locationId, messageId]
  );
  return rows.length > 0;
}

// Manual override — an admin says "this message actually belongs to opp X".
// Supersedes any prior row and stamps reviewer metadata.
export async function manualResolve({
  locationId,
  messageId,
  opportunityId,
  stageHistoryId = null,
  reviewedBy,
  reviewNote = null
}) {
  await rawQuery(
    `UPDATE message_opportunity_map
        SET superseded_at = now()
      WHERE location_id = $1 AND message_id = $2 AND superseded_at IS NULL`,
    [locationId, messageId]
  );
  await rawQuery(
    `INSERT INTO message_opportunity_map
       (location_id, message_id, opportunity_id, stage_history_id,
        mapping_status, rule, rule_version, confidence,
        reviewed_by, reviewed_at, review_note)
     VALUES ($1,$2,$3,$4,'manually_resolved','manual',$5,1.00,$6,now(),$7)`,
    [locationId, messageId, opportunityId, stageHistoryId, RULE_VERSION, reviewedBy, reviewNote]
  );
  await rawQuery(
    `UPDATE messages
        SET opportunity_id   = $3,
            stage_history_id = $4
      WHERE location_id = $1 AND message_id = $2`,
    [locationId, messageId, opportunityId, stageHistoryId]
  );
}
