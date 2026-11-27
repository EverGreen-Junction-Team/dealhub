-- 148_calendar_colours.sql
--
-- A colour for each calendar, chosen in Deal Hub, so every booking on the
-- board is drawn in its calendar's colour — the way Google Calendar colours
-- each calendar in its list.
--
-- PER SUB-ACCOUNT, NOT PER PERSON. The calendars here are teams and job
-- types ("Team Iris & Gabriel", "BGD Detailing"); the colour is how a
-- dispatcher and the people they talk to name the same thing on the phone
-- ("the purple ones"), so everyone in the sub-account sees the same colours.
-- updated_by says who last changed one.
--
-- Stored in Deal Hub, not written to GHL's own calendar settings: changing
-- a colour here must not change anything in the CRM.
--
-- A calendar with no row gets a colour from the dashboard's palette by its
-- position in the list, so nothing has to be set before the board is usable.

CREATE TABLE IF NOT EXISTS calendar_colours (
  location_id   TEXT        NOT NULL,
  calendar_id   TEXT        NOT NULL,
  -- '#rrggbb', checked by the route and here.
  colour        TEXT        NOT NULL CHECK (colour ~ '^#[0-9a-f]{6}$'),
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, calendar_id)
);

COMMENT ON TABLE calendar_colours IS
  'The colour each calendar is drawn in on the Deal Hub calendar, per
   sub-account. No row = the dashboard palette''s default for that calendar.';

ALTER TABLE calendar_colours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON calendar_colours;
CREATE POLICY tenant_iso ON calendar_colours
  USING (location_id = current_setting('app.location_id', true));
