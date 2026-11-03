-- 139_users_location_ids.sql
--
-- users.location_ids — every sub-account a GHL user is attached to.
--
-- ── WHY ──────────────────────────────────────────────────────────────
--
-- GHL's GET /users/{id} returns:
--
--   "roles": {
--     "type": "agency",
--     "role": "admin",
--     "locationIds": ["IFcSg4...", "E0nGtw...", "fJNuId..."],
--     "restrictSubAccount": false
--   }
--
-- 133 promoted `type` and repaired `role`. The THIRD field was left in
-- raw_user, and it is the one that answers "is this person actually attached
-- to this sub-account?".
--
-- That question has a real symptom. The Deal hub's Co-Pilot sidebar resolves
-- the signed-in user's name by matching their id against the location's user
-- list; an agency admin who owns the sub-account but is not a MEMBER of it is
-- absent from that list, so the name came back null and the avatar rendered
-- as a bare "·". Confirmed against the live API: the agency user's payload
-- carries fJNuIdxGgchGpJ9OoBbk in locationIds while the account user's does
-- not list it at all.
--
-- ── SHAPE ────────────────────────────────────────────────────────────
--
-- TEXT[], not JSONB: this is a flat list of ids that will be membership-tested
-- (`WHERE $1 = ANY(location_ids)`), and an array index serves that where a
-- JSONB containment index would be heavier for no gain.
--
-- NULL means "the payload said nothing", exactly as user_type does — an empty
-- array would claim the user belongs to no sub-account, which is a different
-- statement and one GHL never made.

ALTER TABLE users ADD COLUMN IF NOT EXISTS location_ids TEXT[];

COMMENT ON COLUMN users.location_ids IS
  'GHL roles.locationIds — every sub-account this user is attached to. NULL means the payload carried no list. An agency user who owns a location may still not appear in that location''s own user list; this is how to tell.';

-- Backfill from the raw payload. Both shapes, for the same reason 133 handled
-- both: the object GHL sends, and the array an older writer expected.
UPDATE users
   SET location_ids = ARRAY(
         SELECT jsonb_array_elements_text(
           COALESCE(
             raw_user -> 'roles' -> 'locationIds',
             raw_user -> 'roles' -> 0 -> 'locationIds'
           )
         )
       )
 WHERE location_ids IS NULL
   AND jsonb_typeof(
         COALESCE(
           raw_user -> 'roles' -> 'locationIds',
           raw_user -> 'roles' -> 0 -> 'locationIds'
         )
       ) = 'array';

-- Membership lookups: "every user attached to this sub-account", which is the
-- question the owner dropdown and the sidebar's name lookup both ask.
CREATE INDEX IF NOT EXISTS users_location_ids ON users USING GIN (location_ids);
