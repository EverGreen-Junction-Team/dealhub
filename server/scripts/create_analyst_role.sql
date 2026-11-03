-- create_analyst_role.sql
--
-- A read-only login for a data analyst, on the PRIMARY database. No mirror, so
-- there is no second copy of Crittall's customer data to secure and no sync job
-- to break silently.
--
-- Run in the Supabase SQL Editor as the postgres user. Read section 0 first.
--
-- ═════════════════════════════════════════════════════════════════════════
-- 0. TWO THINGS THAT ARE NOT OBVIOUS, both verified against Postgres 14
-- ═════════════════════════════════════════════════════════════════════════
--
-- (a) `ALTER ROLE analyst SET app.location_id = '...'` IS NOT A RESTRICTION.
--
--     It sets a DEFAULT. app.location_id is a custom GUC, and Postgres lets any
--     session override one freely:
--
--         SET app.location_id = 'some-other-location';
--
--     One line, no special privilege, and every RLS policy in migration 002
--     then matches the other tenant instead. Tested: the analyst read another
--     client's private message bodies this way.
--
--     The fix is the RESTRICTIVE policies in section 4. A restrictive policy is
--     AND-ed with the permissive ones, and keys on `current_user` — decided at
--     authentication, with nothing for a SET to override. Ordinary permissive
--     policies are OR-ed, so adding one of those would widen access, not narrow
--     it. That was also tested, and it leaked.
--
-- (b) `REVOKE CREATE ON SCHEMA public FROM analyst` DOES NOTHING.
--
--     On PG 14 and earlier, CREATE on schema public is granted to PUBLIC — the
--     implicit everyone-role — so revoking it from `analyst` individually
--     revokes a grant that role never held. The analyst could still
--     CREATE TABLE. It has to be revoked FROM PUBLIC (section 3).
--
--     PG 15+ removed that default grant, so there the revoke is a no-op that
--     costs nothing. Supabase currently runs PG 15, so check yours:
--         SHOW server_version;
--
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Before you run: set these two values
-- ═════════════════════════════════════════════════════════════════════════
--
-- Find the location id:
--     SELECT location_id, count(*) AS deals
--       FROM opportunities GROUP BY 1 ORDER BY 2 DESC;
--
-- Then replace throughout this file:
--     (no location placeholder any more — the analyst is scoped to every
--      active install, read from the installs table at run time)
--     <PASSWORD>     → a generated password, handed over out of band
--                      (not in the same message as the host details)

