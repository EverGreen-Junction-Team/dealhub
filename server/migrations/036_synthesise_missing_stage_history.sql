-- 036_synthesise_missing_stage_history.sql
--
-- Fixes QA finding H3 — "19 active opportunities have no stage_history at all."
--
-- Root cause: these opps existed in GHL before we deployed the stage-history
-- writer, and their subsequent updates went through the metadata-only
-- 'opportunity_updated' path (which deliberately does NOT create
-- stage_history rows). So they show up in opportunities but the funnel
-- history is empty for them.
--
-- Fix: one-time INSERT — for every opp with ZERO stage_history rows,
-- synthesise ONE initial row using created_at_ghl as entered_at + the
-- current stage as stage_id. current_stage=true so the opp appears in
-- open-pipeline analytics. All snapshot columns copied from the opp's
-- CURRENT state (owner, value, status, product mix, etc.).
--
-- triggered_by = 'backfill_synthesis' — new value that distinguishes these
-- rows from real webhook-driven rows for analytics that need to know.
--
-- ghost_opportunity = false — these represent REAL stage sessions (the opp
-- is genuinely in that stage right now), just uncaptured until now.
--
-- Idempotent: NOT EXISTS clause guards against re-runs — opps that already
-- have stage_history rows are untouched.

INSERT INTO stage_history (
  id, location_id, opportunity_id, contact_id,
  stage_id, stage_name, pipeline_id, pipeline_name,
  entered_at, current_stage,
  assigned_to, assigned_to_name,
  monetary_value_snapshot, currency,
  status_snapshot, lead_source_snapshot, client_type_snapshot,
  product_system, product_type,
  custom_fields_snapshot,
  triggered_by, ghost_opportunity,
  from_backfill,
  imported_at
)
SELECT
  gen_random_uuid(),
  o.location_id, o.opportunity_id, o.contact_id,
  o.current_stage_id,
  COALESCE(o.current_stage_name, 'Unknown'),
  o.pipeline_id,
  o.pipeline_name,
  COALESCE(o.created_at_ghl, o.imported_at, now()),   -- best available entry timestamp
  true,                                                -- this is now the open stage
  o.assigned_to, o.assigned_to_name,
  o.monetary_value, COALESCE(o.currency, 'GBP'),
  o.status, o.lead_source_opportunity, o.client_type,
  o.product_system, o.product_type,
  o.custom_fields,
  'backfill_synthesis',
  false,                                               -- not a ghost — real state
  true,                                                -- from_backfill
  now()
  FROM opportunities o
 WHERE o.is_deleted = false
   AND o.deleted_at IS NULL
   AND o.is_ghost = false
   AND NOT EXISTS (
     SELECT 1 FROM stage_history sh
      WHERE sh.location_id    = o.location_id
        AND sh.opportunity_id = o.opportunity_id
   );
