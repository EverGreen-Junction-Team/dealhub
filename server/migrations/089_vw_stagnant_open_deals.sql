-- 089_vw_stagnant_open_deals.sql
--
-- "Which open deals have gone quiet, and where?" — open deals bucketed by how
-- long since anyone touched them, grouped by stage. Built to be exposed to the
-- AI as a skill (see 083).
--
-- Third of the drop-off family:
--   084  vw_close_without_win_by_stage  — where a deal WAS when it closed
--   088  vw_stall_stage_before_close    — where it spent the most TIME
--   089  this one                       — which OPEN deals are going the same way
--
-- The first two are post-mortems. This one is the live list: the deals a rep
-- can still do something about.
--
-- ── LAST TOUCH ───────────────────────────────────────────────────────
-- The most recent of: a message either way, a stage move, a note, a task, or
-- the deal being created. Calls are excluded, matching the source query —
-- call_recordings sync is paused (see orphanSweep), so including them would
-- make coverage depend on when that was switched off.
--
-- created_at_ghl is the floor rather than a fallback: a brand-new deal with
-- no activity is 0 days idle, not infinitely idle.
--
-- ── CHANGES FROM THE SOURCE QUERY ────────────────────────────────────
--
--   1. NO location_id -> brand CASE, and no cross-account grouping — same
--      reasons as 084 and 088. location_id is SELECTED because runSkill's
--      tenant predicate filters on it.
--
--   2. The notes and tasks joins carry location_id. The source joined them on
--      contact_id ALONE, and contact_id is unique per sub-account, not
--      globally (PRIMARY KEY (location_id, contact_id) — 001_schema).
--      One brand's note could therefore set another brand's deal as "touched"
--      — a deal would look active because a different customer was contacted.
--      Silent, and it would make exactly the deals this view exists to surface
--      disappear from it.
--
--   3. Window function partitioned by location_id, per 087's lesson.

CREATE OR REPLACE VIEW vw_stagnant_open_deals
  WITH (security_invoker = true) AS
WITH open_deals AS (
  -- No owner column: this view aggregates BY STAGE, so a per-deal owner has
  -- nowhere to go. The source query carried it for the per-deal variant in
  -- its trailing comment, which is a different question — "which of MY deals
  -- are quiet" is get_rep_performance or a future per-deal view, not this.
  SELECT o.opportunity_id, o.contact_id, o.location_id,
         o.created_at_ghl, o.monetary_value
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
),
last_msg AS (
  SELECT location_id, contact_id, max(message_timestamp) AS t
    FROM messages
   WHERE deleted_at IS NULL
     -- Activity rows are system events (deal created, DND enabled), not
     -- somebody making contact. Counting them would mark a deal touched
     -- because the CRM wrote a log line.
     AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
   GROUP BY 1, 2
),
last_stage AS (
  SELECT location_id, opportunity_id,
         max(entered_at) AS t,
         max(stage_name) FILTER (WHERE current_stage) AS stage_name
    FROM stage_history
   WHERE NOT deleted AND NOT ghost_opportunity
   GROUP BY 1, 2
),
last_note AS (
  SELECT location_id, contact_id, max(created_at_ghl) AS t
    FROM notes WHERE deleted_at IS NULL GROUP BY 1, 2
),
last_task AS (
  SELECT location_id, contact_id, max(COALESCE(completed_at, created_at_ghl)) AS t
    FROM tasks WHERE deleted_at IS NULL GROUP BY 1, 2
),
touch AS (
  SELECT d.*,
         initcap(lower(COALESCE(s.stage_name, '(none)'))) AS stage,
         greatest(
           COALESCE(m.t, '1970-01-01'::timestamptz),
           COALESCE(s.t, '1970-01-01'::timestamptz),
           COALESCE(n.t, '1970-01-01'::timestamptz),
           COALESCE(k.t, '1970-01-01'::timestamptz),
           d.created_at_ghl
         ) AS last_touch
    FROM open_deals d
    LEFT JOIN last_msg   m ON m.contact_id     = d.contact_id     AND m.location_id = d.location_id
    LEFT JOIN last_stage s ON s.opportunity_id = d.opportunity_id AND s.location_id = d.location_id
    LEFT JOIN last_note  n ON n.contact_id     = d.contact_id     AND n.location_id = d.location_id
    LEFT JOIN last_task  k ON k.contact_id     = d.contact_id     AND k.location_id = d.location_id
),
bucketed AS (
  SELECT *, (now()::date - last_touch::date) AS days_idle FROM touch
)
SELECT location_id,
       stage,
       count(*)                                                   AS open_deals,
       count(*) FILTER (WHERE days_idle < 14)                     AS under_14,
       count(*) FILTER (WHERE days_idle BETWEEN 14 AND 29)        AS d14_29,
       count(*) FILTER (WHERE days_idle BETWEEN 30 AND 59)        AS d30_59,
       count(*) FILTER (WHERE days_idle >= 60)                    AS d60_plus,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_idle)::numeric, 0)
         AS median_idle_days,
       -- What is at stake, not just how many. Ten quiet deals worth £400 is a
       -- different morning's work from two worth £180k.
       sum(monetary_value) FILTER (WHERE days_idle >= 30)         AS value_idle_30plus,
       round(100.0 * count(*)
             / NULLIF(sum(count(*)) OVER (PARTITION BY location_id), 0))
         AS pct_of_open
  FROM bucketed
 GROUP BY location_id, stage;

COMMENT ON VIEW vw_stagnant_open_deals IS
  'Open deals grouped by stage and by how long since anyone touched them — a message either way, a stage move, a note, a task, or the deal being created. Answers "which deals have gone quiet" while there is still something a rep can do about it.';

COMMENT ON COLUMN vw_stagnant_open_deals.stage IS
  'The stage these open deals are sitting in now. "(none)" means no stage row has synced for the deal yet.';
COMMENT ON COLUMN vw_stagnant_open_deals.open_deals IS
  'How many open deals are at this stage.';
COMMENT ON COLUMN vw_stagnant_open_deals.under_14 IS
  'Touched within the last fortnight — active, not a concern.';
COMMENT ON COLUMN vw_stagnant_open_deals.d30_59 IS
  'Untouched for a month or more. Usually the first band worth acting on.';
COMMENT ON COLUMN vw_stagnant_open_deals.d60_plus IS
  'Untouched for two months or more. These are the ones that quietly become losses.';
COMMENT ON COLUMN vw_stagnant_open_deals.median_idle_days IS
  'Days since the typical deal at this stage was last touched. A median, so one long-forgotten deal does not distort it.';
COMMENT ON COLUMN vw_stagnant_open_deals.value_idle_30plus IS
  'Total value of the deals at this stage untouched for 30 days or more — what is at stake, not just how many.';
COMMENT ON COLUMN vw_stagnant_open_deals.pct_of_open IS
  'This stage as a percentage of every open deal in this sub-account.';
