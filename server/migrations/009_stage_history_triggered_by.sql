-- 009_stage_history_triggered_by.sql
--
-- Add the `triggered_by` column to stage_history. The IMPLEMENTATION.html
-- doc already documents it (Section 4.3 + query 7.14) and the writer code
-- has been built around the assumption it exists, but the column itself
-- was never added — so query 7.14 throws and the writer silently dropped
-- the value.
--
-- Values:
--   'opportunity_created'        → row opened in response to OpportunityCreate
--   'opportunity_stage_updated'  → row opened in response to OpportunityStageUpdate
--   'daily_sweep'                → synthetic row emitted by the orphan sweep cron
--
-- Backfill: existing rows get NULL — analytics queries should handle that
-- (the WHERE clauses in the doc don't filter on triggered_by, just SELECT it).

ALTER TABLE stage_history
  ADD COLUMN IF NOT EXISTS triggered_by TEXT;

CREATE INDEX IF NOT EXISTS stage_history_loc_triggered_by
  ON stage_history (location_id, triggered_by);