-- ── 2. The role ──────────────────────────────────────────────────────────
--
-- Re-runnable. A plain `DROP ROLE IF EXISTS analyst` FAILS on the second run:
-- Postgres refuses to drop a role that still holds grants ("cannot be dropped
-- because some objects depend on it"), and the script would abort at its first
-- statement. So drop the dependencies first, then the role.

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyst') THEN
    -- Policies reference the role by name, so they block the drop too.
    FOR t IN SELECT tablename FROM pg_policies
              WHERE schemaname = 'public' AND policyname = 'analyst_tenant_lock' LOOP
      EXECUTE format('DROP POLICY analyst_tenant_lock ON public.%I', t);
    END LOOP;

    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM analyst';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM analyst';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM analyst';
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM analyst';
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM analyst', current_database());
    EXECUTE 'DROP ROLE analyst';
  END IF;
END $$;

CREATE ROLE analyst
  LOGIN
  PASSWORD '<PASSWORD>'
  NOSUPERUSER          -- verified: cannot self-promote, cannot set BYPASSRLS
  NOCREATEDB
  NOCREATEROLE         -- verified: cannot create a second role to escape with
  NOINHERIT
  CONNECTION LIMIT 5;  -- the app's pool is max:20; this leaves it headroom

-- ── 3. Read-only, and only read ──────────────────────────────────────────

GRANT CONNECT ON DATABASE postgres TO analyst;
GRANT USAGE   ON SCHEMA public     TO analyst;

GRANT SELECT ON ALL TABLES    IN SCHEMA public TO analyst;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO analyst;

-- ── SECRETS: revoked immediately after the blanket grant ─────────────────
--
-- GRANT SELECT ON ALL TABLES includes `installs`, which holds live GoHighLevel
-- OAuth tokens in plaintext. Read access to that one table is full API control
-- of every sub-account — read and write, every contact, opportunity and
-- conversation. It must never be readable by an analyst.
--
-- Revoked rather than granted table-by-table on purpose: an allow-list of ~40
-- tables silently omits the next one a migration adds, and the analyst's
-- reports break in a way nobody traces back. A deny-list of the one table that
-- is dangerous fails the other way — a new table is readable, which is the
-- correct default for analytics.
--
-- The DEFAULT PRIVILEGES below therefore also need care: they would re-grant
-- SELECT on a future table, so anything secret-bearing added later must be
-- added here too. That is a real maintenance burden and the reason to move the
-- tokens into Vault — once installs holds only a secret reference, this
-- revoke stops being the thing standing between an analyst and the CRM.
REVOKE ALL ON TABLE public.installs FROM analyst;

-- Belt and braces: if a later `GRANT ALL ... TO PUBLIC` lands, PUBLIC includes
-- analyst. Revoking from PUBLIC as well closes that route.
REVOKE ALL ON TABLE public.installs FROM PUBLIC;

-- ── AND THE VAULT ────────────────────────────────────────────────────────
--
-- Migration 063 moved the refresh tokens into Supabase Vault, so `installs`
-- now holds a uuid rather than a credential. That is a real improvement, but
-- it MOVES the thing to protect rather than removing it:
-- vault.decrypted_secrets is an ordinary view, and reading it is an ordinary
-- grant.
--
-- So the revoke above is no longer sufficient on its own. Without these two
-- lines an analyst could join installs.refresh_token_secret_id — which is not
-- itself secret — against the decrypted view and read every token.
--
-- Guarded because a database without Vault provisioned has no such schema,
-- and this script should still run there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'vault') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM analyst';
    EXECUTE 'REVOKE ALL ON SCHEMA vault FROM analyst';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA vault REVOKE ALL ON TABLES FROM analyst';
    RAISE NOTICE 'vault schema revoked from analyst';
  ELSE
    RAISE NOTICE 'no vault schema on this database — skipping';
  END IF;
END $$;

-- Tables from FUTURE migrations, automatically. Without this the analyst's
-- reports break the next time a migration lands, in a way nobody connects back
-- to the migration.
--
-- NOTE the interaction with the revoke above: this applies to tables created
-- AFTER this statement runs, so it does not re-grant installs. But a new
-- secret-bearing table WOULD be granted — add an explicit REVOKE beside this
-- one if that ever happens.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO analyst;

-- FROM PUBLIC, not FROM analyst — see 0(b). This is what actually stops
-- CREATE TABLE.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Verified redundant today (SELECT alone confers no write), kept so a later
-- blanket `GRANT ALL ... TO PUBLIC` by someone else cannot quietly make this
-- role writable.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM analyst;

