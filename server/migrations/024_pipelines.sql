-- 024_pipelines.sql
--
-- Two tables in one file — pipelines + pipeline_stages. Both refreshed by
-- the same daily cron (pipelinesSync.js) via a single GHL API call:
--
--   GET /opportunities/pipelines?locationId=X
--     → { pipelines: [{ id, name, stages: [...], ... }] }
--
-- One call returns everything nested — we split pipelines out first, then
-- unroll the stages inside each. No webhook for pipeline/stage changes in
-- GHL, so daily reconciliation is the only tool — same pattern as tags +
-- custom fields catalogues.
--
-- Soft-delete philosophy: definitions removed from GHL keep the row with
-- is_active=false. Historical stage_history rows reference these IDs long
-- after a pipeline or stage is retired — we NEVER drop.
--
-- Per CSV blueprint §1.8 (pipelines) + §1.9 (pipeline_stages) — extended
-- to include every field GHL returns in the response for future-proofing.

-- ─── pipelines ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipelines (
  location_id                  TEXT NOT NULL,
  pipeline_id                  TEXT NOT NULL,
  name                         TEXT,
  position                     TEXT,                     -- GHL returns as string (e.g. "a0V") for pipeline ordering
  show_in_funnel               BOOLEAN,
  show_in_pie_chart            BOOLEAN,
  use_opportunity_probability  BOOLEAN,                  -- if true, funnel probability uses stage.stageWinProbability
  color_render_mode            TEXT,                     -- e.g. 'dot'
  is_active                    BOOLEAN NOT NULL DEFAULT true,
  last_synced_at               TIMESTAMPTZ,
  raw_pipeline                 JSONB,                    -- full GHL row minus the stages[] (which live in pipeline_stages)
  imported_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, pipeline_id)
);

CREATE INDEX IF NOT EXISTS pipelines_loc_active
  ON pipelines (location_id, is_active);

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON pipelines;
CREATE POLICY tenant_iso ON pipelines
  USING (location_id = current_setting('app.location_id', true));

-- ─── pipeline_stages ──────────────────────────────────────────────────────
--
-- One row per (location_id, stage_id). pipeline_id is denormalised so
-- analytics joins to opportunities.pipeline_id + pipeline_stages don't
-- need three-way lookups.

CREATE TABLE IF NOT EXISTS pipeline_stages (
  location_id         TEXT NOT NULL,
  stage_id            TEXT NOT NULL,
  pipeline_id         TEXT NOT NULL,                     -- FK-shaped; every stage belongs to exactly one pipeline
  name                TEXT,
  position            INTEGER,                           -- integer position within its pipeline (0, 1, 2, ...)
  show_in_funnel      BOOLEAN,
  show_in_pie_chart   BOOLEAN,
  win_probability     INTEGER,                           -- stageWinProbability (0-100) — feeds weighted pipeline math
  color               TEXT,                              -- hex e.g. "#FF0000"
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_synced_at      TIMESTAMPTZ,
  raw_stage           JSONB,                             -- full GHL stage row
  imported_at         TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, stage_id),
  FOREIGN KEY (location_id, pipeline_id) REFERENCES pipelines (location_id, pipeline_id)
);

CREATE INDEX IF NOT EXISTS pipeline_stages_loc_pipeline
  ON pipeline_stages (location_id, pipeline_id, position);
CREATE INDEX IF NOT EXISTS pipeline_stages_loc_active
  ON pipeline_stages (location_id, is_active);

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON pipeline_stages;
CREATE POLICY tenant_iso ON pipeline_stages
  USING (location_id = current_setting('app.location_id', true));
