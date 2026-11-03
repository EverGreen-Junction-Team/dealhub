-- 030_pending_opportunities_align.sql
--
-- Align pending_opportunities to James's CSV blueprint (Stage 1 · Table 18).
--
-- Changes:
--   1. Rename pipeline_stage_id → observed_stage_id  (matches CSV name;
--      "observed at creation" is what it actually holds)
--   2. Rename queued_at → created_event_at           (matches CSV name)
--   3. Add sweep_after TIMESTAMPTZ — per-row eligibility timestamp.
--      Default = created_event_at + 10 minutes. Replaces the hardcoded
--      time-arithmetic in orphanSweep.js query.
--
-- pipeline_id and created_at_ghl are kept as extras — used by the sweep to
-- synthesise ghost stage_history rows without joining back to opportunities.
--
-- Re-run safe: rename guards + IF NOT EXISTS + idempotent backfill.

-- ─── Step 1: Rename to blueprint names ───────────────────────────────────

DO $$
BEGIN
  -- pipeline_stage_id → observed_stage_id
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='pending_opportunities' AND column_name='pipeline_stage_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='pending_opportunities' AND column_name='observed_stage_id') THEN
    ALTER TABLE pending_opportunities RENAME COLUMN pipeline_stage_id TO observed_stage_id;
  END IF;

  -- queued_at → created_event_at
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='pending_opportunities' AND column_name='queued_at')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='pending_opportunities' AND column_name='created_event_at') THEN
    ALTER TABLE pending_opportunities RENAME COLUMN queued_at TO created_event_at;
  END IF;
END $$;

-- Rename the dependent index too (best-effort — old name may not exist on
-- fresh clones that never had queued_at).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE tablename='pending_opportunities'
                AND indexname='pending_opportunities_queued') THEN
    ALTER INDEX pending_opportunities_queued RENAME TO pending_opportunities_created_event_at;
  END IF;
END $$;

-- ─── Step 2: Add sweep_after column ──────────────────────────────────────

ALTER TABLE pending_opportunities ADD COLUMN IF NOT EXISTS sweep_after TIMESTAMPTZ;

-- Backfill: existing rows get sweep_after = created_event_at + 10 minutes.
-- Matches the hardcoded 10-minute grace window that orphanSweep.js used.
UPDATE pending_opportunities
   SET sweep_after = created_event_at + interval '10 minutes'
 WHERE sweep_after IS NULL;

-- Enforce forward: every new row must set sweep_after (writer will do it).
-- Not made NOT NULL yet — safer during the transition. Can tighten later
-- once we've confirmed all writers populate it.

CREATE INDEX IF NOT EXISTS pending_opportunities_sweep_after
  ON pending_opportunities (sweep_after);
