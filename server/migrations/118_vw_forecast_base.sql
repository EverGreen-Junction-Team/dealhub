-- 118_vw_forecast_base.sql
--
-- The foundation for the Forecast skills: every opportunity with its
-- EFFECTIVE WIN PROBABILITY resolved, plus the derived forecast facts the
-- other views build on.
--
-- Mirrors GHL's own Forecast tab (Opportunities → Forecast), which computes
-- the same numbers from OpenSearch aggregations. We hold the same inputs, so
-- the arithmetic can match — and in one place we hold MORE, see slippage
-- below.
--
-- ── EFFECTIVE PROBABILITY: GHL'S RESOLUTION ORDER, EXACTLY ───────────
-- From the forecast spec (resolveEffectiveProbability / getWeightedOpenScript):
--
--   1. pipeline.use_opportunity_probability = true AND the deal has its own
--      forecast_probability           -> use the deal's
--   2. the stage has a win_probability -> use the stage's
--   3. the deal has a probability and no stage  -> use the deal's
--   4. otherwise                       -> 0
--
-- Order matters and is not intuitive: with use_opportunity_probability OFF,
-- a deal's own carefully-set 80% is IGNORED in favour of the stage default.
-- That is GHL's behaviour, so it is ours — a forecast that disagreed with the
-- CRM it mirrors would be worse than one that inherits an odd rule. The rule
-- is surfaced as probability_source so an answer can say which applied.
--
-- ── AUTO STAGE PROBABILITY IS NOT IMPLEMENTED, DELIBERATELY ──────────
-- GHL falls back to `100 / (N + 1) * (i + 1)` when SOME stages lack a
-- probability. That spreads a synthetic curve across a pipeline nobody
-- configured, and it is indistinguishable in the output from a real figure.
-- Here an unset stage resolves to 0 and says so via probability_source =
-- 'none', so "expected revenue is low because nobody set probabilities" is
-- visible rather than papered over with invented numbers.
--
-- ── WHY won_at AND NOT last_status_change_date ───────────────────────
-- GHL buckets won deals into a period by last_status_change_date. We do not
-- sync that field, but we hold won_at (027), which for a won deal is the same
-- moment. For a deal won and later reopened the two could differ; that is rare
-- and won_at is the more honest column for "won in this period" regardless.
--
-- Standard: no brand CASE, no cross-account grouping, location_id selected
-- for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_forecast_base
  WITH (security_invoker = true) AS
SELECT o.location_id,
       o.opportunity_id,
       o.name                                                 AS deal_name,
       o.status,
       o.monetary_value,
       o.pipeline_id,
       o.current_stage_id                                     AS pipeline_stage_id,
       o.assigned_to,
       o.assigned_to_name,
       o.contact_id,
       o.created_at_ghl,
       o.won_at,
       o.forecast_close_date,
       o.forecast_probability,
       p.name                                                 AS pipeline_name,
       s.name                                                 AS stage_name,
       s.position                                             AS stage_position,
       s.win_probability                                      AS stage_win_probability,
       COALESCE(p.use_opportunity_probability, false)         AS uses_deal_probability,

       -- GHL's resolution order, in order.
       CASE
         WHEN COALESCE(p.use_opportunity_probability, false)
              AND o.forecast_probability IS NOT NULL THEN o.forecast_probability
         WHEN s.win_probability IS NOT NULL           THEN s.win_probability
         WHEN o.forecast_probability IS NOT NULL
              AND o.current_stage_id IS NULL         THEN o.forecast_probability
         ELSE 0
       END                                                    AS effective_probability,

       -- Which branch fired. Without this, a 0 is indistinguishable from a
       -- deal genuinely assessed at 0% — and the fix for each is different.
       CASE
         WHEN COALESCE(p.use_opportunity_probability, false)
              AND o.forecast_probability IS NOT NULL THEN 'deal'
         WHEN s.win_probability IS NOT NULL           THEN 'stage'
         WHEN o.forecast_probability IS NOT NULL
              AND o.current_stage_id IS NULL         THEN 'deal (no stage)'
         ELSE 'none'
       END                                                    AS probability_source,

       -- Weighted value, open deals only. A won deal is not "expected"
       -- revenue, it is revenue; a lost one is nothing.
       CASE WHEN o.status = 'open'
            THEN COALESCE(o.monetary_value, 0) * (
              CASE
                WHEN COALESCE(p.use_opportunity_probability, false)
                     AND o.forecast_probability IS NOT NULL THEN o.forecast_probability
                WHEN s.win_probability IS NOT NULL           THEN s.win_probability
                WHEN o.forecast_probability IS NOT NULL
                     AND o.current_stage_id IS NULL         THEN o.forecast_probability
                ELSE 0
              END) / 100.0
            ELSE 0
       END                                                    AS weighted_value,

       -- Readiness flags, open deals only — the three checks GHL's
       -- "Fix your forecast data" card runs.
       (o.status = 'open' AND o.forecast_close_date IS NULL)  AS missing_close_date,
       (o.status = 'open' AND COALESCE(o.monetary_value, 0) <= 0)
                                                              AS missing_value,
       (o.status = 'open' AND o.forecast_close_date < CURRENT_DATE)
                                                              AS overdue_close_date,
       (o.status = 'open' AND o.forecast_probability IS NULL
          AND s.win_probability IS NULL)                      AS no_probability_anywhere
  FROM opportunities o
  LEFT JOIN pipelines p
    ON p.pipeline_id = o.pipeline_id
   -- Scoped on location: a pipeline id belongs to one sub-account (024).
   AND p.location_id = o.location_id
  LEFT JOIN pipeline_stages s
    ON s.stage_id = o.current_stage_id
   AND s.location_id = o.location_id
 WHERE o.deleted_at IS NULL
   AND o.is_ghost = false;

COMMENT ON VIEW vw_forecast_base IS
  'Every live opportunity with its effective win probability resolved the way GHL''s Forecast tab resolves it, plus the weighted value and the readiness flags. The base other forecast views read; not usually queried directly.';

COMMENT ON COLUMN vw_forecast_base.effective_probability IS
  'The probability GHL would use: the deal''s own only when the pipeline has "use opportunity probability" switched on, otherwise the stage''s, otherwise the deal''s if it has no stage, otherwise 0. With that pipeline setting off, a deal''s own probability is ignored — which surprises people.';
COMMENT ON COLUMN vw_forecast_base.probability_source IS
  'Which rule produced the probability: deal, stage, "deal (no stage)", or none. "none" means a 0 that nobody assessed — a gap in setup, not a judgement that the deal will not close.';
COMMENT ON COLUMN vw_forecast_base.weighted_value IS
  'monetary_value x effective_probability / 100, open deals only. Won deals contribute 0 here because they are counted as actual revenue, not expected.';
COMMENT ON COLUMN vw_forecast_base.overdue_close_date IS
  'An open deal whose expected close date has passed. Inflates any period total it still sits in, because it is being counted in a period that has already ended.';
