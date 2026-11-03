// backfillMessages.js — one-time full-history sweep for messages.
//
// Resets sweep_cursors.success_through for the target location(s) to NULL
// so the sync starts from the first-run lookback (30 days). To go further
// back, temporarily set FIRST_RUN_LOOKBACK_DAYS higher in sweepCursors.js
// or run this script repeatedly after manually resetting cursors.
//
// Usage:
//   npm run backfill:messages -- --location fJNuIdxGgchGpJ9OoBbk
//   npm run backfill:messages                          # all active installs
//
// Idempotent: UPSERT via (location_id, message_id) — re-running is safe.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { syncMessagesForLocation } from '../services/messagesSync.js';
import { logger } from '../utils/logger.js';

function parseArgs(argv) {
  const locations = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--location' && argv[i + 1]) {
      locations.push(argv[++i]);
    }
  }
  return { locations };
}

async function listAllActiveLocations() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL ORDER BY installed_at ASC`
  );
  return rows.map((r) => r.location_id);
}

async function resetCursor(locationId) {
  await rawQuery(
    `DELETE FROM sweep_cursors WHERE location_id = $1 AND object_type = 'messages'`,
    [locationId]
  );
}

async function main() {
  const { locations: cli } = parseArgs(process.argv);
  const targets = cli.length ? cli : await listAllActiveLocations();

  if (targets.length === 0) {
    logger.warn('backfillMessages: no locations found');
    return;
  }

  logger.info({ targets }, 'backfillMessages: starting');

  let totalMessages = 0;
  for (const locationId of targets) {
    const install = await getActiveInstall(locationId);
    if (!install) {
      logger.warn({ locationId }, 'backfillMessages: no active install — skipping');
      continue;
    }
    await resetCursor(locationId);
    try {
      const { messagesUpserted } = await syncMessagesForLocation(install);
      totalMessages += messagesUpserted || 0;
    } catch (err) {
      logger.error({ err, locationId }, 'backfillMessages: location failed');
    }
  }

  logger.info({ locations: targets.length, totalMessages }, 'backfillMessages: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfillMessages: failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
