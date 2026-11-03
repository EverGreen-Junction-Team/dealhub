// backfillUsers.js — one-time seed of the users table for a location.
//
// Runs GET /users?locationId=X and upserts every user into `users`. Called
// once per location right after `npm run migrate` applies migration 014,
// so tasks/opportunities/notes ingested afterwards can immediately resolve
// user IDs → names locally without an API round trip.
//
// Usage:
//   npm run backfill:users -- --location fJNuIdxGgchGpJ9OoBbk
//   npm run backfill:users -- --location fJNu... --location IFcS...   # multiple
//   npm run backfill:users                                            # all active installs
//
// Idempotent: re-running is safe. UPSERT means it refreshes any changed
// user rows (e.g. renames, role changes) without duplicating.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall } from './../services/ghlClient.js';
import { backfillUsersForLocation } from '../services/userWriter.js';
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

async function main() {
  const { locations: cli } = parseArgs(process.argv);
  const targets = cli.length ? cli : await listAllActiveLocations();

  if (targets.length === 0) {
    logger.warn('backfillUsers: no locations found (nothing installed?)');
    return;
  }

  logger.info({ targets }, 'backfillUsers: starting');

  let totalUsers = 0;
  for (const locationId of targets) {
    const install = await getActiveInstall(locationId);
    if (!install) {
      logger.warn({ locationId }, 'backfillUsers: no active install — skipping');
      continue;
    }
    try {
      const { count } = await backfillUsersForLocation(install);
      totalUsers += count;
    } catch (err) {
      logger.error({ err, locationId }, 'backfillUsers: location failed');
    }
  }

  logger.info({ locations: targets.length, totalUsers }, 'backfillUsers: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfillUsers: failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
