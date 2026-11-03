-- 018_tags.sql
--
-- Tag catalogue — reference dictionary of every tag defined in a location.
-- One row per (location_id, tag_id).
--
-- Populated by:
--   1. Daily cron: GET /locations/{locationId}/tags → UPSERT each row
--   2. Ad-hoc: whenever a webhook mentions a tag ID we haven't seen,
--      the writer can seed a stub row (name resolved on next daily sync)
--
-- Not a temporal record — this is the current dictionary. When a tag is
-- renamed in GHL, the daily sync updates `name` in place. Historical
-- interpretation of who had that tag at what point is preserved in
-- tag_history (which also stores the name at application time).
--
-- Per CSV blueprint §1.16 — 4 columns.

CREATE TABLE IF NOT EXISTS tags (
  location_id   TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  name          TEXT NOT NULL,                          -- native GHL tag string
  namespace     TEXT,                                    -- derived: text before first ':' in name
  last_synced_at TIMESTAMPTZ,                            -- when the daily cron last touched this row
  imported_at   TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, tag_id)
);

-- Query shapes:
--   - Lookup name from ID (hot path, PK covers it)
--   - "all tags in this location"                      (location_id)   PK prefix
--   - Fuzzy name search                                (location_id, name)
--   - "tags in the quote namespace"                    (location_id, namespace)
CREATE INDEX IF NOT EXISTS tags_loc_name      ON tags (location_id, name);
CREATE INDEX IF NOT EXISTS tags_loc_namespace ON tags (location_id, namespace) WHERE namespace IS NOT NULL;

-- RLS scoped by location.
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON tags;
CREATE POLICY tenant_iso ON tags USING (location_id = current_setting('app.location_id', true));
