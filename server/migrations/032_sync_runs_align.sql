-- 032_sync_runs_align.sql
--
-- Align sync_runs to James's CSV blueprint (Stage 1 · Table 4).
-- Changes:
--   1. Rename job_name → run_type   (CSV name)
--   2. Rename stats → counts        (CSV name)
--   3. Add window_start / window_end (used by messagesSync, contactsSync,
--      opportunitiesSync — the cursor-based reconciliation jobs)
--   4. Add run_uuid UUID column      (CSV wants UUID PK; we keep BIGSERIAL as
--      the internal PK for cheap ordering; run_uuid is the external audit id)
--
-- Re-run safe: rename guards + IF NOT EXISTS.

-- ─── Step 1: Rename columns to match blueprint ───────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='sync_runs' AND column_name='job_name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='sync_runs' AND column_name='run_type') THEN
    ALTER TABLE sync_runs RENAME COLUMN job_name TO run_type;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='sync_runs' AND column_name='stats')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='sync_runs' AND column_name='counts') THEN
    ALTER TABLE sync_runs RENAME COLUMN stats TO counts;
  END IF;
END $$;

-- Rename the index on run_type / job_name too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE tablename='sync_runs'
                AND indexname='sync_runs_job_started') THEN
    ALTER INDEX sync_runs_job_started RENAME TO sync_runs_run_type_started;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE tablename='sync_runs'
                AND indexname='sync_runs_loc_job_started') THEN
    ALTER INDEX sync_runs_loc_job_started RENAME TO sync_runs_loc_run_type_started;
  END IF;
END $$;

-- ─── Step 2: Add windowed columns for reconciliation sweeps ──────────────

ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS window_end   TIMESTAMPTZ;

-- ─── Step 3: Add UUID audit id (blueprint requires UUID PK) ──────────────
-- We keep the BIGSERIAL `id` as internal PK (cheap ordering, existing FKs).
-- The new run_uuid is the "one ID per attempt" the blueprint asks for and is
-- what other tables (messages.sync_run_id) reference.

ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS run_uuid UUID DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_run_uuid ON sync_runs (run_uuid);
CREATE INDEX IF NOT EXISTS sync_runs_window_end ON sync_runs (window_end);
