-- 034_stage2_attribution_history.sql
--
-- Stage 2 · Attribution and change history.
--
-- Two tables:
--   • message_opportunity_map    — versioned, reviewable attribution
--                                   between messages and opportunities
--   • opportunity_field_history  — append-only log of changes to 27
--                                   analytics-critical opportunity fields
--
-- Both are append-only. Nothing overwrites. Superseding a decision opens a
-- new row and stamps superseded_at on the old one — full history preserved.

-- ─── message_opportunity_map ─────────────────────────────────────────────
-- One row per attribution decision. A message can have multiple rows over
-- time as rules improve or humans review. The CURRENT decision is the row
-- with superseded_at IS NULL.

CREATE TABLE IF NOT EXISTS message_opportunity_map (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       TEXT NOT NULL,
  message_id        TEXT NOT NULL,
  opportunity_id    TEXT,                           -- NULL when unassigned/ambiguous/excluded
  stage_history_id  UUID,                           -- linked stage session (when resolvable)
  mapping_status    TEXT NOT NULL,                  -- mapped / ambiguous / unassigned / excluded_multi_open / manually_resolved
  rule              TEXT,                           -- e.g. single_open_opp
  rule_version      TEXT,                           -- e.g. v1
  confidence        NUMERIC(4,3),                   -- 0.000-1.000
  mapped_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at     TIMESTAMPTZ,                    -- NULL = current decision
  reviewed_by       TEXT,                           -- user_id or 'system'
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,

  -- NOTE: no FK to messages. The messages unique index on (location_id,
  -- message_id) is PARTIAL (`WHERE message_id IS NOT NULL`) which Postgres
  -- won't accept as an FK target. Referential integrity is enforced by the
  -- writer (attributionEngine.recordDecision) which only inserts rows for
  -- messages it's already persisted.

  -- Composite FK to opportunities (nullable — mapping may be ambiguous)
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities(location_id, opportunity_id),
  -- Simple FK to stage_history (nullable — not every mapping resolves a stage)
  FOREIGN KEY (stage_history_id) REFERENCES stage_history(id)
);

-- Hot query: "current mapping for this message"
CREATE UNIQUE INDEX IF NOT EXISTS mom_current_per_message
  ON message_opportunity_map (location_id, message_id)
  WHERE superseded_at IS NULL;

-- Reverse lookup: "all messages currently mapped to this opp"
CREATE INDEX IF NOT EXISTS mom_current_per_opp
  ON message_opportunity_map (location_id, opportunity_id)
  WHERE superseded_at IS NULL AND opportunity_id IS NOT NULL;

-- Review queue: everything ambiguous or excluded
CREATE INDEX IF NOT EXISTS mom_status
  ON message_opportunity_map (location_id, mapping_status, mapped_at)
  WHERE superseded_at IS NULL;

-- Rule audit: "which rule was applied when"
CREATE INDEX IF NOT EXISTS mom_rule
  ON message_opportunity_map (rule, rule_version, mapped_at);

ALTER TABLE message_opportunity_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON message_opportunity_map;
CREATE POLICY tenant_iso ON message_opportunity_map
  USING (location_id = current_setting('app.location_id', true));


-- ─── opportunity_field_history ───────────────────────────────────────────
-- One row per field change. Append-only. Values stored as JSONB so we can
-- track scalar changes (status='won'), numeric changes (monetary_value=5000),
-- array changes (product_system=['Crittall','Cortizo']), and NULL transitions.

CREATE TABLE IF NOT EXISTS opportunity_field_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       TEXT NOT NULL,
  opportunity_id    TEXT NOT NULL,
  field_key         TEXT NOT NULL,                  -- 'status' / 'monetary_value' / 'why_want' / 'meddic_1' / ...
  old_value         JSONB,                          -- NULL for first-ever value
  new_value         JSONB,                          -- NULL when the field is being cleared
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_via      TEXT NOT NULL,                  -- 'opportunity_updated' / 'opportunity_status_updated' / 'opportunitiesSync' / 'backfill'
  ingest_event_id   TEXT,                           -- ghl_raw.event_id when driven by a webhook

  FOREIGN KEY (location_id, opportunity_id)
    REFERENCES opportunities(location_id, opportunity_id)
);

-- Hot query: "timeline of a single field on a single opp"
CREATE INDEX IF NOT EXISTS ofh_opp_field_time
  ON opportunity_field_history (location_id, opportunity_id, field_key, changed_at);

-- Cross-opp field trend: "all monetary_value changes this month"
CREATE INDEX IF NOT EXISTS ofh_field_time
  ON opportunity_field_history (location_id, field_key, changed_at);

-- Recent changes overview
CREATE INDEX IF NOT EXISTS ofh_recent
  ON opportunity_field_history (location_id, changed_at DESC);

ALTER TABLE opportunity_field_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON opportunity_field_history;
CREATE POLICY tenant_iso ON opportunity_field_history
  USING (location_id = current_setting('app.location_id', true));
