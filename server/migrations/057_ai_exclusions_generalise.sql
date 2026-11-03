-- 057_ai_exclusions_generalise.sql
--
-- Extend AI exclusions from messages to notes and tasks.
--
-- Notes were already readable by the agent (spec §1D, rule 7 — first-class
-- citable evidence) but there was no way to exclude one. Tasks were not read at
-- all. A rep who can deselect a message but not a note has an inconsistent
-- control, and the coverage stamp under-reports what the answer was built from.
--
-- Rather than add two more tables, message_ai_exclusions becomes
-- ai_exclusions with a subject_type. Same exclusion-only semantics: NO ROW
-- MEANS INCLUDED, so a newly-synced item defaults in and nothing has to be
-- backfilled.
--
-- The old table is RENAMED, not recreated, so existing exclusions survive.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'message_ai_exclusions')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_name = 'ai_exclusions') THEN
    ALTER TABLE message_ai_exclusions RENAME TO ai_exclusions;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_exclusions (
  location_id     TEXT        NOT NULL,
  opportunity_id  TEXT        NOT NULL,
  subject_id      TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL DEFAULT 'message'
    CHECK (subject_type IN ('message', 'note', 'task')),
  excluded_by     TEXT,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id, subject_type, subject_id)
);

-- Bring the renamed table up to the new shape. message_id becomes the generic
-- subject_id; every existing row is a message by definition.
ALTER TABLE ai_exclusions ADD COLUMN IF NOT EXISTS subject_type TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ai_exclusions' AND column_name = 'message_id') THEN
    ALTER TABLE ai_exclusions RENAME COLUMN message_id TO subject_id;
  END IF;
END $$;

UPDATE ai_exclusions SET subject_type = 'message' WHERE subject_type IS NULL;

ALTER TABLE ai_exclusions ALTER COLUMN subject_type SET DEFAULT 'message';
ALTER TABLE ai_exclusions ALTER COLUMN subject_type SET NOT NULL;

-- The primary key was (location_id, opportunity_id, message_id). It has to
-- include subject_type now, or a note and a message sharing an id would
-- collide.
DO $$
DECLARE pk_name TEXT;
BEGIN
  SELECT conname INTO pk_name
    FROM pg_constraint
   WHERE conrelid = 'ai_exclusions'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ai_exclusions DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE ai_exclusions
  ADD PRIMARY KEY (location_id, opportunity_id, subject_type, subject_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ai_exclusions_subject_type_check') THEN
    ALTER TABLE ai_exclusions ADD CONSTRAINT ai_exclusions_subject_type_check
      CHECK (subject_type IN ('message', 'note', 'task'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_exclusions_loc_opp
  ON ai_exclusions (location_id, opportunity_id, subject_type);

COMMENT ON TABLE ai_exclusions IS
  'Per-deal AI exclusions for messages, notes and tasks. EXCLUSION-ONLY: no row means included, so a newly-synced item defaults in and needs no backfill. Renamed from message_ai_exclusions in migration 057.';

ALTER TABLE ai_exclusions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ai_exclusions;
CREATE POLICY tenant_iso ON ai_exclusions
  USING (location_id = current_setting('app.location_id', true));

-- A view under the old name, so anything still selecting from
-- message_ai_exclusions keeps working until it's migrated.
DROP VIEW IF EXISTS message_ai_exclusions;
CREATE VIEW message_ai_exclusions AS
  SELECT location_id, subject_id AS message_id, opportunity_id, excluded_by, reason, created_at
    FROM ai_exclusions
   WHERE subject_type = 'message';
