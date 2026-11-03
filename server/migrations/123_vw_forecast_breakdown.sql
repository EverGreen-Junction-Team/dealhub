-- 123_vw_forecast_breakdown.sql
--
-- The forecast cut by rep, pipeline and stage — GHL's "Group by" selector on
-- the Summary tab — plus the deal list behind any period.
--
-- ── WHY ONE STACKED VIEW RATHER THAN THREE ───────────────────────────
-- Three near-identical views (by rep / by pipeline / by stage) would be three
-- skills over the same base differing only in a GROUP BY, and the model would
-- pick between them badly — the same trap that made 104 absorb the narrower
-- rep view and 099 fold "lost vs abandoned" into a column.
--
-- Stacked with a `grouped_by` column instead, and exposed as ONE skill with
-- that column as a filter. The cost is that a deal appears once per grouping,
-- so summing the whole view triple-counts. The skill text forbids it and
-- `grouped_by` makes which cut you are reading unmissable.
--
-- ── UNASSIGNED AND UNSTAGED ARE ROWS, NOT OMISSIONS ──────────────────
-- A deal with no owner still carries value and is the one least likely to be
-- worked. Dropping it from a per-rep breakdown makes the totals disagree with
-- forecast_summary for no visible reason, and hides the deals most at risk.

CREATE OR REPLACE VIEW vw_forecast_breakdown
  WITH (security_invoker = true) AS
WITH by_rep AS (
  SELECT location_id, 'rep' AS grouped_by,
         COALESCE(assigned_to_name, assigned_to, '(unassigned)') AS group_value,
         count(*) FILTER (WHERE status = 'open')              AS open_deals,
         COALESCE(sum(monetary_value) FILTER (WHERE status = 'open'), 0) AS open_value,
         COALESCE(sum(weighted_value), 0)                     AS expected_value,
         COALESCE(sum(monetary_value) FILTER (WHERE status = 'won'), 0)  AS won_value,
         count(*) FILTER (WHERE status = 'won')               AS won_deals,
         round(avg(effective_probability) FILTER (WHERE status = 'open')) AS avg_probability,
         count(*) FILTER (WHERE missing_close_date)           AS no_close_date,
         count(*) FILTER (WHERE overdue_close_date)           AS overdue
    FROM vw_forecast_base
   GROUP BY location_id, COALESCE(assigned_to_name, assigned_to, '(unassigned)')
),
by_pipeline AS (
  SELECT location_id, 'pipeline',
         COALESCE(pipeline_name, '(no pipeline)'),
         count(*) FILTER (WHERE status = 'open'),
         COALESCE(sum(monetary_value) FILTER (WHERE status = 'open'), 0),
         COALESCE(sum(weighted_value), 0),
         COALESCE(sum(monetary_value) FILTER (WHERE status = 'won'), 0),
         count(*) FILTER (WHERE status = 'won'),
         round(avg(effective_probability) FILTER (WHERE status = 'open')),
         count(*) FILTER (WHERE missing_close_date),
         count(*) FILTER (WHERE overdue_close_date)
    FROM vw_forecast_base
   GROUP BY location_id, COALESCE(pipeline_name, '(no pipeline)')
),
by_stage AS (
  -- Open deals only: a stage breakdown is about where live pipeline sits, and
  -- a won deal's last stage says nothing useful about today's forecast.
  SELECT location_id, 'stage',
         COALESCE(stage_name, '(no stage)'),
         count(*),
         COALESCE(sum(monetary_value), 0),
         COALESCE(sum(weighted_value), 0),
         0::numeric, 0::bigint,
         round(avg(effective_probability)),
         count(*) FILTER (WHERE missing_close_date),
         count(*) FILTER (WHERE overdue_close_date)
    FROM vw_forecast_base
   WHERE status = 'open'
   GROUP BY location_id, COALESCE(stage_name, '(no stage)')
),
by_status AS (
  -- GHL's default group-by, and the one its Summary table shows: Open, Won,
  -- Lost, Abandoned down the side with max potential / expected / won across.
  -- Closed statuses carry no expected value by definition — a lost deal is
  -- not expected revenue — so those rows show 0 there, which is correct and
  -- matches what GHL renders as an em-dash.
  SELECT location_id, 'status',
         status,
         count(*) FILTER (WHERE status = 'open'),
         COALESCE(sum(monetary_value) FILTER (WHERE status = 'open'), 0),
         COALESCE(sum(weighted_value), 0),
         COALESCE(sum(monetary_value) FILTER (WHERE status = 'won'), 0),
         count(*) FILTER (WHERE status = 'won'),
         round(avg(effective_probability) FILTER (WHERE status = 'open')),
         count(*) FILTER (WHERE missing_close_date),
         count(*) FILTER (WHERE overdue_close_date)
    FROM vw_forecast_base
   GROUP BY location_id, status
),
stacked AS (
  -- by_rep FIRST: a UNION takes its column names from the first branch, and
  -- that is the only branch carrying aliases. Putting an unaliased branch
  -- first left the view with columns called "?column?" and a grouped_by that
  -- did not exist.
  SELECT * FROM by_rep
  UNION ALL SELECT * FROM by_status
  UNION ALL SELECT * FROM by_pipeline
  UNION ALL SELECT * FROM by_stage
)
SELECT location_id, grouped_by, group_value,
       open_deals, open_value, expected_value, won_value, won_deals,
       avg_probability, no_close_date, overdue,
       expected_value + won_value                             AS total_potential,
       -- Share WITHIN this grouping — partitioned by grouped_by, or a rep's
       -- share would be computed against rep + pipeline + stage combined.
       round(100.0 * expected_value
             / NULLIF(sum(expected_value) OVER (PARTITION BY location_id, grouped_by), 0))
                                                              AS pct_of_expected
  FROM stacked;

