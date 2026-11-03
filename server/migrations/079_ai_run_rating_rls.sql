-- 079_ai_run_rating_rls.sql
--
-- ai_run_rating (migration 073) never got the tenant-isolation policy every
-- other location-scoped table has — a gap the Supabase Advisor flagged
-- (RLS disabled on a public table). Every read/write to this table already
-- goes through withTenant, which sets app.location_id for the session; this
-- migration just makes the database enforce what the app already assumes.
-- Same shape as saved_views (070), ai_exclusions (057), ai_actions (077).

ALTER TABLE ai_run_rating ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON ai_run_rating;
CREATE POLICY tenant_iso ON ai_run_rating
  USING (location_id = current_setting('app.location_id', true));
