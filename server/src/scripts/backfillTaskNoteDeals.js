// Re-link every task and note to a deal, using the rule agreed 2026-09-08.
// See docs/MESSAGE-DEAL-LINKING-RULE.md.
//
// SAME RULE AS MESSAGES, same point-in-time exception.
//
// The live rule asks "which of the contact's deals is Open?". For a task
// created months ago that answers almost nothing — most of those deals are
// now Won or Lost, so nearly every historic record would end up unlinked.
//
// So this asks the question AS AT THE RECORD'S OWN DATE. A deal was open then
// when:
//   1. it was created on or before that date, AND
//   2. it had not yet been Won / Lost / Abandoned — still open now, or its
//      first terminal event came after that date
//
// One match links, several link to the earliest-created, none leaves it
// unlinked.
//
// WHY NOT THE EXISTING backfillTasksNotesAttribution.js. That one calls
// resolveOppForContact — the LIVE rule — so it judges a two-year-old task by
// today's deal statuses. It also only looks at rows where opportunity_id IS
// NULL, so it can fill a gap but never correct a wrong link. This replaces it.
//
// TASKS KEEP THEIR GHL RELATIONS. A task whose deal came from GHL's own
// `relations` array (taskWriter mirrors those on every TaskCreate) is left
// alone — GHL is authoritative when it says anything at all, and this script
// only fills the silence.
//
// Run: node src/scripts/backfillTaskNoteDeals.js [--location=<id>] [--dry-run]

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const onlyLocation = args.find((a) => a.startsWith('--location='))?.split('=')[1] || null;
const dryRun = args.includes('--dry-run');

// Identical to the message backfill's query, deliberately: one rule, and a
// second copy that drifted would be worse than the duplication.
const OPEN_AT_SQL = `
  SELECT o.opportunity_id
    FROM opportunities o
   WHERE o.location_id = $1
     AND o.contact_id  = $2
     AND o.is_deleted = false
     AND o.deleted_at IS NULL
     AND o.created_at_ghl IS NOT NULL
     AND o.created_at_ghl <= $3
     AND (
           o.status = 'open'
           OR LEAST(
                COALESCE(o.won_at,       'infinity'::timestamptz),
                COALESCE(o.lost_at,      'infinity'::timestamptz),
                COALESCE(o.abandoned_at, 'infinity'::timestamptz)
              ) > $3
         )
   ORDER BY o.created_at_ghl ASC, o.opportunity_id ASC`;

// Every row, not only the unlinked ones — this must be able to CORRECT a
// wrong link, not merely fill a blank. created_at_ghl only: imported_at is
// our sync date, which on this data runs up to 84 days later.
const candidates = (table, idCol) => `
  SELECT ${idCol} AS row_id, contact_id, opportunity_id AS current_opp,
         created_at_ghl AS at_ts
    FROM ${table}
   WHERE location_id = $1
     AND contact_id IS NOT NULL
     AND created_at_ghl IS NOT NULL
     AND status <> 'deleted'
     AND deleted_at IS NULL
   ORDER BY created_at_ghl ASC`;

async function locations() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs
      WHERE uninstalled_at IS NULL
        ${onlyLocation ? 'AND location_id = $1' : ''}
      ORDER BY location_id`,
    onlyLocation ? [onlyLocation] : []
  );
  return rows.map((r) => r.location_id);
}

// A task whose deal GHL itself reported. task_relations rows written from a
// TaskCreate payload carry last_seen_via 'task-payload', and a real
// RelationCreate webhook carries 'webhook' — either way GHL said so, and we
// do not overrule it.
async function ghlLinkedTasks(locationId) {
  const { rows } = await rawQuery(
    `SELECT DISTINCT task_id FROM task_relations
      WHERE location_id = $1
        AND last_seen_via IN ('webhook', 'task-payload')`,
    [locationId]
  );
  return new Set(rows.map((r) => r.task_id));
}

async function run() {
  const locs = await locations();
  if (!locs.length) { console.log('No active installs.'); return; }

  const grand = { seen: 0, changed: 0, linked: 0, unlinked: 0, unchanged: 0, skippedGhl: 0 };

  for (const locationId of locs) {
    console.log(`\n${locationId}`);
    const ghlTasks = await ghlLinkedTasks(locationId);

    for (const [table, idCol] of [['tasks', 'task_id'], ['notes', 'note_id']]) {
      const { rows } = await rawQuery(candidates(table, idCol), [locationId]);
      const tally = { changed: 0, linked: 0, unlinked: 0, unchanged: 0, skipped: 0, multi: 0 };

      for (const r of rows) {
        grand.seen += 1;

        if (table === 'tasks' && ghlTasks.has(r.row_id)) {
          tally.skipped += 1; grand.skippedGhl += 1; continue;
        }

        const { rows: open } = await rawQuery(OPEN_AT_SQL, [locationId, r.contact_id, r.at_ts]);
        const chosen = open[0]?.opportunity_id || null;
        if (open.length > 1) tally.multi += 1;

        if ((chosen || null) === (r.current_opp || null)) {
          tally.unchanged += 1; grand.unchanged += 1; continue;
        }

        tally.changed += 1; grand.changed += 1;
        if (chosen) { tally.linked += 1; grand.linked += 1; }
        else { tally.unlinked += 1; grand.unlinked += 1; }

        if (!dryRun) {
          try {
            await rawQuery(
              `UPDATE ${table} SET opportunity_id = $3, updated_at = now()
                WHERE location_id = $1 AND ${idCol} = $2`,
              [locationId, r.row_id, chosen]
            );
          } catch (err) {
            logger.warn({ err, locationId, table, rowId: r.row_id },
              'backfillTaskNoteDeals: could not update');
          }
        }
      }

      console.log(
        `  ${table.padEnd(6)} ${rows.length} considered · changed ${tally.changed} `
        + `(${tally.linked} linked, ${tally.unlinked} unlinked) · `
        + `${tally.unchanged} already correct · ${tally.multi} had 2+ deals open`
        + (tally.skipped ? ` · ${tally.skipped} left to GHL` : '')
      );
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`  considered      ${grand.seen}`);
  console.log(`  already correct ${grand.unchanged}`);
  console.log(`  changed         ${grand.changed}`);
  console.log(`    → linked      ${grand.linked}`);
  console.log(`    → unlinked    ${grand.unlinked}`);
  if (grand.skippedGhl) console.log(`  left to GHL     ${grand.skippedGhl} (tasks GHL itself linked)`);
  console.log(dryRun ? '\nDRY RUN — nothing was written.' : '\nApplied.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'backfillTaskNoteDeals failed'); process.exit(1); });
