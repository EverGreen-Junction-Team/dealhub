-- 070_saved_views.sql
--
-- Saved views — a named set of filters a rep can come back to.
--
-- The board and table already accept status, search, pipeline, stage, owner
-- and a view mode, but every one of those resets on reload. A rep who works
-- "my open deals in Negotiation" re-applies it several times a day. This is
-- where that combination is kept.
--
-- SHAPE. Filters are JSONB rather than a column each, because the set of
-- filters is still moving — stage and owner were added days after the board
-- itself — and a new filter should not need a migration. The trade is that
-- Postgres cannot validate them; the route does, against the same whitelist
-- the list endpoint uses, so an unknown key is rejected at the door rather
-- than stored and silently ignored on read.
--
-- OWNERSHIP. A view belongs to the user who made it. `is_shared` opens it to
-- the whole sub-account, which is how a manager publishes "Deals needing a
-- quote" for the team. Shared views are readable by everyone in the location
-- and editable only by their owner — a teammate should not be able to change
-- a view out from under the person who made it.
--
-- user_id is GHL's user id from the session, not a local one. It is NOT a
-- foreign key: the users table is a synced cache that can lag a brand-new
-- CRM user, and a view should not fail to save because the person who made
-- it has not synced yet.

CREATE TABLE IF NOT EXISTS saved_views (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT        NOT NULL,
  -- What this view is FOR. 'deals' today; contacts and tasks are the obvious
  -- next ones, and keeping the column means they need no new table.
  scope         TEXT        NOT NULL DEFAULT 'deals',
  user_id       TEXT,
  name          TEXT        NOT NULL,
  -- { status, q, pipelineId, stageId, assignedTo, view }
  filters       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_shared     BOOLEAN     NOT NULL DEFAULT false,
  -- Ordering in the tab strip. Reordering is a later feature; this exists so
  -- adding it does not need a migration.
  position      INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE saved_views IS
  'Named filter sets for the deals board/table. Owned by a user; is_shared
   opens one to the whole sub-account. Filters are validated by the route
   against the list endpoint''s whitelist before being stored.';

-- One name per user per scope: saving "My open deals" twice should update the
-- view, not leave two identically-named tabs the rep cannot tell apart.
-- COALESCE because user_id is nullable and NULLs do not compare equal in a
-- unique index.
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_unique_name
  ON saved_views (location_id, scope, COALESCE(user_id, ''), lower(name));

-- The only read: "every view this user can see, in this scope."
CREATE INDEX IF NOT EXISTS saved_views_lookup
  ON saved_views (location_id, scope, user_id);

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON saved_views;
CREATE POLICY tenant_iso ON saved_views
  USING (location_id = current_setting('app.location_id', true));
