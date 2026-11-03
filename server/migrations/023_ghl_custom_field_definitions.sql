-- 023_ghl_custom_field_definitions.sql
--
-- Translation dictionary for GHL custom fields. Populated by a daily cron
-- (customFieldsSync.js). GHL doesn't emit webhooks when custom field
-- definitions change, so daily reconciliation is the only tool — same
-- pattern as the tags catalogue.
--
-- One row per (location_id, object_type, field_id):
--   object_type = 'contact' | 'opportunity'
--   field_id    = GHL's native custom-field identifier
--
-- GHL's GET /locations/{loc}/customFields returns both contact and
-- opportunity custom fields in a single call, each row carrying a `model`
-- field ('contact' or 'opportunity') that we use for object_type. One API
-- call per location per day.
--
-- Soft delete only: definitions removed from GHL keep the row with
-- is_active=false so historical customFields JSONB blobs (on contacts +
-- opportunities) stay interpretable long after the field is retired.
--
-- Per CSV blueprint §1.6 — 12 columns.

CREATE TABLE IF NOT EXISTS ghl_custom_field_definitions (
  location_id     TEXT NOT NULL,
  object_type     TEXT NOT NULL,                          -- 'contact' | 'opportunity'
  field_id        TEXT NOT NULL,                          -- GHL native custom-field ID
  field_key       TEXT,                                    -- stable key e.g. 'opportunity.inquiry'
  display_name    TEXT,                                    -- GHL's current human-readable name
  field_type      TEXT,                                    -- dataType: TEXT / DROPDOWN / CHECKBOX / DATE / FILE_UPLOAD / etc.
  options         JSONB,                                   -- { values: [...], images: [...] } for picklist types
  is_active       BOOLEAN NOT NULL DEFAULT true,           -- FALSE = missing from latest sync = removed in GHL
  created_at_ghl  TIMESTAMPTZ,                             -- NULL — GHL doesn't expose this for custom-field definitions
  updated_at_ghl  TIMESTAMPTZ,                             -- NULL — GHL doesn't expose this either
  last_synced_at  TIMESTAMPTZ,                             -- when the daily cron last touched this row
  raw_definition  JSONB,                                    -- full API row for future-proofing (placeholder, position, isMultiFileAllowed, etc.)
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, object_type, field_id)
);

-- Query shapes:
--   - Resolve a field_id from a customFields payload entry (hot path — PK)
--   - "all active opportunity fields in this location"  (loc, object, active)
--   - Lookup by field_key (analytics + AI extraction path)
CREATE UNIQUE INDEX IF NOT EXISTS gcfd_loc_obj_key
  ON ghl_custom_field_definitions (location_id, object_type, field_key)
  WHERE field_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS gcfd_loc_obj_active
  ON ghl_custom_field_definitions (location_id, object_type, is_active);

-- RLS scoped by location. Cross-tenant reads always via a role that sets
-- app.location_id explicitly (analytics scripts, sync jobs).
ALTER TABLE ghl_custom_field_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ghl_custom_field_definitions;
CREATE POLICY tenant_iso ON ghl_custom_field_definitions
  USING (location_id = current_setting('app.location_id', true));
