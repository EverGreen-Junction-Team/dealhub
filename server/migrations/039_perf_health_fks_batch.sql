-- 039_perf_health_fks_batch.sql
--
-- Bundle of three QA fixes:
--
-- (a) M5/M6 — Performance
--     • Wrap current_setting('app.location_id', true) in a SELECT
--       subquery inside every tenant_iso RLS policy. Postgres caches
--       the SELECT once per query instead of re-evaluating per row on
--       large scans — meaningful speedup on the big tables (messages,
--       stage_history, ghl_raw).
--     • Add missing index on messages.stage_history_id — the FK was
--       already there but no supporting index, so JOINs from
--       stage_history back to messages did seq scans.
--
-- (b) M4 — Missing FKs
--     Add the three FKs the QA report flagged as safe to enforce:
--       sync_runs.location_id                → installs.location_id
--       tag_history.location_id              → installs.location_id
--       ghl_custom_field_definitions.location_id → installs.location_id
--     (Deliberately NOT added: ghl_raw.location_id → keep forensic
--      archive after uninstall; tag_history.tag_id → catalogue may lag
--      the webhook.)
--
-- (c) M1 — Missing derived sync-run columns
--     Create vw_sync_run_health VIEW instead of adding columns.
--     Derives last_success_at, last_failure_at, overdue_by on-the-fly
--     from sync_runs — no drift, no storage cost.

-- ─── Part a1: RLS policy re-wrap (16 policies) ────────────────────────
-- Pattern: DROP + CREATE with `(SELECT current_setting(...))` so Postgres
-- treats it as a stable subquery evaluated once per statement.

-- Core (from 002_rls.sql)
DROP POLICY IF EXISTS tenant_iso ON contacts;
CREATE POLICY tenant_iso ON contacts
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON opportunities;
CREATE POLICY tenant_iso ON opportunities
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON stage_history;
CREATE POLICY tenant_iso ON stage_history
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON messages;
CREATE POLICY tenant_iso ON messages
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON users;
CREATE POLICY tenant_iso ON users
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON tasks;
CREATE POLICY tenant_iso ON tasks
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON notes;
CREATE POLICY tenant_iso ON notes
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON tags;
CREATE POLICY tenant_iso ON tags
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON tag_history;
CREATE POLICY tenant_iso ON tag_history
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON ghl_custom_field_definitions;
CREATE POLICY tenant_iso ON ghl_custom_field_definitions
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON pipelines;
CREATE POLICY tenant_iso ON pipelines
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON pipeline_stages;
CREATE POLICY tenant_iso ON pipeline_stages
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON message_opportunity_map;
CREATE POLICY tenant_iso ON message_opportunity_map
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON opportunity_field_history;
CREATE POLICY tenant_iso ON opportunity_field_history
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON sweep_cursors;
CREATE POLICY tenant_iso ON sweep_cursors
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON ghl_raw;
CREATE POLICY tenant_iso ON ghl_raw
  USING (location_id = (SELECT current_setting('app.location_id', true)));


-- ─── Part a2: Missing FK index on messages.stage_history_id ───────────

CREATE INDEX IF NOT EXISTS messages_stage_history_id_idx
  ON messages (stage_history_id)
  WHERE stage_history_id IS NOT NULL;


-- ─── Part b: 3 safe FKs → installs ────────────────────────────────────

-- sync_runs.location_id may be NULL for scope='all' rows, so FK on non-NULL
-- only. Postgres FKs allow NULL by default — no special clause needed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sync_runs_location_id_fkey' AND conrelid = 'sync_runs'::regclass
  ) THEN
    ALTER TABLE sync_runs
      ADD CONSTRAINT sync_runs_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES installs(location_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tag_history_location_id_fkey' AND conrelid = 'tag_history'::regclass
  ) THEN
    ALTER TABLE tag_history
      ADD CONSTRAINT tag_history_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES installs(location_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ghl_custom_field_definitions_location_id_fkey'
       AND conrelid = 'ghl_custom_field_definitions'::regclass
  ) THEN
    ALTER TABLE ghl_custom_field_definitions
      ADD CONSTRAINT ghl_custom_field_definitions_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES installs(location_id);
  END IF;
END $$;


-- ─── Part c: vw_sync_run_health view ──────────────────────────────────
-- Derives what the CSV blueprint calls last_success_at / last_failure_at /
-- overdue_by. On-the-fly from sync_runs — no stored columns, no drift.
--
-- One row per (run_type, object_type, location_id). Whole-run rows
-- (scope='all', location_id NULL) show location_id NULL — that's the
-- cross-tenant health summary.

DROP VIEW IF EXISTS vw_sync_run_health;
CREATE VIEW vw_sync_run_health
  WITH (security_invoker = true) AS
SELECT
  run_type,
  object_type,
  location_id,
  MAX(started_at) FILTER (WHERE status = 'success')                 AS last_success_at,
  MAX(started_at) FILTER (WHERE status IN ('failed','partial'))     AS last_failure_at,
  now() - MAX(started_at) FILTER (WHERE status = 'success')         AS overdue_by,
  COUNT(*)                                                          AS total_runs,
  COUNT(*) FILTER (WHERE status = 'success')                        AS successful_runs,
  COUNT(*) FILTER (WHERE status = 'failed')                         AS failed_runs,
  COUNT(*) FILTER (WHERE status = 'partial')                        AS partial_runs,
  MAX(started_at)                                                   AS last_run_at
  FROM sync_runs
 GROUP BY run_type, object_type, location_id;

COMMENT ON VIEW vw_sync_run_health IS
  'Per-job health summary derived from sync_runs. Answers "when did tagsSync last succeed for Crittall?" and "which jobs are overdue?" without needing stored derived columns. SECURITY INVOKER — RLS on sync_runs applies to anon-key reads.';