-- ── 4. Tenant lock — ALL sub-accounts, deliberately ──────────────────────
--
-- The analyst needs every sub-account, not one. This section used to pin her
-- to a single location_id with a RESTRICTIVE policy; that is now an ALLOW-LIST
-- of the locations she may see, which is every active install.
--
-- WHAT THIS GIVES UP, stated plainly rather than buried: cross-tenant
-- isolation is no longer enforced for this role. She can read BGD, Veritas,
-- Omnia and the fourth sub-account together. That is the requirement — a
-- pipeline-wide analyst cannot report on a pipeline she can only see a quarter
-- of — but it means the role's remaining protections are the ones doing all
-- the work:
--
--   • no INSERT/UPDATE/DELETE anywhere in public (section 3)
--   • no read on installs, and no read on the vault schema (section 3)
--   • no CREATE in public; her own schema instead (sections 3 and 4b)
--   • no role creation, no policy changes (not an owner, not a superuser)
--
-- WHY KEEP A POLICY AT ALL, if it lists every location?
--
-- Because the app's own RLS (migration 002) is keyed on a session GUC:
--     location_id = current_setting('app.location_id', true)
-- With no GUC set, that returns NULL and every table reads as empty. An
-- analyst would have to SET app.location_id per query and could only ever see
-- one location at a time — which is unusable for exactly the cross-account
-- reporting she is here to do.
--
-- The RESTRICTIVE policy below is AND-ed with migration 002's, so it cannot
-- widen anything. Its job is to bound the role to KNOWN locations, so a row
-- with an unexpected location_id — a bad import, a future sub-account nobody
-- has approved her for — is not silently included.
--
-- It also needs a PERMISSIVE companion, because migration 002's policy fails
-- closed without the GUC. See analyst_all_tenants below.
--
-- FOR ALL rather than FOR SELECT: the grants already block writes, and FOR ALL
-- means a future accidental write grant is still location-bounded.
--
-- Every TENANT-SCOPED table with RLS enabled as of migration 058 — i.e. one
-- that actually has a location_id column. If you add an RLS table later, add
-- it here too — otherwise the analyst sees EVERY tenant's rows in that one
-- table. Re-derive the candidate list with:
--   grep -rh "ENABLE ROW LEVEL SECURITY" migrations/*.sql \
--     | sed 's/.*ALTER TABLE  *//;s/  *ENABLE.*//' | sort -u
-- then check each candidate actually has location_id before adding it —
-- schema_migrations does not (see below) and this loop will fail with
-- "column location_id does not exist" against any table that doesn't.
--
-- schema_migrations is EXCLUDED on purpose: it is a global deploy tracker
-- (filename, applied_at — see migration 038), not tenant data. RLS is enabled
-- on it with NO policy, which is deny-all by design so the anon key can't
-- touch it; the migrate script connects as the service role and bypasses RLS
-- entirely. A location-keyed policy can't be created on a table with no
-- location_id column, so it gets a plain read grant below instead.

DO $$
DECLARE
  t text;
  -- Read from installs rather than hardcoded. A hand-maintained list would
  -- silently omit a sub-account added later, and she would see zero rows for
  -- it with nothing to explain why.
  --
  -- Active installs only: an uninstalled location's data stays in the tables
  -- for its analytics history, and whether she should still see it is a
  -- question for James, not a default. Erring toward less.
  locs text[];
  tables text[] := ARRAY[
    'ai_exclusions', 'ai_feedback', 'ai_runs', 'business_context', 'businesses',
    'call_recordings', 'call_transcriptions', 'contacts', 'conversation_providers',
    'ghl_custom_field_definitions', 'ghl_raw', 'location_ai_settings',
    -- message_ai_exclusions is NOT here: migration 057 renamed it to
    -- ai_exclusions (already in this list) and left a compatibility VIEW
    -- under the old name. The pg_tables check below would skip it anyway,
    -- but a name that cannot match is noise in a security-relevant list.
    'lost_reason_labels', 'message_opportunity_map',
    'messages', 'note_links', 'notes', 'opportunities', 'opportunity_contacts',
    'opportunity_field_history', 'pipeline_stages', 'pipelines', 'products',
    'stage_history', 'tag_history', 'tags', 'tasks',
    'tone_samples', 'users'
  ];
