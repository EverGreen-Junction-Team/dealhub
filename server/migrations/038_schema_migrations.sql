-- 038_schema_migrations.sql
--
-- Fixes a recurring class of deploy failure: every `npm run migrate` re-runs
-- every SQL file. Migrations that reference now-renamed columns break on
-- re-run (025 job_name, 003 queued_at, etc.), and we've had to bolt on
-- re-run guards each time.
--
-- Fix: a proper migration tracker. Applied filenames go here; the migrate
-- script checks this table before running each file and skips anything
-- already applied. New migrations only run once. Existing ones stop
-- getting touched.
--
-- One row per filename. `applied_at` records when it first ran; on the
-- first deploy of this feature we pre-populate every existing migration
-- filename so nothing re-runs — see the INSERT block below.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS so Supabase's anon key can't read/write the tracker table.
-- No policy defined = deny-all under RLS. The migrate script uses the
-- service role connection string which bypasses RLS, so this doesn't
-- affect deploys.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- Pre-populate with every migration filename that currently exists in the
-- repo (option A from the plan). Every one of these is already applied to
-- the live DB — we're just teaching the tracker that fact so it doesn't
-- try to re-run them.
--
-- ON CONFLICT DO NOTHING makes this idempotent on re-run.
INSERT INTO schema_migrations (filename, applied_at) VALUES
  ('001_schema.sql', now()),
  ('002_rls.sql', now()),
  ('003_internal.sql', now()),
  ('004_installs_nullable_tokens.sql', now()),
  ('005_installs_reinstalled_at.sql', now()),
  ('006_assigned_to_name.sql', now()),
  ('007_first_stage_columns.sql', now()),
  ('008_message_status.sql', now()),
  ('009_stage_history_triggered_by.sql', now()),
  ('010_stage_history_dedup.sql', now()),
  ('011_from_backfill.sql', now()),
  ('012_analytics_views.sql', now()),
  ('013_ghl_raw.sql', now()),
  ('014_users.sql', now()),
  ('015_tasks.sql', now()),
  ('017_notes.sql', now()),
  ('018_tags.sql', now()),
  ('019_tag_history.sql', now()),
  ('020_tags_columns.sql', now()),
  ('021_tag_views.sql', now()),
  ('022_processed_events_status.sql', now()),
  ('023_ghl_custom_field_definitions.sql', now()),
  ('024_pipelines.sql', now()),
  ('025_sync_runs.sql', now()),
  ('026_contacts_promote_columns.sql', now()),
  ('027_opportunities_promote_columns.sql', now()),
  ('028_stage_history_snapshots.sql', now()),
  ('029_rebuild_opportunity_flat_view.sql', now()),
  ('030_pending_opportunities_align.sql', now()),
  ('031_messages_extend.sql', now()),
  ('032_sync_runs_align.sql', now()),
  ('033_sweep_cursors.sql', now()),
  ('034_stage2_attribution_history.sql', now()),
  ('035_stage_history_one_open_repair.sql', now()),
  ('036_synthesise_missing_stage_history.sql', now()),
  ('037_tag_history_backfill_tag_id.sql', now()),
  ('038_schema_migrations.sql', now())
ON CONFLICT (filename) DO NOTHING;
