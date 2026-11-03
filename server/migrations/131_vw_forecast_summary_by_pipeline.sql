-- 131_vw_forecast_summary_by_pipeline.sql
--
-- The forecast KPI strip, PER PIPELINE.
--
-- WHY A SECOND VIEW RATHER THAN A FILTER ON THE FIRST.
-- vw_forecast_summary is GROUP BY location_id — one row, the whole account.
-- Adding pipeline_name to that GROUP BY would silently turn its single row
-- into one row per pipeline, so every existing answer quoting "expected
-- revenue" would start quoting whichever pipeline sorted first. A sibling
-- view leaves the account-wide number exactly where it was and adds the cut
-- beside it.
--
-- WHAT THIS FIXES.
-- GHL's Forecast screen has a pipeline dropdown: pick "Paul Tween" and every
-- KPI narrows to it. Insights AI had no equivalent — forecast_summary carried
-- no filters at all, so "what's expected revenue for the Paul Tween pipeline?"
-- could only be answered with the all-pipelines total, which is wrong by a
-- factor of however many pipelines exist. forecast_breakdown could group by
-- pipeline but carries only expected_value and open_deals, not the coverage
-- columns that say whether the figure is trustworthy.
--
-- Same columns as vw_forecast_summary, so an answer about one pipeline can
-- carry the same caveats as an answer about the account: pct_with_close_date
-- and value_without_probability matter MORE per pipeline, not less, because
-- one badly-maintained pipeline can be the reason the account-wide number
-- looks thin.
--
-- Deals with no pipeline are grouped as '(no pipeline)' rather than dropped —
-- a deal that is not in a pipeline still carries value, and losing it here
-- would make the pipelines fail to sum to the account total.

CREATE OR REPLACE VIEW vw_forecast_summary_by_pipeline
  WITH (security_invoker = true) AS
SELECT location_id,
       COALESCE(pipeline_name, '(no pipeline)')               AS pipeline_name,

       COALESCE(sum(monetary_value) FILTER (WHERE status IN ('open','won')), 0)
                                                              AS max_potential_revenue,
       COALESCE(sum(weighted_value), 0)                       AS expected_revenue,
       COALESCE(sum(monetary_value) FILTER (WHERE status = 'won'), 0)
                                                              AS won_revenue,
       count(*) FILTER (WHERE status = 'open')                AS open_opportunities,
       round(100.0 * COALESCE(sum(weighted_value), 0)
             / NULLIF(sum(monetary_value) FILTER (WHERE status IN ('open','won')), 0))
                                                              AS weighted_coverage_pct,

       COALESCE(sum(monetary_value) FILTER (WHERE status = 'open'), 0)
                                                              AS open_value,
       round(avg(effective_probability) FILTER (WHERE status = 'open'))
                                                              AS avg_probability,

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
       COALESCE(sum(monetary_value) FILTER (WHERE no_probability_anywhere), 0)
                                                              AS value_without_probability
  FROM vw_forecast_base
 GROUP BY location_id, COALESCE(pipeline_name, '(no pipeline)');

COMMENT ON VIEW vw_forecast_summary_by_pipeline IS
  'The Forecast KPI strip cut by pipeline — the equivalent of GHL''s pipeline dropdown. Same columns as vw_forecast_summary, one row per pipeline instead of one per sub-account.';
