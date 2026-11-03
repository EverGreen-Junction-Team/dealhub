// pipelineSnapshot.js — write one row per sub-account per day recording what
// the pipeline looked like.
//
// WHY. opportunities holds CURRENT state. A rep books a task and the row
// changes; the fact that the deal had nothing booked yesterday is gone. So
// "is our no-task rate better than last month?" cannot be answered from the
// data at all — not with a cleverer view, not with a different join. The
// history was never written down.
//
// This job writes it down. Nothing here is retroactive: the first row lands
// the day it first runs, and the first month-over-month comparison is possible
// a month after that.
//
// WHAT DOES NOT BELONG HERE. Anything with a timestamp already on the row —
// won value by month, deals created last quarter, response times since August.
// Those are answered by grouping on won_at / created_at_ghl / message_timestamp
// (see migration 117). Recording them here as well would give one number two
// sources, which is how they come to disagree.
//
// ONE QUERY, NOT TWELVE. Every count comes from a single pass over
// opportunities with FILTER clauses, plus one small query each for notes and
// messages. Running twelve separate counts would be simpler to read and would
// take twelve different instants — on a busy account the totals would not
// reconcile with each other, and nobody would know why.

import cron from 'node-cron';
import { rawQuery, withTenant } from '../db.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';

// Definitions kept identical to the views that answer the same question live,
// so a trend and a current reading never disagree:
//   open_no_task_anywhere  <- vw_open_deals_no_task_by_stage
//   open_no_notes          <- vw_open_deals_note_quality_by_stage
//   open_missing_source    <- vw_rep_field_completeness (brace-stripped)
//   open_stagnant_30d      <- vw_stagnant_open_deals
// EVERY CTE CARRIES location_id = $1 EXPLICITLY.
//
// withTenant() sets app.location_id and there are RLS policies on these tables,
// but the app connects as `postgres`, which has rolbypassrls = true — every
// policy is skipped. Relying on RLS here silently counted every sub-account's
// deals into each account's snapshot: LOC_A's first test row read 4 open deals
// when it had 3, the fourth being LOC_B's. Same failure the skill views carry
// an explicit predicate to avoid (skillStore.runSkill), and the same one the
// source queries kept hitting by joining on a bare opportunity_id.
const SNAPSHOT_SQL = `
WITH od AS (
  SELECT o.opportunity_id, o.location_id, o.contact_id, o.monetary_value,
         o.status, o.client_type, o.product_type, o.lead_source_opportunity,
         o.postcode
    FROM opportunities o
   WHERE o.location_id = $1
     AND o.deleted_at IS NULL AND o.is_ghost = false
),
t AS (
  SELECT location_id, opportunity_id,
         count(*) FILTER (WHERE status = 'open') AS open_tasks
    FROM tasks
   WHERE location_id = $1
     AND deleted_at IS NULL AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
tc AS (
  SELECT location_id, contact_id,
         count(*) FILTER (WHERE status = 'open') AS open_tasks_contact
    FROM tasks
   WHERE location_id = $1
     AND deleted_at IS NULL AND contact_id IS NOT NULL
   GROUP BY location_id, contact_id
),
n AS (
  SELECT location_id, opportunity_id, count(*) AS notes
    FROM notes
   WHERE location_id = $1
     AND deleted_at IS NULL AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
m AS (
  SELECT location_id, contact_id,
         max(message_timestamp) AS last_msg,
         count(*) FILTER (
           WHERE message_direction = 'outbound'
             AND COALESCE(sender_type, '') NOT LIKE 'automation%'
         ) AS human_replies
    FROM messages
   WHERE location_id = $1
     AND deleted_at IS NULL
     AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
   GROUP BY location_id, contact_id
),
j AS (
  SELECT od.*,
         COALESCE(t.open_tasks, 0)          AS open_tasks,
         COALESCE(tc.open_tasks_contact, 0) AS open_tasks_contact,
         COALESCE(n.notes, 0)               AS notes,
         COALESCE(m.human_replies, 0)       AS human_replies,
         m.last_msg
    FROM od
    LEFT JOIN t  ON t.opportunity_id  = od.opportunity_id AND t.location_id  = od.location_id
    LEFT JOIN tc ON tc.contact_id     = od.contact_id     AND tc.location_id = od.location_id
    LEFT JOIN n  ON n.opportunity_id  = od.opportunity_id AND n.location_id  = od.location_id
    LEFT JOIN m  ON m.contact_id      = od.contact_id     AND m.location_id  = od.location_id
)
SELECT
  count(*) FILTER (WHERE status = 'open')                            AS open_deals,
  sum(monetary_value) FILTER (WHERE status = 'open')                 AS open_value,
  count(*) FILTER (WHERE status = 'won')                             AS won_deals_total,
  count(*) FILTER (WHERE status = 'lost')                            AS lost_deals_total,
  count(*) FILTER (WHERE status = 'abandoned')                       AS abandoned_deals_total,

  count(*) FILTER (WHERE status = 'open' AND open_tasks = 0)         AS open_no_task,
  count(*) FILTER (WHERE status = 'open' AND open_tasks = 0
                     AND open_tasks_contact = 0)                     AS open_no_task_anywhere,
  count(*) FILTER (WHERE status = 'open' AND notes = 0)              AS open_no_notes,
  count(*) FILTER (WHERE status = 'open' AND human_replies = 0)      AS open_no_reply,
  count(*) FILTER (WHERE status = 'open'
                     AND last_msg < now() - interval '30 days')      AS open_stagnant_30d,
  sum(monetary_value) FILTER (WHERE status = 'open' AND open_tasks = 0) AS value_no_task,

  count(*) FILTER (WHERE status = 'open'
                     AND COALESCE(monetary_value, 0) = 0)            AS open_missing_value,
  -- '{}' is an EMPTY source, not a filled one — braces stripped before testing.
  count(*) FILTER (WHERE status = 'open'
                     AND NULLIF(btrim(regexp_replace(
                           COALESCE(lead_source_opportunity, ''),
                           '[{}"]', '', 'g')), '') IS NULL)          AS open_missing_source,
  count(*) FILTER (WHERE status = 'open'
                     AND NOT (jsonb_typeof(client_type) = 'array'
                              AND jsonb_array_length(client_type) > 0)) AS open_missing_buyer,
  count(*) FILTER (WHERE status = 'open'
                     AND NOT (jsonb_typeof(product_type) = 'array'
                              AND jsonb_array_length(product_type) > 0)) AS open_missing_product,

  count(*) FILTER (WHERE NULLIF(btrim(postcode), '') IS NOT NULL)    AS deals_with_postcode
FROM j
`;

