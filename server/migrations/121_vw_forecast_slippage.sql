-- 121_vw_forecast_slippage.sql
--
-- At-risk deals: the ones whose expected close date keeps moving.
--
-- ── WE COMPUTE THIS; GHL STORES IT ───────────────────────────────────
-- GHL keeps four denormalised counters on the opportunity —
-- forecast_slippage_count, forecast_days_slipped, forecast_original_close_date,
-- forecast_last_slipped_at — maintained on write, because it has no history
-- of close-date changes to derive them from.
--
-- We do not sync those fields and do not need them. opportunity_field_history
-- (034) records every change to forecast_close_date with old_value, new_value
-- and changed_at. The counters are therefore DERIVED here, which is strictly
-- better in two ways:
--
--   • If the rule changes — say a push inside 24 hours stops counting as a
--     slip — the numbers recompute. GHL's would be wrong until every row was
--     rewritten.
--   • The history is auditable. "Pushed 3 times" can be shown as three dates,
--     not asserted as a number nobody can check.
--
-- The cost: history only goes back to when field tracking started (034). A
-- deal pushed twice before that reads as pushed zero times. first_seen_change
-- exposes that boundary rather than letting it pass as "never slipped".
--
-- ── ONLY A PUSH COUNTS ───────────────────────────────────────────────
-- Matching GHL: moving a date LATER is a slip; pulling it earlier is not, and
-- does not decrement. Days slipped is measured from the ORIGINAL date to the
-- current one, so a deal pushed out three months and pulled back one is 60
-- days slipped, not 90.
--
-- ── THE THRESHOLDS ARE GHL'S DEFAULTS, AND THEY ARE JUDGEMENTS ───────
--   High   >= 2 pushes OR >= 14 days
--   Medium >= 1 push   OR >= 7 days
--   Low    >= 1 push   OR >= 1 day
-- Highest match wins. The numbers are returned alongside the band so an
-- answer can quote "pushed 3 times, 41 days late" rather than only "high".

CREATE OR REPLACE VIEW vw_forecast_slippage
  WITH (security_invoker = true) AS
WITH changes AS (
  -- Every recorded change to the expected close date, oldest first.
  SELECT h.location_id,
         h.opportunity_id,
         h.changed_at,
         -- JSONB -> date. A cleared date is NULL on either side.
         NULLIF(h.old_value #>> '{}', '')::date               AS old_date,
         NULLIF(h.new_value #>> '{}', '')::date               AS new_date
    FROM opportunity_field_history h
   WHERE h.field_key = 'forecast_close_date'
),
agg AS (
  SELECT location_id,
         opportunity_id,
         -- A PUSH only: both dates present and the new one later.
         count(*) FILTER (
           WHERE old_date IS NOT NULL AND new_date IS NOT NULL
             AND new_date > old_date
         )                                                    AS times_pushed,
         -- The earliest date this deal was ever expected to close. The first
         -- change's old_value is the baseline; if that is null (date set for
         -- the first time) the earliest new_value serves.
         COALESCE(
           min(old_date) FILTER (WHERE old_date IS NOT NULL),
           min(new_date) FILTER (WHERE new_date IS NOT NULL)
         )                                                    AS original_close_date,
         max(changed_at) FILTER (
           WHERE old_date IS NOT NULL AND new_date IS NOT NULL
             AND new_date > old_date
         )                                                    AS last_pushed_at,
         min(changed_at)                                      AS first_seen_change
    FROM changes
   GROUP BY location_id, opportunity_id
)
SELECT b.location_id,
       b.opportunity_id,
       b.deal_name,
       b.status,
       b.monetary_value,
       b.stage_name,
       b.assigned_to_name                                     AS owner,
       b.forecast_close_date                                  AS current_close_date,
       a.original_close_date,
       COALESCE(a.times_pushed, 0)                            AS times_pushed,
       -- Measured original -> CURRENT, so pulling a date back reduces it.
       GREATEST(0, (b.forecast_close_date - a.original_close_date))
                                                              AS days_slipped,
       a.last_pushed_at,
       a.first_seen_change,

       CASE
         WHEN COALESCE(a.times_pushed, 0) >= 2
           OR GREATEST(0, (b.forecast_close_date - a.original_close_date)) >= 14
           THEN 'high'
         WHEN COALESCE(a.times_pushed, 0) >= 1
           OR GREATEST(0, (b.forecast_close_date - a.original_close_date)) >= 7
           THEN 'medium'
         ELSE 'low'
       END                                                    AS risk,

       b.effective_probability,
       b.weighted_value
  FROM vw_forecast_base b
  JOIN agg a
    ON a.opportunity_id = b.opportunity_id
   -- Scoped on location: opportunity_id is unique per sub-account (001).
   AND a.location_id    = b.location_id
 WHERE b.status = 'open'
   AND (COALESCE(a.times_pushed, 0) > 0
        OR GREATEST(0, (b.forecast_close_date - a.original_close_date)) > 0);

COMMENT ON VIEW vw_forecast_slippage IS
  'Open deals whose expected close date has been pushed back, with how many times, how many days late against the original, and a high/medium/low band. Derived from the field-change history rather than stored counters, so it is auditable and recomputes if the rule changes — but it only sees changes since field tracking began.';

COMMENT ON COLUMN vw_forecast_slippage.times_pushed IS
  'Times the close date moved LATER. Pulling a date forward does not count and does not reduce this, matching how GHL counts it.';
COMMENT ON COLUMN vw_forecast_slippage.days_slipped IS
  'Days between the original expected close date and the current one. Measured to the CURRENT date, so a deal pushed out and partly pulled back shows the net slip.';
COMMENT ON COLUMN vw_forecast_slippage.first_seen_change IS
  'The earliest close-date change on record for this deal. Changes before field tracking started are not visible, so a deal first seen recently may have slipped more than this shows.';
COMMENT ON COLUMN vw_forecast_slippage.risk IS
  'high: 2+ pushes or 14+ days late. medium: 1+ push or 7+ days. low: any slip at all. Thresholds are a convention, not a measurement — quote the underlying counts alongside.';

-- ─────────────────────────────────────────────────────────────────────
-- The summary band, for "how much is at risk" without listing every deal.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_forecast_slippage_summary
  WITH (security_invoker = true) AS
SELECT location_id,
       risk,
       count(*)                                               AS deals,
       COALESCE(sum(monetary_value), 0)                       AS value_at_risk,
       COALESCE(sum(weighted_value), 0)                       AS expected_at_risk,
       round(avg(times_pushed), 1)                            AS avg_times_pushed,
       round(avg(days_slipped))                               AS avg_days_slipped,
       max(days_slipped)                                      AS worst_days_slipped
  FROM vw_forecast_slippage
 GROUP BY location_id, risk;

COMMENT ON VIEW vw_forecast_slippage_summary IS
  'Deals and value at risk, grouped into high / medium / low slippage. Lead with value_at_risk rather than the count — twelve deals worth 400k slipping matters more than forty worth 9k.';
