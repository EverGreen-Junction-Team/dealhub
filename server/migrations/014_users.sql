-- 014_users.sql
--
-- GHL user reference table. One row per (location_id, user_id).
--
-- Populated three ways:
--   1. Live: UserCreate / UserUpdate / UserDelete webhooks
--   2. Backfill: one-time GET /users per location (seed script)
--   3. Legacy: enrichment path (getUserName) will read from this table
--      instead of hitting the GHL API — the API call becomes a cache miss
--      fallback only.
--
-- UserDelete SOFT DELETES (sets active=false, deleted_at=now()). We do NOT
-- drop the row, because tasks/opportunities/stage_history reference the
-- user_id long after they leave the account.
--
-- Per CSV blueprint §1.7 — 5 promoted columns + provenance timestamps.

CREATE TABLE IF NOT EXISTS users (
  location_id     TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT,
  email           TEXT,
  phone           TEXT,
  role            TEXT,                     -- GHL user role (admin/user/etc.)
  active          BOOLEAN DEFAULT true,     -- soft-deletion flag; cleared on UserDelete
  raw_user        JSONB,                    -- full GHL user payload for any fields we haven't promoted
  from_backfill   BOOLEAN NOT NULL DEFAULT false,
  created_at_ghl  TIMESTAMPTZ,
  updated_at_ghl  TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,              -- set on UserDelete; NULL while active
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, user_id)
);

-- Common query shapes:
--   - Resolve user_id → name (enrichment path, hot path)   already covered by PK
--   - "give me all active users in this location"           (location_id, active)
--   - "purge users deleted more than N days ago"            (deleted_at) — rare, keep for audit
CREATE INDEX IF NOT EXISTS users_loc_active ON users (location_id, active);

-- RLS scoped by location like other business tables.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON users;
CREATE POLICY tenant_iso ON users USING (location_id = current_setting('app.location_id', true));
