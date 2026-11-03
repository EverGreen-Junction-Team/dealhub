-- 054_note_links.sql
--
-- Note linking (v5). A note can be attached to a task or to another note, and
-- the UI renders those links as chips on the parent row.
--
-- This is ours, not GHL's: GoHighLevel has no concept of linking a note to a
-- task, so there's nothing to sync and no webhook to reconcile. That also
-- means the link survives independently of the note's own GHL lifecycle —
-- deleting the note in GHL soft-deletes the note row, and the link goes with
-- it via the cascade below.
--
-- Generic (subject_type, subject_id) rather than a task_notes table, because
-- v5 links notes to tasks AND to other notes, and a per-pair table would mean
-- a new table for each future subject.

CREATE TABLE IF NOT EXISTS note_links (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT        NOT NULL,
  -- What the note is attached to.
  subject_type  TEXT        NOT NULL CHECK (subject_type IN ('task', 'note')),
  subject_id    TEXT        NOT NULL,
  -- The note being attached. GHL's note_id, so the link points at the same
  -- identifier the notes table and the API use.
  note_id       TEXT        NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One link per (subject, note): attaching the same note twice is a no-op, not
-- a duplicate chip.
CREATE UNIQUE INDEX IF NOT EXISTS note_links_uniq
  ON note_links (location_id, subject_type, subject_id, note_id);

-- The hot read: "which notes are linked to these tasks" when rendering a list.
CREATE INDEX IF NOT EXISTS note_links_subject
  ON note_links (location_id, subject_type, subject_id);

-- The reverse: "what is this note linked to", for the edit modal.
CREATE INDEX IF NOT EXISTS note_links_note
  ON note_links (location_id, note_id);

COMMENT ON TABLE note_links IS
  'Notes attached to tasks or to other notes (v5 note linking). Local to this app — GHL has no equivalent, so nothing syncs. subject_type/subject_id is generic so future subjects need no new table.';

ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON note_links;
CREATE POLICY tenant_iso ON note_links
  USING (location_id = current_setting('app.location_id', true));
