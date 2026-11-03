-- 019_tag_history.sql
--
-- Temporal log of tag applications and removals per (record, tag).
-- One row per (entity, tag) session. When a tag is applied → new row opens
-- (applied_at = now, removed_at = NULL). When it's removed → same row closes
-- (removed_at = now). When re-applied → BRAND NEW row (never overwrite the
-- closed one). This gives a full timeline: was record X ever tagged Y? for
-- how long? how many times?
--
-- Populated by:
--   - ContactTagUpdate webhook → diff contact's full tag list vs open rows,
--     open new for added, close open for missing
--   - OpportunityUpdate webhook → same diff logic against opp's tags array
--   - (Later) backfill from GHL contact/opp reads if we ever need historical
--     seed rows for pre-existing tags
--
-- Storage philosophy:
--   - tag_id (from GHL) + tag_name (snapshot at application time). Rename-safe
--     via ID, human-readable via name without a join.
--   - detected_via records WHICH event told us (ContactTagUpdate /
--     OpportunityUpdate / initial_seed) — useful for provenance debugging.
--
-- Per CSV blueprint §1.17 — 10 columns.

CREATE TABLE IF NOT EXISTS tag_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    TEXT NOT NULL,
  entity_type    TEXT NOT NULL,                          -- 'contact' | 'opportunity'
  entity_id      TEXT NOT NULL,                          -- contact_id or opportunity_id
  tag_id         TEXT,                                   -- GHL tag ID (nullable — webhook may only send names)
  tag_name       TEXT NOT NULL,                          -- snapshot at application time
  applied_at     TIMESTAMPTZ NOT NULL,                   -- immutable once written
  removed_at     TIMESTAMPTZ,                            -- NULL while active
  detected_via   TEXT,                                   -- 'ContactTagUpdate' | 'OpportunityUpdate' | 'initial_seed'
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Common query shapes:
--   "current tags on this record"       (entity, active-only)
--   "was this record ever tagged X?"    (entity + tag)
--   "all applications of tag X"         (location, tag)
--   "tags applied in last 30 days"      (location, applied_at)
CREATE INDEX IF NOT EXISTS tag_history_entity_active
  ON tag_history (location_id, entity_type, entity_id)
  WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS tag_history_entity_all
  ON tag_history (location_id, entity_type, entity_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS tag_history_loc_tag
  ON tag_history (location_id, tag_name, applied_at DESC);
CREATE INDEX IF NOT EXISTS tag_history_loc_applied
  ON tag_history (location_id, applied_at DESC);

-- One-open-session-per-(record, tag_name) invariant enforced at write time
-- via the writer: before opening a new row, we UPDATE removed_at on any
-- existing open row for the same (entity, tag_name) that isn't already
-- covered by the new payload. Postgres unique index would over-constrain
-- (re-application should be allowed, just not simultaneous open rows).

-- RLS scoped by location.
ALTER TABLE tag_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON tag_history;
CREATE POLICY tenant_iso ON tag_history USING (location_id = current_setting('app.location_id', true));
