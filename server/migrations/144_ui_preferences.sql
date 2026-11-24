-- 144_ui_preferences.sql
--
-- How the dashboard is sized, per sub-account and per person.
--
-- WHY THIS EXISTS. The app's scale was a constant in the stylesheet
-- (`zoom: 0.85` on <body>), set once because one client said it felt too
-- zoomed in. That is the wrong shape for the question: a 27" monitor in an
-- office and a 13" laptop on a kitchen table do not want the same number,
-- and neither does a dispatcher who reads the calendar all day next to a
-- manager who opens it twice a week. It needs to be a setting, and a setting
-- needs somewhere to live.
--
-- ── TWO ROWS FOR THE SAME QUESTION ───────────────────────────────────
--
-- user_id NULL  the sub-account's default, which everyone there gets
-- user_id SET   one person's own choice, which beats the default for them
--
-- Resolution is user → account → the built-in defaults in the route. That
-- ordering is the whole point of the feature: an agency sets a sensible
-- house default for a client's team, and anybody whose eyes disagree
-- overrides it without arguing. Deleting a user row falls back to the
-- account's, which is how "reset to the account default" works — it is not a
-- second way of storing the same numbers.
--
-- NULL rather than a separate `scope` column, because the uniqueness rule is
-- the real constraint: exactly one default per location, exactly one
-- override per person. A scope column would let both a NULL user_id and a
-- scope='user' row exist and disagree.
--
-- ── WHY JSONB AND WHAT STOPS IT ROTTING ──────────────────────────────
--
-- Two settings today (zoom and text size), and the next one — density,
-- a theme, a default landing tab — should not need a migration. The cost is
-- that Postgres cannot check the contents, so the route validates every key
-- against a whitelist WITH ITS RANGE and rejects anything else by name. An
-- unvalidated preferences blob is how you end up with `zoom: 0.01` stored,
-- the app unusable, and no way back in to change it.
--
-- user_id is GHL's user id from the session, not a local one, and not a
-- foreign key — the users table is a synced cache that can lag a brand-new
-- CRM user, and somebody should not be unable to set their text size on
-- their first morning.

CREATE TABLE IF NOT EXISTS ui_preferences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT        NOT NULL,
  -- NULL = this sub-account's default for everyone.
  user_id       TEXT,
  -- { zoom: 0.85, textScale: 1 }
  prefs         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Who last changed it. Only meaningful on the account row, where it
  -- answers "who shrank everyone's screen?" — a question that otherwise has
  -- no answer at all and lands on support.
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ui_preferences IS
  'Dashboard appearance (zoom, text size) per sub-account and per user.
   user_id NULL is the account default; a row with user_id overrides it for
   that person. Values are validated against a whitelist and a range by the
   route before being stored.';

-- The rule the table exists to enforce: one default per location, one
-- override per person. COALESCE because NULLs do not compare equal in a
-- unique index, so without it a location could collect any number of
-- "default" rows and the read would pick one at random.
CREATE UNIQUE INDEX IF NOT EXISTS ui_preferences_one_per_scope
  ON ui_preferences (location_id, COALESCE(user_id, ''));

ALTER TABLE ui_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON ui_preferences;
CREATE POLICY tenant_iso ON ui_preferences
  USING (location_id = current_setting('app.location_id', true));
