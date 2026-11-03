// backfillAttribution.js — one-time attribution pass for existing messages.
//
// Runs the 5-rule attribution engine over every message in a location that
// doesn't yet have a current (non-superseded) row in message_opportunity_map.
// Writes decisions to message_opportunity_map and materialises the winning
// opportunity_id / stage_history_id on the messages row.
//
// Usage:
//   npm run backfill:attribution -- --location fJNuIdxGgchGpJ9OoBbk
//   npm run backfill:attribution -- --location fJNu... --location IFcS...
//   npm run backfill:attribution                          # all active installs
//   npm run backfill:attribution -- --dry-run             # decide but don't write
//   npm run backfill:attribution -- --re-attribute        # revisit unassigned/ambiguous/excluded_multi_open
//
// Idempotent: only touches messages that don't have a current mapping row.
// With --re-attribute, also revisits any currently unassigned / ambiguous /
// excluded_multi_open rows — use this after changes to the rule engine
// (e.g. the opportunity_contacts-aware update that lets followers attribute).
// Never touches rows already 'mapped' or 'manually_resolved'.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { attributeMessage } from '../services/attributionEngine.js';
import { logger } from '../utils/logger.js';

function parseArgs(argv) {
  const locations = [];
  let dryRun = false;
  // When true, we also revisit messages whose current mapping is
  // unassigned / ambiguous / excluded_multi_open — those are the ones
  // that may flip to 'mapped' now that the engine understands
  // opportunity_contacts (followers) instead of only the primary contact.
  let reAttribute = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--location' && argv[i + 1]) {
      locations.push(argv[++i]);
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--re-attribute') {
      reAttribute = true;
    }
  }
  return { locations, dryRun, reAttribute };
}

async function listAllActiveLocations() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL ORDER BY installed_at ASC`
  );
  return rows.map((r) => r.location_id);
}

// Fetch messages needing attribution.
//
// Default: no current (non-superseded) mapping row at all.
// With reAttribute=true: also include messages whose current mapping is
// unassigned / ambiguous / excluded_multi_open — those may flip to 'mapped'
// under the new engine (opportunity_contacts-aware). We deliberately do NOT
// revisit rows already `mapped` or `manually_resolved` — those are settled.
async function fetchUnattributed(locationId, batchSize, lastId, reAttribute) {
  const params = [locationId, batchSize];
  let idFilter = '';
  if (lastId) {
    params.push(lastId);
    idFilter = `AND m.id > $${params.length}`;
  }
  const missingClause = `NOT EXISTS (
    SELECT 1 FROM message_opportunity_map mom
     WHERE mom.location_id = m.location_id
       AND mom.message_id = m.message_id
       AND mom.superseded_at IS NULL
  )`;
  const reAttrClause = `EXISTS (
    SELECT 1 FROM message_opportunity_map mom
     WHERE mom.location_id = m.location_id
       AND mom.message_id = m.message_id
       AND mom.superseded_at IS NULL
       AND mom.mapping_status IN ('unassigned','ambiguous','excluded_multi_open')
  )`;
  const stateFilter = reAttribute
    ? `AND (${missingClause} OR ${reAttrClause})`
    : `AND ${missingClause}`;

  const { rows } = await rawQuery(
    `SELECT m.id, m.message_id, m.contact_id, m.message_timestamp
       FROM messages m
      WHERE m.location_id = $1
        AND m.contact_id IS NOT NULL
        AND m.deleted_at IS NULL
        ${stateFilter}
        ${idFilter}
      ORDER BY m.id
      LIMIT $2`,
    params
  );
  return rows;
}

async function backfillLocation(locationId, { dryRun, reAttribute }) {
  logger.info({ locationId, dryRun, reAttribute }, 'backfillAttribution: starting location');
  let processed = 0;
  let mapped = 0;
  let ambiguous = 0;
  let unassigned = 0;
  let excludedMultiOpen = 0;
  let errors = 0;
  let lastId = null;
  const BATCH_SIZE = 500;

  for (let page = 0; page < 1000; page++) {
    const batch = await fetchUnattributed(locationId, BATCH_SIZE, lastId, reAttribute);
    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        if (dryRun) {
          processed++;
          continue;
        }
        const decision = await attributeMessage({
          locationId,
          messageId: row.message_id,
          contactId: row.contact_id,
          messageTimestamp: row.message_timestamp,
          detectedVia: 'backfill'
        });
        processed++;
        if (!decision) { errors++; continue; }
        if (decision.mappingStatus === 'mapped')                mapped++;
        else if (decision.mappingStatus === 'ambiguous')        ambiguous++;
        else if (decision.mappingStatus === 'unassigned')       unassigned++;
        else if (decision.mappingStatus === 'excluded_multi_open') excludedMultiOpen++;
      } catch (err) {
        errors++;
        logger.warn(
          { err, locationId, messageId: row.message_id },
          'backfillAttribution: message failed — skipped'
        );
      }
    }

    lastId = batch[batch.length - 1].id;
    logger.info(
      { locationId, page: page + 1, processed, mapped, ambiguous, unassigned, excludedMultiOpen, errors },
      'backfillAttribution: batch done'
    );
    if (batch.length < BATCH_SIZE) break;
  }

  logger.info(
    { locationId, processed, mapped, ambiguous, unassigned, excludedMultiOpen, errors, dryRun },
    'backfillAttribution: location complete'
  );
  return { processed, mapped, ambiguous, unassigned, excludedMultiOpen, errors };
}

async function main() {
  const { locations: cli, dryRun, reAttribute } = parseArgs(process.argv);
  const targets = cli.length ? cli : await listAllActiveLocations();

  if (targets.length === 0) {
    logger.warn('backfillAttribution: no locations found');
    return;
  }

  logger.info({ targets, dryRun, reAttribute }, 'backfillAttribution: starting');

  const totals = {
    processed: 0, mapped: 0, ambiguous: 0, unassigned: 0, excludedMultiOpen: 0, errors: 0
  };
  for (const locationId of targets) {
    try {
      const r = await backfillLocation(locationId, { dryRun, reAttribute });
      for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
    } catch (err) {
      logger.error({ err, locationId }, 'backfillAttribution: location failed');
    }
  }

  logger.info({ locations: targets.length, ...totals, dryRun }, 'backfillAttribution: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfillAttribution: failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
