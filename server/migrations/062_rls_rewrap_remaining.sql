-- 062_rls_rewrap_remaining.sql
--
-- Wrap current_setting() in a scalar subselect on the 15 RLS policies that
-- migration 039 did not cover.
--
-- WHY. `location_id = current_setting('app.location_id', true)` is evaluated
-- PER ROW. Postgres cannot prove current_setting is stable, so on a sequential
-- scan it calls it once for every row examined. `(SELECT current_setting(...))`
-- makes it a subquery Postgres evaluates once per statement — same semantics,
-- one call instead of N.
--
-- Supabase's advisor flags this as "Auth RLS Initialization Plan". It is a
-- PERFORMANCE finding, not a security one: the isolation is identical either
-- way, and no row is exposed that was not before. Worth doing because the
-- cost scales with table size, and messages / call_transcriptions are the
-- tables that grow without bound.
--
-- Migration 039 already applied this pattern to 16 policies. These 15 are the
-- tables added after it, plus a few it missed. Nothing here is new thinking —
-- it is the same DROP + CREATE, finishing the job.
--
-- WITH CHECK IS PRESERVED WHERE IT EXISTED. Five of these policies carry a
-- write-side clause as well as a read-side one; ten do not. Recreating all
-- fifteen with USING alone would silently drop the write guard on those five,
-- which would be a real regression introduced by a performance fix. The two
-- groups below are split for exactly that reason — checked against each
-- CREATE POLICY in the migration history rather than assumed uniform.
--
-- SAFE TO RE-RUN: DROP POLICY IF EXISTS, then CREATE.

-- ── Read + write guard (USING + WITH CHECK) ──────────────────────────────
DROP POLICY IF EXISTS tenant_iso ON conversation_providers;
CREATE POLICY tenant_iso ON conversation_providers
  USING      (location_id = (SELECT current_setting('app.location_id', true)))
  WITH CHECK (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON lost_reason_labels;
CREATE POLICY tenant_iso ON lost_reason_labels
  USING      (location_id = (SELECT current_setting('app.location_id', true)))
  WITH CHECK (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON call_recordings;
CREATE POLICY tenant_iso ON call_recordings
  USING      (location_id = (SELECT current_setting('app.location_id', true)))
  WITH CHECK (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON call_transcriptions;
CREATE POLICY tenant_iso ON call_transcriptions
  USING      (location_id = (SELECT current_setting('app.location_id', true)))
  WITH CHECK (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON opportunity_contacts;
CREATE POLICY tenant_iso ON opportunity_contacts
  USING      (location_id = (SELECT current_setting('app.location_id', true)))
  WITH CHECK (location_id = (SELECT current_setting('app.location_id', true)));


-- ── Read guard only (USING) ──────────────────────────────────────────────
-- These carried no WITH CHECK originally and must not gain one: adding a
-- write guard here would change behaviour under the guise of a perf fix.

DROP POLICY IF EXISTS tenant_iso ON location_ai_settings;
CREATE POLICY tenant_iso ON location_ai_settings
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON tone_samples;
CREATE POLICY tenant_iso ON tone_samples
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON products;
CREATE POLICY tenant_iso ON products
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON ai_runs;
CREATE POLICY tenant_iso ON ai_runs
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON ai_feedback;
CREATE POLICY tenant_iso ON ai_feedback
  USING (location_id = (SELECT current_setting('app.location_id', true)));

-- message_ai_exclusions is DELIBERATELY ABSENT.
--
-- It was a table in migration 051, renamed to ai_exclusions in 057, and 057
-- then created a VIEW under the old name for backwards compatibility. A view
-- cannot carry an RLS policy — Postgres rejects it with
-- `"message_ai_exclusions" is not a table`, which is exactly how this
-- migration failed on its first run.
--
-- The underlying table IS covered: see ai_exclusions above.
--
-- The view does NOT inherit that protection, and this migration fixes it —
-- see the security_invoker block at the end. I originally wrote that the view
-- "inherits its policy because RLS is enforced on the base relation", which
-- is wrong: a view runs with its OWNER's rights, the owner here is postgres,
-- and superusers bypass RLS. Verified — the table returned 1 row and the view
-- returned 2 for the same session.
--
-- The bug was in how I generated this list: I parsed CREATE TABLE and
-- CREATE POLICY statements across the migration history without accounting
-- for a later ALTER TABLE ... RENAME. Any list built that way needs checking
-- against the live schema, not just the files.

DROP POLICY IF EXISTS tenant_iso ON note_links;
CREATE POLICY tenant_iso ON note_links
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON business_context;
CREATE POLICY tenant_iso ON business_context
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON businesses;
CREATE POLICY tenant_iso ON businesses
  USING (location_id = (SELECT current_setting('app.location_id', true)));

DROP POLICY IF EXISTS tenant_iso ON ai_exclusions;
CREATE POLICY tenant_iso ON ai_exclusions
  USING (location_id = (SELECT current_setting('app.location_id', true)));


-- ── Compatibility views must not bypass RLS ──────────────────────────────
--
-- A PRE-EXISTING LEAK, found while testing this migration. Not introduced
-- here, but worth fixing in the same change because it defeats tenant
-- isolation on every view we own.
--
-- A view executes with the privileges of its OWNER, not its caller. Our views
-- were created by `postgres`, a superuser, and superusers BYPASS row-level
-- security. So any role that can read a view reads every tenant's rows,
-- however tightly the base table is locked down.
--
-- Measured on a local Postgres with a two-tenant fixture: the base table
-- returned 1 row for a session scoped to locA; the view over it returned 2.
--
-- security_invoker (PostgreSQL 15+) makes the view run as the CALLER, so the
-- base table's policy applies normally. Supabase runs PG15+, but the version
-- is checked rather than assumed — on PG14 the parameter does not exist and
-- ALTER VIEW fails outright.
--
-- This matters immediately: the analyst role is about to be handed to an
-- external analyst, and without this she would read all three sub-accounts
-- through any view regardless of the RESTRICTIVE policies in
-- scripts/create_analyst_role.sql.
DO $$
DECLARE
  v record;
  fixed int := 0;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE NOTICE 'security_invoker needs PG15+; this server is %. Views still run as owner — tenant isolation on views is NOT enforced.',
      current_setting('server_version');
    RETURN;
  END IF;

  FOR v IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'v'
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v.relname);
    fixed := fixed + 1;
  END LOOP;

  RAISE NOTICE 'security_invoker set on % view(s) in public', fixed;
END $$;
