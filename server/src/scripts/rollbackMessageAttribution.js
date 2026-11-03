// Undo a run of backfillMessageAttribution.js.
//
// The backfill SUPERSEDES rather than deletes: the previous mapping survives
// with superseded_at stamped. So a run is reversible — this drops the rows the
// backfill wrote and un-supersedes whatever they replaced.
//
// SCOPED BY TIME. Only rows written by the backfill (rule_version v2, and one
// of its two rule names) after --since are removed, so a manual move made
// afterwards is not swept up with them.
//
// Run: node src/scripts/rollbackMessageAttribution.js --since='2026-09-09T00:00:00Z' [--dry-run]

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const since = args.find((a) => a.startsWith('--since='))?.split('=')[1] || null;
const dryRun = args.includes('--dry-run');

if (!since) {
  console.log('Refusing to run without --since.');
  console.log('Without a cut-off this would undo every v2 mapping ever written,');
  console.log('including ones from a run you meant to keep.');
  console.log("\nExample: --since='2026-09-09T00:00:00Z'  (use the backfill's start time)");
  process.exit(1);
}

const BACKFILL_RULES = ['open_at_message_date', 'no_open_opp_at_message_date'];

async function run() {
  const { rows: doomed } = await rawQuery(
    `SELECT location_id, message_id FROM message_opportunity_map
      WHERE rule = ANY($1::text[])
        AND mapped_at >= $2
        AND superseded_at IS NULL`,
    [BACKFILL_RULES, since]
  );
  console.log(`${doomed.length} mappings written by the backfill since ${since}`);
  if (doomed.length === 0) return;

  if (dryRun) {
    console.log('DRY RUN — nothing changed.');
    return;
  }

  // Delete the backfill's rows first, then revive the most recent row it
  // superseded for each message. Order matters: un-superseding first would
  // leave two current rows for a moment, which every read treats as ambiguous.
  const del = await rawQuery(
    `DELETE FROM message_opportunity_map
      WHERE rule = ANY($1::text[]) AND mapped_at >= $2 AND superseded_at IS NULL`,
    [BACKFILL_RULES, since]
  );
  console.log(`  removed ${del.rowCount} backfill rows`);

  // Revive exactly one per message — the latest that was superseded by the
  // backfill, not every historic row.
  const rev = await rawQuery(
    `UPDATE message_opportunity_map m
        SET superseded_at = NULL
       FROM (
         SELECT DISTINCT ON (location_id, message_id) location_id, message_id, ctid
           FROM message_opportunity_map
          WHERE superseded_at >= $1
          ORDER BY location_id, message_id, superseded_at DESC, mapped_at DESC
       ) latest
      WHERE m.ctid = latest.ctid`,
    [since]
  );
  console.log(`  restored ${rev.rowCount} previous mappings`);

  // Re-mirror onto messages.opportunity_id, which most reads use.
  const mir = await rawQuery(
    `UPDATE messages msg
        SET opportunity_id = mom.opportunity_id
       FROM message_opportunity_map mom
      WHERE mom.location_id = msg.location_id
        AND mom.message_id  = msg.message_id
        AND mom.superseded_at IS NULL`
  );
  console.log(`  re-mirrored ${mir.rowCount} message rows`);
  console.log('\nRolled back. Manual mappings were never touched by the backfill.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'rollback failed'); process.exit(1); });
