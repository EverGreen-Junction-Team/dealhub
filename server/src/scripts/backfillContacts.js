// backfillContacts.js — one-time seed of the contacts table for a location.
//
// Paginates GHL's /contacts/ endpoint and upserts every contact via
// handleContactUpsert (same code path as ContactCreate/ContactUpdate
// webhooks). All fields promoted per CSV blueprint; unknown custom fields
// retained in custom_fields JSONB.
//
// Usage:
//   npm run backfill:contacts -- --location fJNuIdxGgchGpJ9OoBbk
//   npm run backfill:contacts -- --location fJNu... --location IFcS...
//   npm run backfill:contacts                                       # all active installs
//
// Idempotent: UPSERT means it refreshes changed rows without duplicates.
// Rows already ingested via webhooks keep their existing values (COALESCE);
// missing columns get filled from the API response.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { backfillContactsForLocation } from '../services/contactWriter.js';
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
    logger.warn('backfillContacts: no locations found (nothing installed?)');
    return;
  }

  logger.info({ targets }, 'backfillContacts: starting');

  let totalContacts = 0;
  for (const locationId of targets) {
    const install = await getActiveInstall(locationId);
    if (!install) {
      logger.warn({ locationId }, 'backfillContacts: no active install — skipping');
      continue;
    }
    try {
      const { count } = await backfillContactsForLocation(install);
      totalContacts += count;
    } catch (err) {
      logger.error({ err, locationId }, 'backfillContacts: location failed');
    }
  }

  logger.info({ locations: targets.length, totalContacts }, 'backfillContacts: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfillContacts: failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
