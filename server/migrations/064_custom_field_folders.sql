-- 064_custom_field_folders.sql
--
-- Custom-field FOLDERS, and the field→folder link.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY
-- ═════════════════════════════════════════════════════════════════════════
--
-- GHL groups a location's custom fields into folders — "General Info",
-- "Website Form", "Charlie lead upload (Crittall)" — and its own contact
-- panel renders one collapsible section per folder. Our contact editor showed
-- no custom fields at all: the definitions were synced (migration 023) but
-- the folder they belong to was never stored, so there was nothing to group
-- by and nothing to name a section after.
--
-- Each field carries a `parentId` pointing at its folder. That value has been
-- arriving all along inside raw_definition; this promotes it to a column and
-- adds the folders themselves.
--
-- ═════════════════════════════════════════════════════════════════════════
-- SAFE TO RE-RUN
-- ═════════════════════════════════════════════════════════════════════════
--
-- Every statement is IF NOT EXISTS or an idempotent UPDATE. The backfill
-- reads parentId out of raw_definition, so existing rows gain their folder
-- without waiting for the next sync.

-- ── 1. The folders ───────────────────────────────────────────────────────
--
-- Keyed the same way as the definitions table (location + object + id), so
-- contact and opportunity folders cannot collide.
CREATE TABLE IF NOT EXISTS ghl_custom_field_folders (
  location_id     TEXT NOT NULL,
  object_type     TEXT NOT NULL,           -- 'contact' | 'opportunity'
  folder_id       TEXT NOT NULL,           -- GHL's folder id, matches a field's parentId
  name            TEXT,                    -- "General Info", "Website Form", …
  -- GHL orders folders in its own UI; keeping it means our sections appear in
  -- the order a rep already knows from the CRM.
  position        INTEGER,
  -- FALSE = absent from the latest sync = deleted in GHL. Not hard-deleted,
  -- matching the definitions table: an old contact's stored customFields blob
  -- stays interpretable after a folder is retired.
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_synced_at  TIMESTAMPTZ,
  raw_folder      JSONB,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, object_type, folder_id)
);

-- "every active contact folder for this location", the only read shape.
CREATE INDEX IF NOT EXISTS gcff_loc_obj_active
  ON ghl_custom_field_folders (location_id, object_type, is_active);

COMMENT ON TABLE ghl_custom_field_folders IS
  'Custom-field folders as GHL groups them. One section per row in the contact editor.';

-- ── 2. The field → folder link ───────────────────────────────────────────
--
-- No FOREIGN KEY, deliberately. Sync order is not guaranteed — fields and
-- folders arrive in one response but are written in separate statements, and
-- a field whose folder has been deleted in GHL still has to store its old
-- parentId so the value remains interpretable. An orphan renders under
-- "Other fields" rather than failing an insert.
ALTER TABLE ghl_custom_field_definitions
  ADD COLUMN IF NOT EXISTS parent_id TEXT;

-- Position within the folder — GHL's own ordering inside a section.
ALTER TABLE ghl_custom_field_definitions
  ADD COLUMN IF NOT EXISTS position INTEGER;

CREATE INDEX IF NOT EXISTS gcfd_loc_obj_parent
  ON ghl_custom_field_definitions (location_id, object_type, parent_id)
  WHERE parent_id IS NOT NULL;

COMMENT ON COLUMN ghl_custom_field_definitions.parent_id IS
  'The folder this field belongs to (GHL parentId). NULL = ungrouped; the UI renders those under "Other fields".';

-- ── 3. Backfill from what we already stored ──────────────────────────────
--
-- raw_definition has carried parentId since migration 023 — it was simply
-- never read. This means the grouping works immediately rather than after the
-- next daily sync.
UPDATE ghl_custom_field_definitions
   SET parent_id = raw_definition ->> 'parentId'
 WHERE parent_id IS NULL
   AND raw_definition ? 'parentId'
   AND nullif(raw_definition ->> 'parentId', '') IS NOT NULL;

UPDATE ghl_custom_field_definitions
   SET position = (raw_definition ->> 'position')::int
 WHERE position IS NULL
   AND raw_definition ? 'position'
   AND (raw_definition ->> 'position') ~ '^[0-9]+$';

-- ── 4. Tenant isolation ──────────────────────────────────────────────────
--
-- Same policy every other table carries. Without it a folder list would be
-- readable across sub-accounts — and the analyst role (create_analyst_role)
-- relies on RLS for its per-location scoping, not on query discipline.
--
-- current_setting wrapped in a SELECT: unwrapped it is evaluated once PER ROW
-- rather than once per query. That is the correction migration 062 applied to
-- every other policy; a new table must not reintroduce the old shape.
ALTER TABLE ghl_custom_field_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ghl_custom_field_folders;
CREATE POLICY tenant_iso ON ghl_custom_field_folders
  USING (location_id = (SELECT current_setting('app.location_id', true)));
