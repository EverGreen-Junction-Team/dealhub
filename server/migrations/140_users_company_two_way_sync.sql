-- Users: the agency they belong to, and their two-way email sync.
--
-- company_id — GET /users/search needs it as a query parameter, and the
-- install row's company_id is the only place we held it. Stored per user
-- so a user row is self-describing and the sync can be re-run from users
-- alone.
--
-- two_way_sync — GHL's `twoWaySync` block: { gmail: { email, integrationId } }
-- (or outlook). Kept as the raw object plus the one field the app reads —
-- the address, promoted so the providers route and the send path can offer
-- "send this email from my Gmail" without parsing JSON in SQL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_way_sync        JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_way_sync_email  TEXT;

-- Backfill from what was already in raw_user.
UPDATE users
   SET two_way_sync       = raw_user->'twoWaySync',
       two_way_sync_email = COALESCE(raw_user->'twoWaySync'->'gmail'->>'email',
                                     raw_user->'twoWaySync'->'outlook'->>'email')
 WHERE raw_user ? 'twoWaySync' AND two_way_sync IS NULL;

UPDATE users u
   SET company_id = i.company_id
  FROM installs i
 WHERE i.location_id = u.location_id AND u.company_id IS NULL AND i.company_id IS NOT NULL;
