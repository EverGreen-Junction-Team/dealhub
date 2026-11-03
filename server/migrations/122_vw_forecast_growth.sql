-- 122_vw_forecast_growth.sql
--
-- Month-on-month change on the forecast, so "is it growing" is a column
-- rather than arithmetic the model does across two rows it fetched
-- separately — which is where it makes mistakes.
--
-- ── WHY NOT JUST ADD lag() TO 120 ────────────────────────────────────
-- 120 carries an undated row (month IS NULL) holding every open deal with no
-- close date. A window ordered by month would place that row somewhere
-- arbitrary and compute a "change" against it, which is meaningless — it is
-- not a period. Filtering it out inside 120 would mean the skill either loses
-- the undated row or loses the change columns.
--
-- So the change lives here, over the dated months only, and the two skills
-- say which question each answers. 120 for "what is in each month,
-- including what we cannot place"; this for "which way is it moving".
--
-- ── A GAP IS NOT A DROP ──────────────────────────────────────────────
-- lag() steps to the previous ROW, which is the previous month that had
-- anything in it — not necessarily last month. A forecast with nothing in
-- November and something in December would otherwise read as "December is up
-- 100% on November" when the comparison skipped a month entirely.
-- months_since_previous states the gap so an answer can say so.
--
-- ── WHY expected AND won BOTH GET A CHANGE ───────────────────────────
-- They move for different reasons and answer different questions: expected
-- rising means more or better-qualified pipeline landing in that month, won
-- rising means more revenue actually banked. A single "forecast growth"
-- number would blend the two and hide which.

CREATE OR REPLACE VIEW vw_forecast_growth
  WITH (security_invoker = true) AS
WITH months AS (
  -- Dated months only. The undated row is not a period and cannot sit in a
  -- time series — see the header.
  SELECT location_id, month, open_deals, open_value, expected_value,
         won_deals, won_value, total_potential, avg_probability
    FROM vw_forecast_by_month
   WHERE month IS NOT NULL
)
SELECT location_id,
       month,
       to_char(month, 'Mon YYYY')                             AS period,
       open_deals, open_value, expected_value,
       won_deals, won_value, total_potential, avg_probability,

       -- Months between this row and the one it is compared with. 1 is
       -- consecutive; more means the gap was empty and the change spans it.
       (EXTRACT(year FROM month) * 12 + EXTRACT(month FROM month))
       - (EXTRACT(year FROM lag(month) OVER w) * 12
          + EXTRACT(month FROM lag(month) OVER w))             AS months_since_previous,

       expected_value - lag(expected_value) OVER w             AS expected_change,
       round(100.0 * (expected_value - lag(expected_value) OVER w)
             / NULLIF(lag(expected_value) OVER w, 0))          AS expected_change_pct,
       won_value - lag(won_value) OVER w                       AS won_change,
       round(100.0 * (won_value - lag(won_value) OVER w)
             / NULLIF(lag(won_value) OVER w, 0))               AS won_change_pct,
       open_deals - lag(open_deals) OVER w                     AS open_deals_change,

       -- Running total across the series, for "how much is expected between
       -- now and March" without the model adding rows up by hand.
       sum(expected_value) OVER (PARTITION BY location_id ORDER BY month)
                                                               AS expected_cumulative,
       sum(won_value) OVER (PARTITION BY location_id ORDER BY month)
                                                               AS won_cumulative
  FROM months
WINDOW w AS (PARTITION BY location_id ORDER BY month);

COMMENT ON VIEW vw_forecast_growth IS
  'Month-on-month movement in the forecast: how expected and won revenue changed from the previous month that had any, plus running totals. Dated months only — the "no close date" pipeline is in forecast_by_month, not here, because it is not a period and cannot sit in a time series.';

COMMENT ON COLUMN vw_forecast_growth.months_since_previous IS
  'Months between this row and the one it is compared against. 1 means consecutive. Anything larger means the months between were empty and the change spans the whole gap — say so rather than calling it month-on-month growth.';
COMMENT ON COLUMN vw_forecast_growth.expected_change_pct IS
  'Percentage change in weighted open pipeline landing in this month. Moves when deals are added, re-dated or re-probabilitied — it is not a measure of selling, it is a measure of what the forecast now expects.';
COMMENT ON COLUMN vw_forecast_growth.won_change_pct IS
  'Percentage change in revenue actually won. Unlike expected_change_pct this is money banked, and the two routinely move in opposite directions.';
COMMENT ON COLUMN vw_forecast_growth.expected_cumulative IS
  'Expected revenue from the earliest month in the series up to and including this one. Use for "how much between now and March" instead of adding months up.';
