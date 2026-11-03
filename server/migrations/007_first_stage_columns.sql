-- 007_first_stage_columns.sql
--
-- Record the stage an opportunity STARTED in (from our perspective — i.e.
-- the first stage we observed via webhook). Set once on first INSERT,
-- preserved across every subsequent stage transition.
--
-- The same information can be derived by joining stage_history (look for
-- triggered_by = 'opportunity_created' or the row with the earliest
-- entered_at). But James's analytics queries — "how many opps that
-- entered 'Initial contact made' eventually closed Won?" — benefit from
-- having it pre-joined on the opportunities row.
--
-- Column semantics:
--   first_stage_id    = GHL stable pipeline_stage_id at first sighting
--   first_stage_name  = display name at first sighting (snapshot, not live)
--   first_seen_at     = (already exists) — timestamp of first INSERT
--
-- The writer sets these via `ON CONFLICT ... DO UPDATE` that DELIBERATELY
-- excludes them from the SET clause — so they're written exactly once.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS first_stage_id   TEXT,
  ADD COLUMN IF NOT EXISTS first_stage_name TEXT;

CREATE INDEX IF NOT EXISTS opportunities_loc_first_stage_id
  ON opportunities (location_id, first_stage_id);

CREATE INDEX IF NOT EXISTS opportunities_loc_first_stage_name
  ON opportunities (location_id, first_stage_name);

-- Backfill: for any opps already in the table (created before this migration),
-- look up their earliest stage_history row and copy those values across.
-- Only touches rows where first_stage_id IS NULL — safe to re-run.
UPDATE opportunities o
SET
  first_stage_id   = first_stage.stage_id,
  first_stage_name = first_stage.stage_name
FROM (
  SELECT DISTINCT ON (location_id, opportunity_id)
    location_id, opportunity_id, stage_id, stage_name
  FROM stage_history
  ORDER BY location_id, opportunity_id, entered_at ASC
) AS first_stage
WHERE o.location_id     = first_stage.location_id
  AND o.opportunity_id  = first_stage.opportunity_id
  AND o.first_stage_id IS NULL;
