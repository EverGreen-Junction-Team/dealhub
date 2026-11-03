#!/usr/bin/env node
//
// captureSnapshot.js — write today's pipeline snapshot by hand.
//
// The cron does this nightly. Run it manually to take the FIRST reading
// without waiting for tonight, to backfill a day the job missed, or to correct
// a day after fixing a bug — the write is ON CONFLICT DO UPDATE, so re-running
// replaces that day's row rather than adding a second.
//
// There is no true backfill: --date writes TODAY'S numbers under an earlier
// date, which is only ever right when the job failed and the pipeline has not
// moved since. It cannot reconstruct what was true on a past day.
//
// Usage:
//   node src/scripts/captureSnapshot.js                    # every install
//   node src/scripts/captureSnapshot.js <location_id>      # one
//   node src/scripts/captureSnapshot.js <location_id> --date 2026-09-29

import { captureSnapshotForLocation, captureSnapshotsForAllInstalls } from '../services/pipelineSnapshot.js';
import { logger } from '../utils/logger.js';

async function main() {
  const argv = process.argv.slice(2);
  const dateIdx = argv.indexOf('--date');
  const snapshotDate = dateIdx !== -1 ? argv[dateIdx + 1] : null;
  if (dateIdx !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate || '')) {
    throw new Error('--date needs a YYYY-MM-DD value');
  }

  const locations = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date') { i += 1; continue; }
    if (argv[i].startsWith('--')) continue;
    locations.push(argv[i]);
  }

  if (!locations.length) {
    const r = await captureSnapshotsForAllInstalls({ snapshotDate });
    console.log(`captured ${r.captured}/${r.locations}  failed ${r.failed}`);
    process.exit(r.failed ? 1 : 0);
  }

  for (const locationId of locations) {
    const stats = await captureSnapshotForLocation(locationId, { snapshotDate });
    console.log(
      `${locationId}  open ${stats.open_deals}  no-task ${stats.open_no_task_anywhere}  `
      + `no-notes ${stats.open_no_notes}  stagnant ${stats.open_stagnant_30d}`
    );
  }
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'captureSnapshot: fatal');
  console.error(err.message);
  process.exit(1);
});
