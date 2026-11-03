-- 073_ai_run_rating.sql
--
-- Thumbs up / down on a Co-Pilot ANSWER — distinct from ai_feedback, which is
-- confirm/dismiss/edit on a proposed CRM item (a task, a qualification field)
-- and has no concept of "was this answer good". Forcing a reaction through
-- that table would mean synthesising an item_type/item_key that describes
-- nothing, and colliding with its (location_id, opportunity_id, item_type,
-- item_key) uniqueness — which exists to stop the SAME proposal being
-- recorded twice, a constraint that has no meaning for a rating.
--
-- One rating per run: a rep can change their mind, not stack up several.

CREATE TABLE IF NOT EXISTS ai_run_rating (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id TEXT        NOT NULL,
  run_id      UUID        NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  rating      TEXT        NOT NULL CHECK (rating IN ('up', 'down')),
  -- Free text on a down-rating. The comment on ai_feedback.reason calls its
  -- equivalent "the single most useful column in this schema" — same reasoning
  -- applies here, and a thumbs-down with no reason tells you far less than one
  -- with "quoted the wrong deal".
  reason      TEXT,
  rated_by    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One per run: re-rating UPDATES rather than adding a second row.
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_rating_run_uniq
  ON ai_run_rating (run_id);

CREATE INDEX IF NOT EXISTS ai_run_rating_location_idx
  ON ai_run_rating (location_id, created_at);
