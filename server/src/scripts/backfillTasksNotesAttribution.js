// SUPERSEDED by backfillTaskNoteDeals.js (2026-09-11).
//
// This one calls resolveOppForContact — the LIVE rule — so it judges a
// two-year-old task by today's deal statuses, and nearly everything
// historic comes back unlinked. It also only considers rows where
// opportunity_id IS NULL, so it can fill a gap but never correct a wrong
// link.
//
// Kept for reference, not for running. Use:
//   npm run backfill:task-note-deals
//
// backfillTasksNotesAttribution.js — one-shot re-attribution pass for
// tasks and notes rows that never got an opportunity_id.
//
// Reads every task / note where opportunity_id IS NULL, runs the shared
// attribution engine (same 5 rules + opportunity_contacts lookup that
// messages use), and stamps opportunity_id when the rules land on a
// confident `mapped` decision. Never overwrites an existing link — that's
// GHL's job via associationRefresher.
//
// Usage:
//   node src/scripts/backfillTasksNotesAttribution.js --location fJNu...
//   node src/scripts/backfillTasksNotesAttribution.js                       # all installs
//   node src/scripts/backfillTasksNotesAttribution.js -- --dry-run          # decide but don't write
//   node src/scripts/backfillTasksNotesAttribution.js -- --tasks-only
//   node src/scripts/backfillTasksNotesAttribution.js -- --notes-only

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { resolveOppForContact } from '../services/attributionEngine.js';
import { logger } from '../utils/logger.js';

function parseArgs(argv) {
  const locations = [];
  let dryRun = false;
  let tasksOnly = false;
  let notesOnly = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--location' && argv[i + 1]) locations.push(argv[++i]);
    else if (argv[i] === '--dry-run')   dryRun = true;
    else if (argv[i] === '--tasks-only') tasksOnly = true;
    else if (argv[i] === '--notes-only') notesOnly = true;
  }
  return { locations, dryRun, tasksOnly, notesOnly };
}

async function listAllActiveLocations() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL ORDER BY installed_at ASC`
  );
  return rows.map((r) => r.location_id);
}

// Batched fetch of rows needing attribution.
// table: 'tasks' or 'notes'. Both have (location_id, task_id/note_id,
// contact_id, opportunity_id, created_at_ghl, imported_at).
async function fetchUnattributed(table, locationId, batchSize, lastId) {
  const idCol = table === 'tasks' ? 'task_id' : 'note_id';
  const params = [locationId, batchSize];
  let idFilter = '';
  if (lastId) {
    params.push(lastId);
    idFilter = `AND ${idCol} > $${params.length}`;
  }
  const { rows } = await rawQuery(
    `SELECT ${idCol} AS row_id, contact_id,
            -- The record's OWN creation time, from GHL. Not imported_at:
            -- that is when our sync first saw it, which for a backfilled
            -- row is days or months later (measured: up to 84 days on this
            -- data). Attribution asks "what was true when this happened",
            -- so the wrong timestamp answers a different question.
            --
            -- NULL is passed through rather than substituted. The engine
            -- handles a missing timestamp; a fabricated one would look
            -- authoritative and be wrong.
            created_at_ghl AS at_ts
       FROM ${table}
      WHERE location_id = $1
        AND opportunity_id IS NULL
        AND contact_id IS NOT NULL
        AND status <> 'deleted'
        ${idFilter}
      ORDER BY ${idCol}
      LIMIT $2`,
    params
  );
  return rows;
}

async function backfillTable(table, locationId, { dryRun }) {
  const idCol = table === 'tasks' ? 'task_id' : 'note_id';
  let processed = 0, mapped = 0, skipped = 0, errors = 0;
  let lastId = null;
  const BATCH_SIZE = 500;

  for (let page = 0; page < 1000; page++) {
    const batch = await fetchUnattributed(table, locationId, BATCH_SIZE, lastId);
    if (batch.length === 0) break;

    for (const row of batch) {
      processed++;
      try {
        const decision = await resolveOppForContact(locationId, row.contact_id, row.at_ts);
        if (!decision || decision.mappingStatus !== 'mapped' || !decision.opportunityId) {
          skipped++;
          continue;
        }
        if (!dryRun) {
          await rawQuery(
            `UPDATE ${table}
                SET opportunity_id = $2,
                    updated_at     = now()
              WHERE location_id = $1 AND ${idCol} = $3
                AND opportunity_id IS NULL`,
            [locationId, decision.opportunityId, row.row_id]
          );
        }
        mapped++;
      } catch (err) {
        errors++;
        logger.warn(
          { err, locationId, table, rowId: row.row_id },
          'backfillTasksNotesAttribution: row failed — skipped'
        );
      }
    }

    lastId = batch[batch.length - 1].row_id;
    logger.info(
      { locationId, table, page: page + 1, processed, mapped, skipped, errors },
      'backfillTasksNotesAttribution: batch done'
    );
    if (batch.length < BATCH_SIZE) break;
  }
  return { processed, mapped, skipped, errors };
}

async function backfillLocation(locationId, opts) {
  logger.info({ locationId, ...opts }, 'backfillTasksNotesAttribution: starting location');
  const totals = { tasks: null, notes: null };
  if (!opts.notesOnly) totals.tasks = await backfillTable('tasks', locationId, opts);
  if (!opts.tasksOnly) totals.notes = await backfillTable('notes', locationId, opts);
  logger.info({ locationId, totals }, 'backfillTasksNotesAttribution: location complete');
  return totals;
}

async function main() {
  const { locations, dryRun, tasksOnly, notesOnly } = parseArgs(process.argv);
  const targets = locations.length ? locations : await listAllActiveLocations();

  if (targets.length === 0) {
    logger.warn('backfillTasksNotesAttribution: no locations found');
    return;
  }

  logger.info({ targets, dryRun, tasksOnly, notesOnly }, 'backfillTasksNotesAttribution: starting');
  for (const locationId of targets) {
    try {
      await backfillLocation(locationId, { dryRun, tasksOnly, notesOnly });
    } catch (err) {
      logger.error({ err, locationId }, 'backfillTasksNotesAttribution: location failed');
    }
  }
  logger.info({ locations: targets.length, dryRun }, 'backfillTasksNotesAttribution: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfillTasksNotesAttribution: fatal');
    process.exit(1);
  })
  .finally(() => pool.end());