COMMENT ON VIEW vw_forecast_breakdown IS
  'The forecast cut four ways — by status, by rep, by pipeline and by stage — stacked with a grouped_by column. ALWAYS filter to one grouping: a deal appears once in each, so totalling the whole view counts it three times. Unassigned deals and unstaged deals are their own rows rather than being dropped.';

COMMENT ON COLUMN vw_forecast_breakdown.grouped_by IS
  'Which cut this row belongs to: status, rep, pipeline or stage. Report one at a time and say which — the three are not comparable and must never be summed together.';
COMMENT ON COLUMN vw_forecast_breakdown.pct_of_expected IS
  'This row''s share of expected revenue WITHIN its own grouping, not of the whole view.';
COMMENT ON COLUMN vw_forecast_breakdown.no_close_date IS
  'Deals in this group with no expected close date. They are in open_value but in no month — a group with a large figure here has pipeline the timeline cannot see.';

-- ─────────────────────────────────────────────────────────────────────
-- The deals themselves. "Which deals make up October", "the biggest deals in
-- the forecast", "which deals have no close date" are all one list with
-- different filters — not three views.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_forecast_deals
  WITH (security_invoker = true) AS
SELECT b.location_id,
       b.opportunity_id,
       b.deal_name,
       b.monetary_value                                       AS value,
       b.effective_probability                                AS probability,
       b.probability_source,
       b.weighted_value                                       AS expected_value,
       b.forecast_close_date                                  AS close_date,
       date_trunc('month', b.forecast_close_date)::date        AS close_month,
       b.stage_name,
       b.pipeline_name,
       COALESCE(b.assigned_to_name, b.assigned_to, '(unassigned)') AS owner,
       b.missing_close_date                                   AS no_close_date,
       b.overdue_close_date                                   AS overdue,
       b.no_probability_anywhere                              AS no_probability,
       (now()::date - b.created_at_ghl::date)                 AS days_open
  FROM vw_forecast_base b
 WHERE b.status = 'open';

COMMENT ON VIEW vw_forecast_deals IS
  'Every open deal with its forecast facts — value, probability and where it came from, weighted value, expected close month, owner and stage. The list behind any forecast figure: filter by month for "which deals make up October", by value for the biggest, or by no_close_date for the pipeline the forecast cannot see.';

COMMENT ON COLUMN vw_forecast_deals.probability_source IS
  'Which rule set the probability: deal, stage, or none. "none" means the deal contributes nothing to expected revenue because nobody set one — not a judgement that it will not close.';
COMMENT ON COLUMN vw_forecast_deals.close_month IS
  'First of the month the deal is expected to close, for matching a period. Empty when no close date is set, which is most deals here.';