const NOTES_SQL = `
  SELECT count(*) AS notes_total,
         count(DISTINCT author_user_id) AS note_authors
    FROM notes WHERE location_id = $1 AND deleted_at IS NULL
`;

export async function captureSnapshotForLocation(locationId, { snapshotDate = null } = {}) {
  return withTenant(locationId, async (client) => {
    const { rows: [deal] } = await client.query(SNAPSHOT_SQL, [locationId]);
    const { rows: [notes] } = await client.query(NOTES_SQL, [locationId]);

    // ON CONFLICT DO UPDATE, so re-running replaces the day's reading rather
    // than failing or appending a second one. A re-run after a bad deploy
    // should correct the row, not leave the wrong number in place.
    await client.query(
      `INSERT INTO pipeline_snapshots (
         location_id, snapshot_date,
         open_deals, open_value, won_deals_total, lost_deals_total, abandoned_deals_total,
         open_no_task, open_no_task_anywhere, open_no_notes, open_no_reply,
         open_stagnant_30d, value_no_task,
         open_missing_value, open_missing_source, open_missing_buyer, open_missing_product,
         deals_with_postcode, notes_total, note_authors, captured_at
       ) VALUES (
         $1, COALESCE($2::date, current_date),
         $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now()
       )
       ON CONFLICT (location_id, snapshot_date) DO UPDATE SET
         open_deals            = EXCLUDED.open_deals,
         open_value            = EXCLUDED.open_value,
         won_deals_total       = EXCLUDED.won_deals_total,
         lost_deals_total      = EXCLUDED.lost_deals_total,
         abandoned_deals_total = EXCLUDED.abandoned_deals_total,
         open_no_task          = EXCLUDED.open_no_task,
         open_no_task_anywhere = EXCLUDED.open_no_task_anywhere,
         open_no_notes         = EXCLUDED.open_no_notes,
         open_no_reply         = EXCLUDED.open_no_reply,
         open_stagnant_30d     = EXCLUDED.open_stagnant_30d,
         value_no_task         = EXCLUDED.value_no_task,
         open_missing_value    = EXCLUDED.open_missing_value,
         open_missing_source   = EXCLUDED.open_missing_source,
         open_missing_buyer    = EXCLUDED.open_missing_buyer,
         open_missing_product  = EXCLUDED.open_missing_product,
         deals_with_postcode   = EXCLUDED.deals_with_postcode,
         notes_total           = EXCLUDED.notes_total,
         note_authors          = EXCLUDED.note_authors,
         captured_at           = now()`,
      [
        locationId, snapshotDate,
        deal.open_deals, deal.open_value, deal.won_deals_total,
        deal.lost_deals_total, deal.abandoned_deals_total,
        deal.open_no_task, deal.open_no_task_anywhere, deal.open_no_notes,
        deal.open_no_reply, deal.open_stagnant_30d, deal.value_no_task,
        deal.open_missing_value, deal.open_missing_source,
        deal.open_missing_buyer, deal.open_missing_product,
        deal.deals_with_postcode, notes.notes_total, notes.note_authors
      ]
    );
    return deal;
  });
}

