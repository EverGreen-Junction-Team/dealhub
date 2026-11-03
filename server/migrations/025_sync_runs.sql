-- 025_sync_runs.sql
--
-- Persistent audit log for every cron/sync job execution. Answers:
--   "Did the daily cron run last night?"
--   "How many rows did tags sync touch for Crittall?"
--   "Which location keeps failing on pipelines?"
--
-- Two row shapes:
--   scope='all'      → one row per whole-run (all installs, e.g. syncTagsForAllInstalls)
--   scope='location' → one row per (job × location) inside a whole-run
--
-- job_name + object_type together identify what was synced:
--   job_name    = 'tagsSync' | 'customFieldsSync' | 'pipelinesSync'
--                 | 'orphanSweep' | 'purgeGhlRaw' | 'purgeProcessedEvents'
--   object_type = 'tags' | 'custom_fields' | 'pipelines' | 'pipeline_stages'
--                 | 'pending_opportunities' | 'ghl_raw' | 'processed_events'
--                 — the actual DB table/entity the job touched.
--
-- 30-day retention — purged by the same daily cron.

CREATE TABLE IF NOT EXISTS sync_runs (
  id            BIGSERIAL PRIMARY KEY,
  job_name      TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  location_id   TEXT,
  scope         TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ NOT NULL,
  duration_ms   INTEGER NOT NULL,
  stats         JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Column `job_name` was later renamed to `run_type` (migration 032) to match
-- James's CSV blueprint. Fresh clones still create it under the old name here;
-- 032 renames both column and index. Guard the index creations so re-runs
-- don't fail after 032 has already renamed the column away.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='sync_runs' AND column_name='job_name') THEN
    CREATE INDEX IF NOT EXISTS sync_runs_job_started
      ON sync_runs (job_name, started_at DESC);
    CREATE INDEX IF NOT EXISTS sync_runs_loc_job_started
      ON sync_runs (location_id, job_name, started_at DESC);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sync_runs_object_started
  ON sync_runs (object_type, started_at DESC);
