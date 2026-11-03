-- 002_rls.sql
--
-- Row-Level Security policies per STAGE_HISTORY_WEBHOOK_PLAN Section 6.
-- Every query at runtime sets `app.location_id` for its session; Postgres
-- enforces "you can only see rows where location_id matches".
--
-- BYPASSRLS roles (like the default postgres superuser) skip these checks —
-- so migrations work, but the app's runtime role MUST be a non-superuser.

ALTER TABLE contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON contacts;
DROP POLICY IF EXISTS tenant_iso ON opportunities;
DROP POLICY IF EXISTS tenant_iso ON stage_history;
DROP POLICY IF EXISTS tenant_iso ON messages;

CREATE POLICY tenant_iso ON contacts        USING (location_id = current_setting('app.location_id', true));
CREATE POLICY tenant_iso ON opportunities   USING (location_id = current_setting('app.location_id', true));
CREATE POLICY tenant_iso ON stage_history   USING (location_id = current_setting('app.location_id', true));
CREATE POLICY tenant_iso ON messages        USING (location_id = current_setting('app.location_id', true));

-- The `true` second argument to current_setting() makes it return NULL when
-- the var is unset, rather than raising — important so migrations and admin
-- scripts can read tables without setting the session var. Set the var
-- explicitly with `SET LOCAL app.location_id = '...'` at the start of every
-- per-tenant transaction in the app.