// Every active install. One location failing doesn't stop the others — a
// missed day for one account is a gap in its trend, not a reason to lose the
// day for every account.
export async function captureSnapshotsForAllInstalls({ snapshotDate = null } = {}) {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );

  let captured = 0;
  let failed = 0;
  for (const { location_id: locationId } of rows) {
    try {
      const stats = await captureSnapshotForLocation(locationId, { snapshotDate });
      captured += 1;
      logger.info({ locationId, openDeals: stats.open_deals }, 'pipelineSnapshot: captured');
    } catch (err) {
      failed += 1;
      logger.error({ locationId, err }, 'pipelineSnapshot: location failed');
    }
  }

  await recordSyncRun({
    jobName: 'pipelineSnapshot', objectType: 'pipeline_snapshots',
    scope: 'all', status: failed ? 'partial' : 'success', startedAt,
    stats: { locations: rows.length, captured, failed }
  });
  logger.info({ locations: rows.length, captured, failed }, 'pipelineSnapshot: done');
  return { locations: rows.length, captured, failed };
}

// Own cron, not the daily-sync slot. The snapshot must read the pipeline AFTER
// the syncs have brought it up to date, or it records yesterday's data under
// today's date — a wrong number is worse than a missing one, because nothing
// on the row says it is wrong.
export function startPipelineSnapshotCron(expression = '30 3 * * *') {
  if (!cron.validate(expression)) {
    logger.error({ cron: expression }, 'pipelineSnapshot: invalid cron — snapshots disabled');
    return;
  }
  cron.schedule(expression, async () => {
    try { await captureSnapshotsForAllInstalls(); }
    catch (err) { logger.error({ err }, 'pipelineSnapshot: scheduled run failed'); }
  });
  logger.info({ cron: expression }, 'pipelineSnapshot: daily capture scheduled');
}
