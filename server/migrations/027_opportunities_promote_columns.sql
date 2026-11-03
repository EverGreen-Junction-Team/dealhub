-- 027_opportunities_promote_columns.sql
--
-- Complete opportunities table per James's CSV blueprint (Stage 1 · Table 11
-- · 52 columns). Changes:
--
--   1. CHECKBOX ARRAY FIX (Q1=A, zero data loss):
--      client_type, product_system, product_type, first_contact_method were
--      TEXT (single value). GHL sends checkbox fields as arrays. Rename
--      existing → *_text_legacy, add JSONB with the canonical name, backfill
--      wrapping single values as [value]. Legacy columns kept as safety net.
--
--   2. NEW STANDARD FIELDS (7):
--      currency, gclid, opportunity_source, lost_reason,
--      updated_at_ghl, raw_opportunity, deleted_at
--
--   3. NEW LIFECYCLE TIMESTAMPS (3):
--      won_at, lost_at, abandoned_at — backfilled from stage_history where
--      derivable, else set going forward from status webhooks.
--
--   4. NEW OPPORTUNITY CUSTOM FIELDS (6):
--      why_want, why_buy, why_blocker,
--      forecast_close_date, forecast_probability, upload_from_enquiry
--
-- All new columns nullable. Soft-delete via deleted_at (co-exists with the
-- existing is_deleted BOOL — CSV explicitly lists both).

-- ─── Step 0: Drop dependent view ─────────────────────────────────────────
-- vw_opportunity_flat (migration 012) references the 4 checkbox columns as
-- TEXT. Postgres blocks column type changes if any view depends on them.
-- Drop the view here; migration 029 re-creates it against the new JSONB
-- shape.
DROP VIEW IF EXISTS vw_opportunity_flat;

-- ─── Step 1: Checkbox arrays (rename → JSONB) ─────────────────────────────
-- Re-run safe: only rename if the source column still exists AND the target
-- doesn't yet. Idempotent PL/pgSQL block so npm run migrate is safe to re-run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='client_type'
                AND data_type='text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='client_type_text_legacy') THEN
    ALTER TABLE opportunities RENAME COLUMN client_type TO client_type_text_legacy;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='product_system'
                AND data_type='text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='product_system_text_legacy') THEN
    ALTER TABLE opportunities RENAME COLUMN product_system TO product_system_text_legacy;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='product_type'
                AND data_type='text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='product_type_text_legacy') THEN
    ALTER TABLE opportunities RENAME COLUMN product_type TO product_type_text_legacy;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='first_contact_method'
                AND data_type='text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='opportunities' AND column_name='first_contact_method_text_legacy') THEN
    ALTER TABLE opportunities RENAME COLUMN first_contact_method TO first_contact_method_text_legacy;
  END IF;
END $$;

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS client_type          JSONB;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS product_system       JSONB;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS product_type         JSONB;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS first_contact_method JSONB;

-- Backfill: wrap single non-null strings as one-item arrays.
UPDATE opportunities
   SET client_type = to_jsonb(ARRAY[client_type_text_legacy])
 WHERE client_type_text_legacy IS NOT NULL AND client_type IS NULL;

UPDATE opportunities
   SET product_system = to_jsonb(ARRAY[product_system_text_legacy])
 WHERE product_system_text_legacy IS NOT NULL AND product_system IS NULL;

UPDATE opportunities
   SET product_type = to_jsonb(ARRAY[product_type_text_legacy])
 WHERE product_type_text_legacy IS NOT NULL AND product_type IS NULL;

UPDATE opportunities
   SET first_contact_method = to_jsonb(ARRAY[first_contact_method_text_legacy])
 WHERE first_contact_method_text_legacy IS NOT NULL AND first_contact_method IS NULL;

-- Note: stage_history also has product_system + product_type as TEXT snapshots.
-- Those stay TEXT (they're point-in-time snapshots of the FIRST array element,
-- not the whole array). No migration on stage_history required.

-- ─── Step 2: New standard fields ─────────────────────────────────────────

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS currency           TEXT DEFAULT 'GBP';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gclid              TEXT;   -- workflow-copied from contact.google_click_id
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS opportunity_source TEXT;   -- opportunity.source (NOT contact_source, NOT utm_source)
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS lost_reason        TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS updated_at_ghl     TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS raw_opportunity    JSONB;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ;

-- ─── Step 3: Lifecycle timestamps ────────────────────────────────────────

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS won_at        TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS lost_at       TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS abandoned_at  TIMESTAMPTZ;

-- Q3=A backfill — derive from opportunity status + updated_at (best-effort).
-- Prefer opportunities.updated_at as the moment the status flip was recorded.
-- Rows with unknown/open status stay NULL.
UPDATE opportunities SET won_at       = updated_at WHERE status = 'won'       AND won_at       IS NULL;
UPDATE opportunities SET lost_at      = updated_at WHERE status = 'lost'      AND lost_at      IS NULL;
UPDATE opportunities SET abandoned_at = updated_at WHERE status = 'abandoned' AND abandoned_at IS NULL;

-- Backfill deleted_at from existing is_deleted flag.
UPDATE opportunities SET deleted_at = updated_at WHERE is_deleted = true AND deleted_at IS NULL;

-- ─── Step 4: Opportunity custom fields ───────────────────────────────────

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS why_want              TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS why_buy               TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS why_blocker           TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS forecast_close_date   DATE;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS forecast_probability  NUMERIC;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS upload_from_enquiry   TEXT;

-- ─── Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS opportunities_loc_won_at        ON opportunities (location_id, won_at);
CREATE INDEX IF NOT EXISTS opportunities_loc_lost_at       ON opportunities (location_id, lost_at);
CREATE INDEX IF NOT EXISTS opportunities_loc_abandoned_at  ON opportunities (location_id, abandoned_at);
CREATE INDEX IF NOT EXISTS opportunities_loc_active        ON opportunities (location_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS opportunities_loc_source        ON opportunities (location_id, opportunity_source);
CREATE INDEX IF NOT EXISTS opportunities_loc_lost_reason   ON opportunities (location_id, lost_reason);
CREATE INDEX IF NOT EXISTS opportunities_loc_gclid         ON opportunities (location_id, gclid) WHERE gclid IS NOT NULL;
-- GIN indexes on JSONB arrays for "any pipeline includes X" queries
CREATE INDEX IF NOT EXISTS opportunities_client_type_gin      ON opportunities USING GIN (client_type);
CREATE INDEX IF NOT EXISTS opportunities_product_system_gin   ON opportunities USING GIN (product_system);
CREATE INDEX IF NOT EXISTS opportunities_product_type_gin     ON opportunities USING GIN (product_type);
CREATE INDEX IF NOT EXISTS opportunities_first_contact_gin    ON opportunities USING GIN (first_contact_method);
