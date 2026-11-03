-- 090_vw_lead_volume_for_hiring.sql
--
-- "How many leads a month would a new sales hire need?" — the three DATA
-- inputs to that sum, per month. Built to be exposed to the AI as a skill
-- (see 083).
--
-- ── WHAT THIS DOES AND DOES NOT ANSWER ───────────────────────────────
-- It does NOT compute leads-needed. That sum is
--
--   leads needed = (monthly rep cost + target contribution)
--                / (won_per_lead × avg_won_value × gross_margin)
--
-- and two of those five terms — rep cost and gross margin — are commercial
-- inputs nobody has told this database. A view that guessed them would
-- produce a confident number built on invented assumptions, which is worse
-- than no number. So it supplies the three terms the CRM actually knows and
-- leaves the arithmetic to whoever owns the other two.
--
-- The AI is told the same thing in the skill's description: give the inputs,
-- ask for cost and margin, then do the sum.
--
-- ── SHAPE ────────────────────────────────────────────────────────────
-- One row per completed month, with the all-time conversion and average won
-- value repeated on each. The monthly rows are the point: an average alone
-- hides a brand whose lead flow is falling, and "can we support a hire" is
-- exactly the question where a trend matters more than a mean.
--
-- Only COMPLETE months. The current month is partial, and a half-month of
-- leads read as a monthly figure understates volume by up to half — in a
-- number someone is using to justify a salary.
--
-- ── CHANGES FROM THE SOURCE QUERY ────────────────────────────────────
--   1. No location_id -> brand CASE, no cross-account join. location_id is
--      selected because runSkill's tenant predicate filters on it.
--   2. The monthly/overall join carries location_id — without it, one
--      brand's all-time conversion would be stamped onto another's months.
--      The source joined on location_id already; kept and made explicit.
--   3. Window functions partitioned by location_id, per 087's lesson.

CREATE OR REPLACE VIEW vw_lead_volume_for_hiring
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id, o.status, o.created_at_ghl, o.monetary_value,
         date_trunc('month', o.created_at_ghl) AS mth
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     -- A deal with no creation date cannot be placed in a month, and
     -- date_trunc(NULL) would silently become its own bucket.
     AND o.created_at_ghl IS NOT NULL
),
monthly AS (
  SELECT location_id, mth,
         count(*)                                              AS leads,
         count(*) FILTER (WHERE status = 'won')                AS won,
         sum(monetary_value) FILTER (WHERE status = 'won')     AS won_value
    FROM d
   WHERE mth >= date_trunc('month', now()) - interval '4 months'
     AND mth <  date_trunc('month', now())
   GROUP BY 1, 2
),
overall AS (
  SELECT location_id,
         count(*)                               AS all_time_leads,
         count(*) FILTER (WHERE status = 'won') AS all_time_won,
         -- Average of deals that carry a value. A won deal recorded at £0 is
         -- almost always a missing figure rather than a free job, and
         -- including it drags the average down for every calculation built
         -- on top of it.
         round(avg(monetary_value) FILTER (WHERE status = 'won' AND monetary_value > 0))
           AS avg_won_value,
         count(*) FILTER (WHERE status = 'won' AND monetary_value > 0)
           AS won_with_value
    FROM d
   GROUP BY 1
)
SELECT m.location_id,
       to_char(m.mth, 'YYYY-MM')                       AS month,
       m.leads,
       m.won                                           AS won_that_month,
       m.won_value                                     AS won_value_that_month,
       o.avg_won_value,
       o.won_with_value,
       round(100.0 * o.all_time_won / NULLIF(o.all_time_leads, 0), 1)
         AS won_per_lead_pct_all_time,
       -- Repeated on every row so a summary line needs no arithmetic, and
       -- partitioned so it means THIS sub-account.
       round(avg(m.leads) OVER (PARTITION BY m.location_id))
         AS avg_leads_per_month
  FROM monthly m
  JOIN overall o
    ON o.location_id = m.location_id;

COMMENT ON VIEW vw_lead_volume_for_hiring IS
  'Monthly lead volume, wins and won value for the last four complete months, with all-time conversion and average won value. The three CRM inputs to "how many leads would a new hire need" — rep cost and gross margin are not in this database and must be supplied.';

COMMENT ON COLUMN vw_lead_volume_for_hiring.month IS
  'A complete calendar month. The current month is excluded: a partial month read as a monthly figure understates lead volume.';
COMMENT ON COLUMN vw_lead_volume_for_hiring.leads IS
  'Deals created that month — the lead volume for the period.';
COMMENT ON COLUMN vw_lead_volume_for_hiring.avg_won_value IS
  'Average value of a won deal, all time, counting only deals that carry a value. A won deal recorded at zero is treated as a missing figure rather than a free job.';
COMMENT ON COLUMN vw_lead_volume_for_hiring.won_per_lead_pct_all_time IS
  'Percentage of all leads that were eventually won, all time. All time rather than recent, because a few months of wins is too small a base to plan a salary against.';
COMMENT ON COLUMN vw_lead_volume_for_hiring.avg_leads_per_month IS
  'Average leads per month across the months shown. The same on every row of that account.';
