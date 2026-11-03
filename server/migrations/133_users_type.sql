-- 133_users_type.sql
--
-- Promote GHL's user TYPE — 'account' or 'agency' — to its own column, and
-- backfill it from the raw payloads already stored.
--
-- ── WHY ──────────────────────────────────────────────────────────────
-- An agency user belongs to the agency that owns the sub-accounts, not to the
-- sub-account itself. Eduarda Ceregatto is attached to four locations at once
-- with `roles.type = 'agency'`; she is not a sales rep for any of them. Every
-- owner dropdown listed her anyway, and "deals by rep" counted her alongside
-- people who actually sell.
--
-- ── WHY A COLUMN AND NOT A raw_user LOOKUP ───────────────────────────
-- raw_user->'roles'->>'type' works, but it is untyped, unindexed, and has to
-- be repeated at every call site — which is how a filter gets forgotten on
-- the one query that matters. A column can be indexed and defaulted, and the
-- next person adding a user list sees it in \d users.
--
-- ── THE SHAPE PROBLEM THIS ALSO FIXES ────────────────────────────────
-- userWriter read `roles` as an ARRAY (roles[0].type). GHL sends an OBJECT:
--
--   "roles": { "role": "admin", "type": "agency", "locationIds": [...] }
--
-- So `role` came out NULL for every user on this shape, and type was never
-- read at all. The backfill below repairs role from the same payload rather
-- than leaving rows half-populated — see userWriter.js for the live fix.
--
-- NULL is left as NULL, not defaulted to 'account'. A user whose payload
-- predates this and carries no type is UNKNOWN, and treating unknown as
-- "definitely a sales rep" is the assumption that put an agency user in the
-- dropdown in the first place. The queries decide what to do with NULL;
-- this column only records what GHL said.

ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type TEXT;

COMMENT ON COLUMN users.user_type IS
  'GHL roles.type — ''account'' (works for this sub-account) or ''agency'' (works for the agency that owns it). NULL means the payload carried no type. Agency users are excluded from rep lists and owner dropdowns.';

-- Backfill from the raw payload. Both shapes are handled: the object GHL
-- actually sends, and the array the old writer expected, so a row written
-- under either reads correctly.
UPDATE users
   SET user_type = COALESCE(
         raw_user -> 'roles' ->> 'type',
         raw_user -> 'roles' -> 0 ->> 'type',
         raw_user -> 'role'  ->> 'type'
       )
 WHERE user_type IS NULL
   AND raw_user IS NOT NULL;

-- Repair `role` on the same pass. It was NULL wherever roles arrived as an
-- object, which is every user on the current GHL shape.
UPDATE users
   SET role = COALESCE(
         raw_user ->> 'role',
         raw_user -> 'role'  ->> 'type',
         raw_user -> 'roles' ->> 'role',
         raw_user -> 'roles' -> 0 ->> 'type'
       )
 WHERE role IS NULL
   AND raw_user IS NOT NULL;

-- Partial index: every rep list filters to the non-agency users, and that is
-- the only predicate worth indexing here.
CREATE INDEX IF NOT EXISTS users_loc_rep
  ON users (location_id, name)
  WHERE active = true
    AND deleted_at IS NULL
    AND (user_type IS NULL OR user_type <> 'agency');
