-- 028_stage_history_snapshots.sql
--
-- Complete stage_history per James's CSV blueprint (Stage 1 · Table 12).
-- stage_history rows are point-in-time snapshots — they must remain
-- interpretable even after the live opportunity row is edited.
--
-- Changes:
--   1. Checkbox conversion (Q1=A, zero data loss):
--      product_system, product_type → JSONB arrays. Rename existing TEXT to
--      *_text_legacy, wrap single values as one-item arrays. Legacy kept
--      as safety net.
--   2. New point-in-time snapshot columns (7):
--      assigned_to, assigned_to_name, monetary_value_snapshot, currency,
--      status_snapshot, lead_source_snapshot, client_type_snapshot
--   3. New audit-trail columns (2):
--      ingest_event_id → ghl_raw.event_id link (nullable — historic rows NULL)
--      closed_reason → classified session-close event
--
-- All new columns nullable. Historic rows keep NULL for new columns;
-- forward writes populate them.

-- ─── Step 1: Checkbox arrays (rename → JSONB) ─────────────────────────────
-- Re-run safe: only rename if the source column still exists AND the target
-- doesn't yet.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='stage_history' AND column_name='product_system'
                AND data_type='text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='stage_history' AND column_name='product_system_text_legacy') THEN
    ALTER TABLE stage_history RENAME COLUMN product_system TO product_system_text_legacy;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='stage_history' AND column_name='product_type'
                AND data_type='text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='stage_history' AND column_name='product_type_text_legacy') THEN
    ALTER TABLE stage_history RENAME COLUMN product_type TO product_type_text_legacy;
  END IF;
END $$;

ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS product_system JSONB;
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS product_type   JSONB;

-- Backfill: wrap single non-null strings as one-item arrays.
UPDATE stage_history
   SET product_system = to_jsonb(ARRAY[product_system_text_legacy])
 WHERE product_system_text_legacy IS NOT NULL AND product_system IS NULL;

UPDATE stage_history
   SET product_type = to_jsonb(ARRAY[product_type_text_legacy])
 WHERE product_type_text_legacy IS NOT NULL AND product_type IS NULL;

-- ─── Step 2: Point-in-time snapshot columns ──────────────────────────────

ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS assigned_to             TEXT;
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS assigned_to_name        TEXT;
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS monetary_value_snapshot NUMERIC(12,2);
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS currency                TEXT DEFAULT 'GBP';
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS status_snapshot         TEXT;
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS lead_source_snapshot    TEXT;
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS client_type_snapshot    JSONB;

-- ─── Step 3: Audit-trail columns ─────────────────────────────────────────

-- Link back to the raw webhook that produced this row. Historic rows stay
-- NULL — we didn't capture the raw event id at time of write. Forward
-- writes populate via the openStageRow / closeStageRow paths.
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS ingest_event_id TEXT;

-- Why the session closed: 'stage_transition' | 'won' | 'lost' | 'abandoned'
-- | 'deleted' | 'correction'. NULL while session is still open. Backfill
-- best-effort from opportunity status + deleted flag.
ALTER TABLE stage_history ADD COLUMN IF NOT EXISTS closed_reason TEXT;

-- ─── Step 4: closed_reason backfill (Q3=A) ───────────────────────────────
-- Best-effort classification for existing closed rows. Rules:
--   1. deleted=true                                   → 'deleted'
--   2. Row is the LAST row for its opp AND opp status = won/lost/abandoned
--        → matches opp status
--   3. Everything else (has left_at, not last, not deleted)
--        → 'stage_transition'

-- Rule 1: deleted rows
UPDATE stage_history sh
   SET closed_reason = 'deleted'
 WHERE closed_reason IS NULL
   AND deleted = true
   AND left_at IS NOT NULL;

-- Rule 2: LAST row for an opportunity + terminal opp status
WITH last_row_per_opp AS (
  SELECT DISTINCT ON (location_id, opportunity_id)
         id, location_id, opportunity_id
    FROM stage_history
   WHERE left_at IS NOT NULL
   ORDER BY location_id, opportunity_id, entered_at DESC
)
UPDATE stage_history sh
   SET closed_reason = o.status
  FROM last_row_per_opp l
  JOIN opportunities o
    ON o.location_id = l.location_id
   AND o.opportunity_id = l.opportunity_id
 WHERE sh.id = l.id
   AND sh.closed_reason IS NULL
   AND o.status IN ('won', 'lost', 'abandoned');

-- Rule 3: everything else closed → stage_transition
UPDATE stage_history
   SET closed_reason = 'stage_transition'
 WHERE closed_reason IS NULL
   AND left_at IS NOT NULL;

-- ─── Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS stage_history_loc_assigned_to
  ON stage_history (location_id, assigned_to);
CREATE INDEX IF NOT EXISTS stage_history_loc_closed_reason
  ON stage_history (location_id, closed_reason);
CREATE INDEX IF NOT EXISTS stage_history_loc_status_snapshot
  ON stage_history (location_id, status_snapshot);
CREATE INDEX IF NOT EXISTS stage_history_product_system_gin
  ON stage_history USING GIN (product_system);
CREATE INDEX IF NOT EXISTS stage_history_product_type_gin
  ON stage_history USING GIN (product_type);
CREATE INDEX IF NOT EXISTS stage_history_client_type_snapshot_gin
  ON stage_history USING GIN (client_type_snapshot);
