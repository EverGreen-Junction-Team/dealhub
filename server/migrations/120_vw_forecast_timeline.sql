-- 120_vw_forecast_timeline.sql
--
-- The Forecast timeline: open deals bucketed by the month they are expected
-- to close, with won revenue banked in that same month alongside.
--
-- ── THE COVERAGE PROBLEM IS BUILT INTO THIS VIEW ─────────────────────
-- A period column can only hold deals that HAVE an expected close date, and
-- here that is 5-15% of open deals per sub-account. GHL solves this with a
-- visible "No close date" column beside the dated ones, so the omitted deals
-- are on screen rather than merely absent.
--
-- A view has no columns to put beside each other, and a chat answer can drop
-- a caveat far more easily than a UI can hide a column. So the undated deals
-- are a ROW — month = NULL, labelled '(no close date)' — in the same result.
-- Anyone reading the months sees it; anyone summing the months includes it.
-- Every row also carries pct_of_open_dated, so a single month can be read
-- against how much of the pipeline is datable at all.
--
-- Without that, a quarter reading "£180k expected" from 55 of 379 deals looks
-- like a forecast and is a sample.
--
-- ── MONTHS, NOT WEEKS OR QUARTERS ────────────────────────────────────
-- GHL offers week / month / quarter as a UI toggle. A view has no toggle, and
-- three views over the same data would be three skills the model picks between
-- badly. Month is the unit people forecast in, and the AI can total months
-- into a quarter — it cannot split a quarter into months.
--
-- ── won_at FOR THE WON SIDE ──────────────────────────────────────────
-- GHL buckets won deals by last_status_change_date; we do not sync that, and
-- won_at (027) is the same moment for a won deal. Deliberately NOT the
-- expected close date: a deal won in March that was forecast for January
-- counts as March revenue, which is when the money arrived.

CREATE OR REPLACE VIEW vw_forecast_by_month
  WITH (security_invoker = true) AS
WITH dated AS (
  -- Open deals that CAN be placed in a period.
  SELECT location_id,
         date_trunc('month', forecast_close_date)::date       AS month,
         count(*)                                             AS open_deals,
         COALESCE(sum(monetary_value), 0)                     AS open_value,
         COALESCE(sum(weighted_value), 0)                     AS expected_value,
         round(avg(effective_probability))                    AS avg_probability,
         count(*) FILTER (WHERE overdue_close_date)           AS overdue_deals,
         0::bigint                                            AS won_deals,
         0::numeric                                           AS won_value
    FROM vw_forecast_base
   WHERE status = 'open' AND forecast_close_date IS NOT NULL
   GROUP BY location_id, date_trunc('month', forecast_close_date)::date
),
won AS (
  -- Revenue banked in the month, by when it was won.
  SELECT location_id,
         date_trunc('month', won_at)::date                    AS month,
         0::bigint, 0::numeric, 0::numeric, NULL::numeric, 0::bigint,
         count(*)                                             AS won_deals,
         COALESCE(sum(monetary_value), 0)                     AS won_value
    FROM vw_forecast_base
   WHERE status = 'won' AND won_at IS NOT NULL
   GROUP BY location_id, date_trunc('month', won_at)::date
),
undated AS (
  -- The deals no period can hold. A row, not an omission.
  SELECT location_id,
         NULL::date                                           AS month,
         count(*)                                             AS open_deals,
         COALESCE(sum(monetary_value), 0)                     AS open_value,
         COALESCE(sum(weighted_value), 0)                     AS expected_value,
         round(avg(effective_probability))                    AS avg_probability,
         0::bigint                                            AS overdue_deals,
         0::bigint                                            AS won_deals,
         0::numeric                                           AS won_value
    FROM vw_forecast_base
   WHERE status = 'open' AND forecast_close_date IS NULL
   GROUP BY location_id
),
merged AS (
  SELECT location_id, month,
         sum(open_deals)     AS open_deals,
         sum(open_value)     AS open_value,
         sum(expected_value) AS expected_value,
         max(avg_probability) AS avg_probability,
         sum(overdue_deals)  AS overdue_deals,
         sum(won_deals)      AS won_deals,
         sum(won_value)      AS won_value
    FROM (SELECT * FROM dated UNION ALL SELECT * FROM won UNION ALL SELECT * FROM undated) u
   GROUP BY location_id, month
)
SELECT location_id,
       month,
       COALESCE(to_char(month, 'Mon YYYY'), '(no close date)') AS period,
       open_deals, open_value, expected_value, avg_probability,
       overdue_deals, won_deals, won_value,
       expected_value + won_value                             AS total_potential,
       (month IS NULL)                                        AS is_undated,
       -- How much of the account's open pipeline is datable at all. The same
       -- on every row: a month means little without it.
       sum(open_deals) FILTER (WHERE month IS NOT NULL)
         OVER (PARTITION BY location_id)                      AS account_dated_deals,
       sum(open_deals) FILTER (WHERE month IS NULL)
         OVER (PARTITION BY location_id)                      AS account_undated_deals,
       round(100.0 * sum(open_deals) FILTER (WHERE month IS NOT NULL)
             OVER (PARTITION BY location_id)
             / NULLIF(sum(open_deals) OVER (PARTITION BY location_id), 0))
                                                              AS pct_of_open_dated
  FROM merged;

COMMENT ON VIEW vw_forecast_by_month IS
  'Forecast by month: open deals weighted by probability in the month they are expected to close, with revenue won in that month alongside. Open deals with NO close date appear as their own row ("(no close date)") rather than being dropped — at the coverage seen here they are the majority, and a month total read without them describes a fraction of the pipeline.';

COMMENT ON COLUMN vw_forecast_by_month.period IS
  'The month, or "(no close date)" for open deals that have none. That row is not a period and must never be presented as one — it is the pipeline the forecast cannot see.';
COMMENT ON COLUMN vw_forecast_by_month.pct_of_open_dated IS
  'Share of this account''s open deals that carry a close date, repeated on every row. The confidence figure for every month below it: at 15%, a month total describes a seventh of the pipeline.';
COMMENT ON COLUMN vw_forecast_by_month.won_value IS
  'Revenue from deals WON in this month, by won_at — not by what they were forecast to close. A deal won in March that was expected in January is March revenue.';
COMMENT ON COLUMN vw_forecast_by_month.overdue_deals IS
  'Open deals in this month whose close date has already passed. They inflate a period that has ended and should be rescheduled or closed.';
COMMENT ON COLUMN vw_forecast_by_month.total_potential IS
  'Expected (weighted open) plus won, for this month. The figure a period target is measured against.';