BEGIN
  SELECT array_agg(location_id ORDER BY location_id)
    INTO locs
    FROM installs
   WHERE uninstalled_at IS NULL;

  -- An empty list would create a policy matching nothing, and she would see
  -- zero rows everywhere with no error to explain it. Fail loudly instead.
  IF locs IS NULL OR array_length(locs, 1) = 0 THEN
    RAISE EXCEPTION
      'No active installs found — cannot scope the analyst role to any sub-account';
  END IF;

  RAISE NOTICE 'scoping analyst to % sub-account(s): %', array_length(locs, 1), locs;

  FOREACH t IN ARRAY tables LOOP
    -- Skip anything not present, so this survives a partial migration state
    -- rather than aborting halfway with some tables locked and others open.
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'skipping %, not present', t;
      CONTINUE;
    END IF;

    -- TWO policies per table, and both are needed.
    --
    -- 1. PERMISSIVE, to grant access at all. Migration 002's policy is
    --    `location_id = current_setting('app.location_id', true)`, which is
    --    NULL for a session that never sets the GUC — so without this she
    --    reads nothing anywhere. Permissive policies are OR-ed, so this adds
    --    the access; it is the only policy here that grants.
    --
    -- 2. RESTRICTIVE, to bound it. AND-ed with everything else, so it can
    --    only narrow. Its job is to keep her inside the KNOWN locations —
    --    a row with an unexpected location_id is excluded rather than
    --    silently visible.
    --
    -- Scoped TO analyst, so the app's runtime role is untouched by both.
    EXECUTE format('DROP POLICY IF EXISTS analyst_all_tenants ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY analyst_all_tenants ON public.%I '
      'FOR SELECT TO analyst USING (location_id = ANY (%L))', t, locs
    );

    EXECUTE format('DROP POLICY IF EXISTS analyst_tenant_lock ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY analyst_tenant_lock ON public.%I AS RESTRICTIVE '
      'FOR ALL TO analyst USING (location_id = ANY (%L))', t, locs
    );
  END LOOP;
END $$;

-- schema_migrations, handled separately: it has no location_id (migration
-- 038), so it cannot take the location-keyed policy above, but RLS is still
-- enabled on it with no policy of its own — deny-all by design (see the
-- comment by the tables[] list). Without an explicit grant here the section 3
-- blanket SELECT is silently useless against it and she reads zero rows with
-- nothing to explain why. It is deploy history, not tenant data, so a plain
-- USING (true) is the correct policy — there is nothing to bound it to.
DROP POLICY IF EXISTS analyst_read ON public.schema_migrations;
CREATE POLICY analyst_read ON public.schema_migrations
  FOR SELECT TO analyst USING (true);

-- NO ROLE DEFAULT for app.location_id, and removing it was necessary.
--
-- It used to be set here as a convenience: it satisfied migration 002's
-- permissive policy so the analyst did not have to SET it in every client.
--
-- That breaks multi-tenant access. Migration 002's policy is
-- `location_id = current_setting('app.location_id', true)`, so a default of
-- one location would restrict her to that location — the opposite of the
-- requirement — and she would have to unset or override it to see anything
-- else, which is both confusing and (per section 0a) trivially bypassable.
--
-- The analyst_all_tenants policy in section 4 grants the access instead, and
-- does not depend on a GUC at all. Nothing to set, nothing to override.

-- ── 4b. A schema she OWNS, so read-only does not mean cannot work ────────
--
-- An analyst does need somewhere to write: intermediate tables, a rolled-up
-- summary to query repeatedly instead of recomputing, a scratch table while
-- reconciling two figures. Refusing that outright means the work happens in
-- spreadsheets exported from the database, which is worse for everyone.
--
-- So: read-only on `public`, OWNER of `analyst_scratch`. She can CREATE, DROP
-- and TRUNCATE freely in her own schema and cannot touch ours.
--
-- WHY THIS IS SAFE, given PITR is currently disabled and the finest restore
-- point is a whole day:
--
--   • Nothing in analyst_scratch is on the sync path. Losing all of it costs
--     her a rebuild, not our data.
--   • She has no INSERT/UPDATE/DELETE on public (section 3), so the accident
--     James is worried about — a bad UPDATE on live rows — is not available to
--     her regardless of what she does in here.
--   • The restrictive policies in section 4 are scoped to `public.%I`, so they
--     do not apply to her schema. That is deliberate: her own tables are hers
--     to shape, and locking them to one location_id would break a legitimate
--     cross-location aggregate she built FROM data she is already allowed to
--     read.

