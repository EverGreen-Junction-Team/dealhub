-- 088_vw_stall_stage_before_close.sql
--
-- "Where do deals sit before they die?" — for each lost or abandoned deal,
-- the stage it spent longest in, aggregated per stage. Built to be exposed to
-- the AI as a skill (see 083).
--
-- Companion to vw_close_without_win_by_stage (084). That one answers WHERE a
-- deal was when it closed; this answers where it STALLED. They differ more
-- often than you would expect: a deal can sit in Waiting On Details for
-- three months, move to Quote Sent, and be marked lost a day later. The first
-- view blames Quote Sent; this one blames Waiting On Details, and for a
-- "where are we losing momentum" question this is the honest answer.
--
-- ── CHANGES FROM THE SOURCE QUERY ────────────────────────────────────
--
--   1. NO location_id -> brand CASE. It goes stale the day a fifth location
--      is added and puts customer names in schema. The caller already knows
--      which sub-account it is in.
--
--   2. NO cross-account grouping. Every AI query runs inside withTenant(),
--      and runSkill adds `location_id = $n` on top — a view reporting four
--      brands would return one brand's rows with percentages computed over a
--      partition that has already been filtered.
--
--   3. location_id is SELECTED, because the skill's tenant predicate filters
--      on it. skillValidator refuses a view without it.
--
-- ── WINDOW FUNCTIONS ARE PARTITIONED ─────────────────────────────────
-- Learned the hard way in 086/087: a bare OVER() sums the whole result set,
-- which under RLS is one sub-account and without RLS is all of them. This
-- database's app role has rolbypassrls = true, so the unpartitioned version
-- reported every brand's total and every percentage was wrong by a factor of
-- two. PARTITION BY location_id means what the column names claim, whichever
-- role is connected.

CREATE OR REPLACE VIEW vw_stall_stage_before_close
  WITH (security_invoker = true) AS
WITH closed AS (
  SELECT o.opportunity_id, o.status, o.location_id,
         COALESCE(o.lost_at, o.abandoned_at) AS closed_at
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status IN ('lost', 'abandoned')
     -- A deal with no close timestamp cannot have its time-in-stage capped,
     -- so every duration would run to now() and read as a years-long stall.
     AND COALESCE(o.lost_at, o.abandoned_at) IS NOT NULL
),
durations AS (
  SELECT s.opportunity_id,
         c.location_id,
         initcap(lower(s.stage_name)) AS stage_name,
         -- Capped at the close date: a final-stage row has no left_at, so
         -- without the cap it would run to now() and grow every day the
         -- report is re-run.
         sum(EXTRACT(EPOCH FROM
               least(COALESCE(s.left_at, c.closed_at), c.closed_at) - s.entered_at
             )) / 86400.0 AS days_in_stage
    FROM stage_history s
    JOIN closed c
      ON c.opportunity_id = s.opportunity_id
     -- Joined on location too: opportunity_id is unique per sub-account, not
     -- globally, so this join without it would be silently cross-tenant.
     AND c.location_id = s.location_id
   WHERE NOT s.deleted
     AND NOT s.ghost_opportunity
     AND COALESCE(s.closed_reason, '') <> 'correction'
     AND s.entered_at IS NOT NULL
     AND s.entered_at <= c.closed_at
   GROUP BY s.opportunity_id, c.location_id, 3
),
longest AS (
  SELECT DISTINCT ON (opportunity_id)
         opportunity_id, location_id, stage_name, days_in_stage
    FROM durations
   ORDER BY opportunity_id, days_in_stage DESC
)
SELECT c.location_id,
       l.stage_name,
       count(*)                                        AS deals,
       count(*) FILTER (WHERE c.status = 'lost')       AS lost,
       count(*) FILTER (WHERE c.status = 'abandoned')  AS abandoned,
       -- Median, not mean: one deal parked for two years drags an average
       -- into uselessness, and the question is what a TYPICAL stalled deal
       -- looks like.
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.days_in_stage)::numeric, 1)
         AS median_days,
       -- The tail. A median of 12 days with a p90 of 200 is a different
       -- problem from a median of 12 with a p90 of 20.
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY l.days_in_stage)::numeric, 1)
         AS p90_days,
       -- Deals that died the same day they arrived. Mostly junk clearing
       -- rather than lost sales — worth seeing separately so it does not read
       -- as a stage problem.
       count(*) FILTER (WHERE l.days_in_stage < 1)     AS under_1_day,
       round(100.0 * count(*)
             / NULLIF(sum(count(*)) OVER (PARTITION BY c.location_id), 0))
         AS pct_of_closed
  FROM longest l
  JOIN closed c
    ON c.opportunity_id = l.opportunity_id
   AND c.location_id = l.location_id
 GROUP BY c.location_id, l.stage_name;

COMMENT ON VIEW vw_stall_stage_before_close IS
  'For each deal that was lost or abandoned, the stage it spent longest in — with how many deals stalled there, the lost/abandoned split, and how long a typical one sat. Answers "where do deals lose momentum", which is not always the stage they were in when they closed.';

COMMENT ON COLUMN vw_stall_stage_before_close.stage_name IS
  'The stage this deal spent the most total time in before it closed. Not necessarily the stage it was in when it was marked lost.';
COMMENT ON COLUMN vw_stall_stage_before_close.deals IS
  'How many closed deals stalled longest at this stage.';
COMMENT ON COLUMN vw_stall_stage_before_close.median_days IS
  'Days the typical deal sat at this stage. A median rather than an average, so one deal parked for two years does not distort it.';
COMMENT ON COLUMN vw_stall_stage_before_close.p90_days IS
  'Nine in ten stalled deals sat here for less than this. A large gap from the median means a long tail of deals nobody closed out.';
COMMENT ON COLUMN vw_stall_stage_before_close.under_1_day IS
  'Deals that closed the same day they reached this stage — usually junk being cleared rather than a sale lost, so worth reading apart from the rest.';
COMMENT ON COLUMN vw_stall_stage_before_close.pct_of_closed IS
  'This stage as a percentage of every deal this sub-account closed without a win.';
