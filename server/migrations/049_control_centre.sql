-- 049_control_centre.sql
--
-- Per-location AI configuration — the Control centre tab. Everything a
-- location teaches the AI about itself, so the nightly extraction pass
-- (CONTEXT.md §5.3) and any draft-generation surface read business-specific
-- context instead of generic prompting.
--
-- Four sections in the UI map to three tables:
--
--   Tone of voice        → tone_samples        (0..N email samples)
--   MEDDIC mapping       → location_ai_settings.meddic_mapping (JSONB)
--   Product knowledge    → products            (0..N rows)
--   Business information → location_ai_settings.business_info  (TEXT)
--
-- MEDDIC mapping lives in JSONB rather than its own table on purpose: it's a
-- fixed set of six keys the AI reads as one blob, always written together
-- from one form, and never queried by individual field. A table would buy
-- nothing and cost a join.
--
-- Products get a real table because they're an unbounded list the user adds
-- to and deletes from row by row, and later work (flagging promises a rep
-- can't keep against real lead times) will want to query them individually.
--
-- All three are location-scoped with RLS, like every other business table.

-- ─────────────────────────────────────────────────────────────────────────
-- location_ai_settings — one row per location. The singleton config blob.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS location_ai_settings (
  location_id     TEXT        NOT NULL,
  -- Six MEDDIC headings → the location's own definition of each. Keys:
  -- metrics, economic_buyer, decision_criteria, decision_process,
  -- identify_pain, champion. Stored as an object so adding a seventh
  -- heading later is a UI change, not a migration.
  meddic_mapping  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Free-text: deposits, survey process, service area, guarantees.
  business_info   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who last saved, for the "who changed the AI's behaviour" question.
  updated_by      TEXT,
  PRIMARY KEY (location_id)
);

COMMENT ON TABLE location_ai_settings IS
  'Per-location AI configuration singleton (Control centre). One row per location. meddic_mapping = six MEDDIC headings mapped to this business''s language; business_info = free-text context. Read by the nightly extraction pass.';
COMMENT ON COLUMN location_ai_settings.meddic_mapping IS
  'JSONB object keyed by metrics/economic_buyer/decision_criteria/decision_process/identify_pain/champion. Values are the location''s own plain-English definition of each heading.';

ALTER TABLE location_ai_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON location_ai_settings;
CREATE POLICY tenant_iso ON location_ai_settings
  USING (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- tone_samples — writing the AI should imitate. 0..N per location.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tone_samples (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  TEXT        NOT NULL,
  -- Display label in the list. Derived from the first line / subject when
  -- the user pastes without naming it, or the filename on upload.
  title        TEXT        NOT NULL,
  -- The sample text itself. Files are read client-side and land here as
  -- text — we deliberately store no binaries (no storage bucket in this
  -- project, and text is all the AI consumes).
  body         TEXT        NOT NULL,
  -- 'email' | 'sms' | 'note' — what kind of writing this is, so the AI can
  -- match register to channel rather than emailing in SMS voice.
  channel      TEXT        NOT NULL DEFAULT 'email',
  -- 'paste' | 'upload' — provenance, for debugging bad samples.
  source       TEXT        NOT NULL DEFAULT 'paste',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT
);

-- The list view is always "every sample for this location, newest first".
CREATE INDEX IF NOT EXISTS tone_samples_loc_created
  ON tone_samples (location_id, created_at DESC);

COMMENT ON TABLE tone_samples IS
  'Writing samples the AI imitates when drafting (Control centre → Tone of voice). Text only — uploaded files are read client-side and stored as body text.';

ALTER TABLE tone_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON tone_samples;
CREATE POLICY tenant_iso ON tone_samples
  USING (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- products — what the location sells, with lead times. 0..N per location.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  -- Free text, not a number: real answers are ranges ("6–8 weeks") and the
  -- AI quotes them verbatim to the customer. Parsing to an int would lose
  -- the range and invite false precision in drafts.
  lead_time    TEXT,
  notes        TEXT,
  -- Ordering in the UI list. Users think of their catalogue in a deliberate
  -- order (headline product first), so preserve it rather than sorting by
  -- name or created_at.
  position     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_loc_position
  ON products (location_id, position ASC);

-- Same product name twice in one location is a data-entry mistake, and it
-- would make the AI's product lookup ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS products_loc_name_uniq
  ON products (location_id, lower(name));

COMMENT ON TABLE products IS
  'Location product catalogue with lead times (Control centre → Product knowledge). The AI quotes lead_time verbatim in drafts and flags promises that contradict it. lead_time is free text so ranges survive.';

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON products;
CREATE POLICY tenant_iso ON products
  USING (location_id = current_setting('app.location_id', true));
