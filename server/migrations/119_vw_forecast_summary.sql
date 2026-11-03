-- 119_vw_forecast_summary.sql
--
-- The Forecast Summary strip and the "Fix your forecast data" card, as two
-- views over 118's base.
--
-- ── THE KPI DEFINITIONS ARE GHL'S, INCLUDING THE ODD ONE ─────────────
--   Max potential revenue (bestCase)  = open + won value
--   Expected revenue (weightedForecast) = weighted OPEN only
--   Won revenue (closedWon)           = won value
--   Open opportunities                = count of open
--   Coverage %                        = expected / max potential
--
-- "Max potential" mixing open with won is not a mistake: it is the ceiling
-- for the period — everything already banked plus everything still live. It
-- reads oddly beside "expected", which excludes won entirely, so both are
-- returned with the parts separated (open_value, won_value) rather than
-- leaving a reader to work out which number contains what.
--
-- ── COVERAGE IS PART OF THE ANSWER, NOT A FOOTNOTE ───────────────────
-- Measured on this data: open deals with a close date run 5–15% per
-- sub-account. Every period-based figure describes only that slice. A
-- forecast total quoted without it is not a small overstatement — at 15% it
-- describes a seventh of the pipeline while looking like all of it.
--
-- So pct_with_close_date rides on the summary row itself, and the skill text
-- requires it to be said. Same for probability: a deal with no probability
-- anywhere contributes 0 to expected revenue, which is indistinguishable in
-- the total from a deal assessed as hopeless.

CREATE OR REPLACE VIEW vw_forecast_summary
  WITH (security_invoker = true) AS
SELECT location_id,

       -- ── The four KPIs ─────────────────────────────────────────────
       COALESCE(sum(monetary_value) FILTER (WHERE status IN ('open','won')), 0)
                                                              AS max_potential_revenue,
       COALESCE(sum(weighted_value), 0)                       AS expected_revenue,
       COALESCE(sum(monetary_value) FILTER (WHERE status = 'won'), 0)
                                                              AS won_revenue,
       count(*) FILTER (WHERE status = 'open')                AS open_opportunities,
       round(100.0 * COALESCE(sum(weighted_value), 0)
             / NULLIF(sum(monetary_value) FILTER (WHERE status IN ('open','won')), 0))
                                                              AS weighted_coverage_pct,

       -- The parts, so "max potential" is not mistaken for open pipeline.
       COALESCE(sum(monetary_value) FILTER (WHERE status = 'open'), 0)
                                                              AS open_value,
       round(avg(effective_probability) FILTER (WHERE status = 'open'))
                                                              AS avg_probability,

       -- ── How much of the pipeline these figures actually describe ──
       count(*) FILTER (WHERE status = 'open' AND forecast_close_date IS NOT NULL)
                                                              AS open_with_close_date,
       round(100.0 * count(*) FILTER (WHERE status = 'open'
                                        AND forecast_close_date IS NOT NULL)
             / NULLIF(count(*) FILTER (WHERE status = 'open'), 0))
                                                              AS pct_with_close_date,
       count(*) FILTER (WHERE no_probability_anywhere)        AS open_without_probability,
       round(100.0 * count(*) FILTER (WHERE no_probability_anywhere)
             / NULLIF(count(*) FILTER (WHERE status = 'open'), 0))
                                                              AS pct_without_probability,
       -- Value sitting on deals that contribute nothing to expected revenue
       -- because no probability exists — not because they were judged weak.
       COALESCE(sum(monetary_value) FILTER (WHERE no_probability_anywhere), 0)
                                                              AS value_without_probability
  FROM vw_forecast_base
 GROUP BY location_id;

COMMENT ON VIEW vw_forecast_summary IS
  'The Forecast KPI strip: max potential revenue, expected (weighted) revenue, won revenue and open count, with the coverage figures that say how much of the pipeline those numbers actually describe. One row per sub-account.';

