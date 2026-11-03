// Backfill every deal a task is linked to, from GHL's own relations array.
//
// WHY THIS IS NEEDED. task_relations (migration 066) is populated by
// RelationCreate webhooks and by the TaskCreate payload. Neither covers a link
// made BEFORE those paths existed, so an existing task shows one deal however
// many it really has.
//
// WHICH ENDPOINT. Established by probing the live API, not from the docs:
//
//   GET  /locations/{locationId}/tasks/{taskId}   → 200, FULL relations  ← this
//   GET  /associations/relations/{taskId}         → 200 but relations: []
//   POST /locations/{locationId}/tasks/search     → task found, NO relations
//   GET  /contacts/{contactId}/tasks/{taskId}     → 200, basic task, no relations
//
// Task relations live ON the task document rather than in GHL's relations
// collection, which is why the associations API returns nothing for them and
// why only the location-scoped single-task read carries them.
//
// Scope: locations/tasks.readonly. Version: 2021-07-28 (the app default) —
// this is NOT one of the v3 note paths.
//
// Run: node src/scripts/backfillTaskRelations.js [--location=<id>] [--dry-run]

import { rawQuery } from '../db.js';
import { ghlRequest } from '../services/ghlClient.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const onlyLocation = args.find((a) => a.startsWith('--location='))?.split('=')[1] || null;
const dryRun = args.includes('--dry-run');

// One request per task, so this is paced rather than parallel: a sub-account
// with thousands of tasks would otherwise hit GHL's rate limit and abort
// halfway, leaving the table half-migrated.
const DELAY_MS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function installs() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs
      WHERE uninstalled_at IS NULL
        AND reauth_required_at IS NULL
        ${onlyLocation ? 'AND location_id = $1' : ''}
      ORDER BY location_id`,
    onlyLocation ? [onlyLocation] : []
  );
  return rows.map((r) => r.location_id);
}

async function installFor(locationId) {
  const { rows } = await rawQuery(
    'SELECT * FROM installs WHERE location_id = $1 LIMIT 1',
    [locationId]
  );
  return rows[0] || null;
}

async function tasksFor(locationId) {
  const { rows } = await rawQuery(
    `SELECT task_id, opportunity_id FROM tasks
      WHERE location_id = $1 AND deleted_at IS NULL
      ORDER BY updated_at DESC NULLS LAST`,
    [locationId]
  );
  return rows;
}

function opportunityIds(task) {
  const rels = Array.isArray(task?.relations) ? task.relations : null;
  if (!rels) return null; // no relations array = no information
  const out = [];
  for (const r of rels) {
    if (r?.objectKey !== 'opportunity') continue;
    const id = r.recordId;
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  }
  return out;
}

async function run() {
  const locations = await installs();
  if (!locations.length) {
    console.log('No active installs to process.');
    console.log('(An install marked reauth_required is skipped — clear it first.)');
    return;
  }

  for (const locationId of locations) {
    const install = await installFor(locationId);
    if (!install) continue;
    const rows = await tasksFor(locationId);
    console.log(`\n${locationId}: ${rows.length} live tasks`);

    let read = 0, multi = 0, added = 0, noArray = 0, failed = 0;

    for (const row of rows) {
      try {
        const { data } = await ghlRequest(install, {
          method: 'GET',
          url: `/locations/${encodeURIComponent(locationId)}/tasks/${encodeURIComponent(row.task_id)}`,
          // A 401 here means the scope is missing for THIS endpoint. It must
          // not mark the install reauth_required — that halts every sync for
          // the location, which is exactly what a note-relations 401 did.
          scopeOptional: true
        });
        read += 1;
        const task = data?.task || data;
        const ids = opportunityIds(task);
        if (ids === null) { noArray += 1; continue; }
        if (ids.length > 1) multi += 1;
        if (!ids.length) continue;

        if (dryRun) {
          if (ids.length > 1) console.log(`  ${row.task_id}: ${ids.length} deals — ${ids.join(', ')}`);
          continue;
        }

        // Same shape as taskWriter's mirror, including the NOT EXISTS guard:
        // a webhook's real relation_id and our synthetic one are different
        // keys for the same link, so ON CONFLICT alone produced two rows for
        // one deal.
        const res = await rawQuery(
          `INSERT INTO task_relations (
             location_id, relation_id, task_id, opportunity_id,
             association_id, last_seen_via, raw_relation, imported_at, updated_at
           )
           SELECT $1, 'payload:' || $2 || ':' || o, $2, o,
                  'TASK_OPPORTUNITY_ASSOCIATION', 'backfill:task-read', NULL, now(), now()
             FROM unnest($3::text[]) AS o
            WHERE NOT EXISTS (
              SELECT 1 FROM task_relations ex
               WHERE ex.location_id    = $1
                 AND ex.task_id        = $2
                 AND ex.opportunity_id = o
            )
           ON CONFLICT (location_id, relation_id) DO NOTHING`,
          [locationId, row.task_id, ids]
        );
        added += res.rowCount || 0;

        // Adopt a primary for a task that had none. COALESCE, so a task that
        // already has one keeps it — nine call sites read that column as "the"
        // deal and changing it would move the task under a different deal.
        await rawQuery(
          `UPDATE tasks SET opportunity_id = COALESCE(opportunity_id, $3)
            WHERE location_id = $1 AND task_id = $2`,
          [locationId, row.task_id, ids[0]]
        );
      } catch (err) {
        failed += 1;
        // GHL's own words. A generic message here would hide whether this is a
        // missing scope, a deleted task, or a rate limit.
        logger.warn({ err, locationId, taskId: row.task_id }, 'backfillTaskRelations: task read failed');
        if (err?.code === 'GHL_SCOPE_MISSING') {
          console.log('  stopping this location: the app lacks locations/tasks.readonly for it');
          break;
        }
      }
      await sleep(DELAY_MS);
    }

    console.log(`  read ${read}, ${multi} with more than one deal, `
      + `${dryRun ? '0 (dry run)' : added} relation rows added, `
      + `${noArray} without a relations array, ${failed} failed`);
  }

  if (dryRun) console.log('\nDry run — nothing was written.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'backfillTaskRelations failed'); process.exit(1); });