-- Changing a schema's owner to a role ALWAYS requires the executing role to
-- be able to SET ROLE into the new owner -- this is a standing Postgres rule
-- (see the CREATE SCHEMA / ALTER SCHEMA docs), not something version-specific,
-- and it applies to both `CREATE SCHEMA ... AUTHORIZATION analyst` and a
-- separate `ALTER SCHEMA ... OWNER TO analyst`. Supabase's `postgres` role is
-- not a true superuser and is not automatically a member of a role it just
-- created in this same script, so either form fails with
-- `must be able to SET ROLE "analyst"` (42501) until postgres is granted
-- membership in analyst.
--
-- GRANT analyst TO postgres gives exactly that membership -- a role with
-- CREATEROLE can grant itself membership in a role it created. It is revoked
-- again immediately after, so postgres does not retain standing access to
-- analyst's (read-only, tenant-locked) privileges once the schema exists.
GRANT analyst TO postgres;
CREATE SCHEMA IF NOT EXISTS analyst_scratch AUTHORIZATION analyst;
REVOKE analyst FROM postgres;

-- Explicit, though ownership implies it — so a later blanket revoke on the
-- database does not silently strip her own workspace.
GRANT USAGE, CREATE ON SCHEMA analyst_scratch TO analyst;

-- NOT in her search_path by default: `public` first means an unqualified
-- SELECT reads OUR data, and a table she creates without qualifying lands in
-- her schema because that is where CREATE resolves for a non-superuser
-- lacking CREATE on public. Set it explicitly so both halves are predictable.
ALTER ROLE analyst SET search_path = analyst_scratch, public;

-- A size ceiling is NOT set here because Postgres has no per-schema quota.
-- If runaway scratch tables become a real problem the lever is a tablespace
-- with a filesystem quota, or simply asking her. Worth stating plainly rather
-- than implying this is bounded when it is not.

-- ── 5. Query limits, so a runaway report cannot take the app down ─────────
--
-- This is the protection a mirror would otherwise be providing. A cartesian
-- join across messages would hold CPU and locks while the live dashboard waits.

ALTER ROLE analyst SET statement_timeout = '60s';
ALTER ROLE analyst SET idle_in_transaction_session_timeout = '120s';  -- a BI tool
  -- left open overnight holds locks and blocks VACUUM otherwise
ALTER ROLE analyst SET lock_timeout = '5s';
ALTER ROLE analyst SET work_mem = '32MB';   -- big sorts spill to disk instead of
                                            -- competing for memory

-- ═════════════════════════════════════════════════════════════════════════
-- 6. VERIFY — as the analyst, before handing over the password
-- ═════════════════════════════════════════════════════════════════════════
--
-- Run these on a SEPARATE connection using the analyst's credentials. As
-- postgres they all pass and prove nothing.
--
--   -- Should return rows:
--   SELECT count(*) FROM opportunities;
--
--   -- THE ONE THAT MATTERS. Should print 0 both times:
--   SET app.location_id = 'some-other-location';
--   SELECT count(*) FROM opportunities;
--   SELECT count(*) FROM messages;
--
--   -- Should all FAIL:
--   UPDATE opportunities SET name = 'x' WHERE false;   -- permission denied
--   CREATE TABLE scratch (x int);                      -- permission denied for schema
--   ALTER ROLE analyst BYPASSRLS;                      -- must be superuser
--   CREATE ROLE other LOGIN;                           -- permission denied
--   SELECT rolpassword FROM pg_authid LIMIT 1;         -- permission denied
--
--   -- Should be cancelled at 60s:
--   SELECT pg_sleep(90);
--
-- If the first query returns 0, check: SELECT current_setting('app.location_id', true);
-- A mismatch between that and the policies in section 4 means no rows.

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Revoking access, when the engagement ends
-- ═════════════════════════════════════════════════════════════════════════
--
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM analyst;
--   REVOKE ALL ON SCHEMA public FROM analyst;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM analyst;
--   -- The restrictive policies reference the role, so they must go first:
--   DO $$ DECLARE t text; BEGIN
--     FOR t IN SELECT tablename FROM pg_policies
--               WHERE policyname = 'analyst_tenant_lock' LOOP
--       EXECUTE format('DROP POLICY analyst_tenant_lock ON public.%I', t);
--     END LOOP;
--   END $$;
--   DROP ROLE analyst;
