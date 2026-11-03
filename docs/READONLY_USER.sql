-- Read-only database user for Misha — four named sub-accounts.
--
-- Run in the Supabase SQL editor as the postgres/service role.
-- Replace REPLACE_ME with a real password before running, and send it to
-- Misha out of band — not in a ticket, chat or commit.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY NOT "GRANT SELECT" AND WHY NOT BYPASSRLS
--
-- 33 tables carry Row-Level Security with a policy of the form
--
--     USING (location_id = current_setting('app.location_id', true))
--
-- Unset, current_setting(...) is NULL and `location_id = NULL` is never true,
-- so a plain read-only role sees ZERO rows on every protected table. Empty
-- results, not an error — which reads as "the data is missing".
--
-- BYPASSRLS would fix that but hands over EVERY sub-account, including any
-- added later. Misha needs four, so this adds a second policy naming just
-- those four. Postgres OR's policies together, so the app's own tenant_iso
-- policy is untouched and app behaviour does not change.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. THE ROLE ──────────────────────────────────────────────────────────

CREATE ROLE misha WITH LOGIN PASSWORD 'REPLACE_ME';

-- No ALTER ROLE here on purpose. `ALTER ROLE ... NOSUPERUSER` needs SUPERUSER
-- rights even to clear an attribute the role does not have, and the Supabase
-- SQL editor is not a true superuser — it fails with "permission denied to
-- alter role". It is also unnecessary: NOSUPERUSER, NOBYPASSRLS, NOCREATEDB
-- and NOCREATEROLE are already the defaults for CREATE ROLE. Step 4 verifies
-- that rather than assuming it.

GRANT CONNECT ON DATABASE postgres TO misha;
GRANT USAGE   ON SCHEMA public     TO misha;

-- Postgres grants CREATE on `public` to PUBLIC by default, so without this a
-- "read-only" role can still CREATE TABLE. Tested: it succeeded until this
-- was added.
--
-- If these print "WARNING: no privileges could be revoked for public", the
-- SQL editor's role does not own the schema. That is NOT harmless — verify
-- with the CREATE TABLE check in step 4, and if it still succeeds, run these
-- two lines as the schema owner (Supabase dashboard → Database → Roles) or
-- ask Supabase support. Everything else in this script still applies.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM misha;

GRANT SELECT ON ALL TABLES    IN SCHEMA public TO misha;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO misha;

-- So a table a future migration creates is readable without re-running this.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES    TO misha;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO misha;

-- Belt and braces against a careless future GRANT.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM misha;


-- ── 2. THE FOUR SUB-ACCOUNTS ─────────────────────────────────────────────
--
-- One list, one place. Adding or removing a location later means editing this
-- function and nothing else — the 34 policies below all call it.

CREATE OR REPLACE FUNCTION misha_locations() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
    'E0nGtwuWd1cmeoc6ilD1',
    'fJNuIdxGgchGpJ9OoBbk',
    'IFcSg4YvuVlx56msjbdf',
    'kHcvavc8fEeqkEPTK2T8'
  ]
$$;


-- ── 3. ONE READ POLICY PER RLS TABLE ─────────────────────────────────────
--
-- FOR SELECT TO misha — reads only, and only this role. The app's tenant_iso
-- policy still applies to every other role exactly as before.

DROP POLICY IF EXISTS misha_read ON ai_exclusions;
CREATE POLICY misha_read ON ai_exclusions FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON ai_feedback;
CREATE POLICY misha_read ON ai_feedback FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON ai_runs;
CREATE POLICY misha_read ON ai_runs FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON business_context;
CREATE POLICY misha_read ON business_context FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON businesses;
CREATE POLICY misha_read ON businesses FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON call_recordings;
CREATE POLICY misha_read ON call_recordings FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON call_transcriptions;
CREATE POLICY misha_read ON call_transcriptions FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON contacts;
CREATE POLICY misha_read ON contacts FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON conversation_providers;
CREATE POLICY misha_read ON conversation_providers FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON ghl_custom_field_definitions;
CREATE POLICY misha_read ON ghl_custom_field_definitions FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON ghl_custom_field_folders;
CREATE POLICY misha_read ON ghl_custom_field_folders FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON ghl_raw;
CREATE POLICY misha_read ON ghl_raw FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON location_ai_settings;
CREATE POLICY misha_read ON location_ai_settings FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON lost_reason_labels;
CREATE POLICY misha_read ON lost_reason_labels FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON message_opportunity_map;
CREATE POLICY misha_read ON message_opportunity_map FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON messages;
CREATE POLICY misha_read ON messages FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON note_links;
CREATE POLICY misha_read ON note_links FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON notes;
CREATE POLICY misha_read ON notes FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON opportunities;
CREATE POLICY misha_read ON opportunities FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON opportunity_contacts;
CREATE POLICY misha_read ON opportunity_contacts FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON opportunity_field_history;
CREATE POLICY misha_read ON opportunity_field_history FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON pending_deal_links;
CREATE POLICY misha_read ON pending_deal_links FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON pipeline_stages;
CREATE POLICY misha_read ON pipeline_stages FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON pipelines;
CREATE POLICY misha_read ON pipelines FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON products;
CREATE POLICY misha_read ON products FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON saved_views;
CREATE POLICY misha_read ON saved_views FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON stage_history;
CREATE POLICY misha_read ON stage_history FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON tag_history;
CREATE POLICY misha_read ON tag_history FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON tags;
CREATE POLICY misha_read ON tags FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON task_relations;
CREATE POLICY misha_read ON task_relations FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON tasks;
CREATE POLICY misha_read ON tasks FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON tone_samples;
CREATE POLICY misha_read ON tone_samples FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

DROP POLICY IF EXISTS misha_read ON users;
CREATE POLICY misha_read ON users FOR SELECT TO misha
  USING (location_id = ANY (misha_locations()));

-- schema_migrations has RLS but no location_id — it is the migration
-- ledger, not tenant data. Readable so Misha can see what has run.
DROP POLICY IF EXISTS misha_read ON schema_migrations;
CREATE POLICY misha_read ON schema_migrations FOR SELECT TO misha USING (true);

-- message_ai_exclusions is NOT listed: it is a VIEW over ai_exclusions now
-- (kept under the old name for compatibility), and a policy cannot be put on
-- a view. It inherits ai_exclusions' policy, so Misha reads it correctly.


-- ── 4. VERIFY (run these AS misha) ───────────────────────────────────────

-- Rows from the four locations, no session variable needed:
--   SELECT location_id, count(*) FROM contacts GROUP BY 1 ORDER BY 1;
--   -- expect exactly the four ids and nothing else

-- A location NOT on the list must return 0:
--   SELECT count(*) FROM contacts WHERE location_id = '<some other id>';

-- All of these must fail:
--   INSERT INTO contacts (location_id, contact_id) VALUES ('x','y');
--   UPDATE contacts SET first_name = 'x';
--   DELETE FROM contacts;
--   CREATE TABLE misha_test (id int);

-- The role's actual powers:
--   SELECT rolsuper, rolbypassrls, rolcreatedb, rolcanlogin
--     FROM pg_roles WHERE rolname = 'misha';
--   -- expect f | f | f | t


-- ── 5. CHANGING THE LIST LATER ───────────────────────────────────────────
--   CREATE OR REPLACE FUNCTION misha_locations() ... ;   -- edit the array
-- No policy changes needed.


-- ── 6. REVOKE ────────────────────────────────────────────────────────────
--   DROP OWNED BY misha;       -- drops the policies that reference the role
--   DROP ROLE misha;
--   DROP FUNCTION IF EXISTS misha_locations();
