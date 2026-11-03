-- 010_stage_history_dedup.sql
--
-- Lets the backfill script use ON CONFLICT DO NOTHING when re-inserting
-- stage transitions it has already written. Live webhook writes use a
-- different path (findOpenStageRow + UPDATE) and are unaffected.
--
-- Key shape: (opportunity_id, stage_id, entered_at). We DON'T include
-- from_stage because GHL's activity events only give us the current
-- stage of each transition, and entered_at + stage_id is enough to
-- uniquely identify a stage session for a given opportunity.
--
-- COALESCE wrap on stage_id handles the rare case where GHL gave us a
-- stage NAME but couldn't resolve an id (test pipelines, deleted stages).
CREATE UNIQUE INDEX IF NOT EXISTS stage_history_backfill_dedup_idx
  ON stage_history (
    location_id,
    opportunity_id,
    COALESCE(stage_id, ''),
    entered_at
  );
