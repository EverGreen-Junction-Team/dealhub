-- 011_from_backfill.sql
--
-- Tags rows written by the one-shot historical backfill script
-- (src/scripts/backfill.js) so they're distinguishable from rows written by
-- the live webhook flow. Defaults to false, so existing rows + live webhook
-- inserts are unaffected.
--
-- Use cases:
--   - Audit: SELECT COUNT(*) FROM opportunities WHERE from_backfill;
--   - Filter dashboards to "live data only" if a backfill went wrong
--   - Roll back a botched backfill: DELETE FROM ... WHERE from_backfill = true
--
-- stage_history already has triggered_by = 'backfill' for this purpose, but
-- we add from_backfill alongside for symmetry across all 4 tables and so
-- downstream queries can use one consistent predicate.

ALTER TABLE contacts        ADD COLUMN IF NOT EXISTS from_backfill BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE opportunities   ADD COLUMN IF NOT EXISTS from_backfill BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stage_history   ADD COLUMN IF NOT EXISTS from_backfill BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages        ADD COLUMN IF NOT EXISTS from_backfill BOOLEAN NOT NULL DEFAULT false;

-- Partial indexes — only on rows where from_backfill = true, since the vast
-- majority of rows in production will be live (from_backfill = false). Keeps
-- the index small and the filter scan cheap when auditing the backfilled set.
CREATE INDEX IF NOT EXISTS contacts_from_backfill_idx       ON contacts      (location_id) WHERE from_backfill;
CREATE INDEX IF NOT EXISTS opportunities_from_backfill_idx  ON opportunities (location_id) WHERE from_backfill;
CREATE INDEX IF NOT EXISTS stage_history_from_backfill_idx  ON stage_history (location_id) WHERE from_backfill;
CREATE INDEX IF NOT EXISTS messages_from_backfill_idx       ON messages      (location_id) WHERE from_backfill;
