-- 046_revoke_anon_grants.sql
--
-- Defence-in-depth from audit v2, S2. Empirical anon-role test showed
-- 0 rows visible on every table + view — RLS is doing its job. But anon
-- still holds table-level SELECT / INSERT / UPDATE / DELETE grants on the
-- entire public schema (Supabase default). Harmless while RLS holds, but
-- if a policy ever slipped, anon could see rows.
--
-- Revoke everything anon has on public. It should never read through this
-- schema anyway — the app uses the service_role connection which bypasses
-- RLS by design.
--
-- authenticated is left alone — it's used by the Supabase client for any
-- future user-facing app (e.g. the review workflow UI in Stage 4 Phase 4),
-- and its access is still filtered by RLS.

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- Ensure future tables also default to no-anon access.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;

COMMENT ON SCHEMA public IS
  'Application schema. anon role has NO grants (revoked in migration 046). All reads/writes go through service_role or authenticated with RLS filtering. Historical Supabase-default grants revoked following audit v2 S2.';