COMMENT ON COLUMN vw_forecast_summary.max_potential_revenue IS
  'Open value plus won value — the ceiling. Deliberately includes won, unlike expected_revenue, which is open only. Quote open_value when the question is about live pipeline.';
COMMENT ON COLUMN vw_forecast_summary.expected_revenue IS
  'Open value weighted by each deal''s effective probability. Deals with no probability anywhere contribute nothing, so a low figure can mean unset probabilities rather than a weak pipeline — check pct_without_probability.';
COMMENT ON COLUMN vw_forecast_summary.pct_with_close_date IS
  'Share of open deals carrying an expected close date. EVERY period-based forecast describes only these deals. Measured in the 5-15% range here, so this is the first number to say, not the last.';
COMMENT ON COLUMN vw_forecast_summary.value_without_probability IS
  'Open value on deals with no probability from either the deal or its stage. This money is invisible in expected_revenue — a setup gap, not a forecast of zero.';

-- ─────────────────────────────────────────────────────────────────────
-- "Fix your forecast data" — the three checks GHL runs, plus the one it
-- does not.
--
-- GHL checks missing close date, missing value, and overdue. It does not
-- check for a missing probability, because its auto-stage-probability
-- fallback invents one. We do not invent, so an unset probability silently
-- zeroes a deal's contribution — which makes it the MOST valuable check
-- here, not an extra.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_forecast_readiness
  WITH (security_invoker = true) AS
WITH checks AS (
  SELECT location_id, 'No expected close date' AS issue, 1 AS severity,
         count(*) AS deals, COALESCE(sum(monetary_value), 0) AS value_affected
    FROM vw_forecast_base WHERE missing_close_date GROUP BY location_id
  UNION ALL
  SELECT location_id, 'No probability set', 2,
         count(*), COALESCE(sum(monetary_value), 0)
    FROM vw_forecast_base WHERE no_probability_anywhere GROUP BY location_id
  UNION ALL
  SELECT location_id, 'No deal value', 3,
         count(*), 0
    FROM vw_forecast_base WHERE missing_value GROUP BY location_id
  UNION ALL
  SELECT location_id, 'Close date already passed', 4,
         count(*), COALESCE(sum(monetary_value), 0)
    FROM vw_forecast_base WHERE overdue_close_date GROUP BY location_id
),
totals AS (
  SELECT location_id, count(*) FILTER (WHERE status = 'open') AS open_deals
    FROM vw_forecast_base GROUP BY location_id
)
SELECT c.location_id, c.issue, c.deals, c.value_affected,
       t.open_deals,
       round(100.0 * c.deals / NULLIF(t.open_deals, 0))       AS pct_of_open,
       -- What it costs: which forecast number this issue breaks.
       CASE c.issue
         WHEN 'No expected close date'    THEN 'Invisible to every period forecast — not in any month or quarter'
         WHEN 'No probability set'        THEN 'Contributes nothing to expected revenue'
         WHEN 'No deal value'             THEN 'Contributes nothing to any revenue figure'
         WHEN 'Close date already passed' THEN 'Inflates a period that has already ended'
       END                                                    AS consequence,
       c.severity
  FROM checks c
  JOIN totals t ON t.location_id = c.location_id
 WHERE c.deals > 0;

COMMENT ON VIEW vw_forecast_readiness IS
  'What is stopping the forecast being accurate, one row per issue, with how many deals and how much value each affects and which figure it breaks. Read this BEFORE quoting any forecast number — at low close-date coverage the forecast describes a fraction of the pipeline.';

COMMENT ON COLUMN vw_forecast_readiness.consequence IS
  'Which forecast figure this issue breaks. The point of the row: "214 deals have no close date" matters because those deals appear in no month and no quarter, not because the field is empty.';
COMMENT ON COLUMN vw_forecast_readiness.value_affected IS
  'Total deal value carrying this issue. Usually the number worth acting on — 20 deals worth 400k with no close date is a bigger problem than 80 worth 12k.';
