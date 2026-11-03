-- 017_notes.sql
--
-- GHL notes. One row per (location_id, note_id).
--
-- Populated by webhooks:
--   - NoteCreate → fetch GET /contacts/{contactId}/notes/{noteId} which
--     returns `relations[]` inline; write full row with opportunity_id
--     resolved from the note.relations array (objectKey === 'opportunity').
--   - NoteUpdate → same fetch, UPSERT — overwrite body/updated_at_ghl.
--   - NoteDelete → UPDATE existing row: status='deleted', stamp deleted_at.
--
-- Unlike tasks, the note API returns associations inline so no delay queue
-- is needed. If the association arrives later via RelationCreate (rare),
-- the relation handler updates opportunity_id in real time.
--
-- Notes are REP-AUTHORED context. Never treat as customer evidence for AI
-- extraction — that's opportunity/contact custom fields + messages only.
--
-- Per CSV blueprint §1.15 — 13 columns.

CREATE TABLE IF NOT EXISTS notes (
  location_id       TEXT NOT NULL,
  note_id           TEXT NOT NULL,
  contact_id        TEXT,                                  -- always present in payload
  opportunity_id    TEXT,                                  -- resolved from note.relations OR RelationCreate
  author_user_id    TEXT,                                  -- note.userId
  author_name       TEXT,                                  -- resolved from users table
  body              TEXT,                                  -- unmodified note.body / note.bodyText
  status            TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'deleted' (soft delete)
  raw_note          JSONB,                                 -- full GHL payload for future field extraction
  from_backfill     BOOLEAN NOT NULL DEFAULT false,
  created_at_ghl    TIMESTAMPTZ,                           -- note.dateAdded
  updated_at_ghl    TIMESTAMPTZ,                           -- note.dateUpdated
  deleted_at        TIMESTAMPTZ,                           -- set on NoteDelete
  imported_at       TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, note_id),
  FOREIGN KEY (location_id, contact_id)     REFERENCES contacts (location_id, contact_id),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);

-- Common query shapes:
--   "notes for this contact"                       (location_id, contact_id)
--   "notes for this opportunity"                   (location_id, opportunity_id)
--   "recent notes authored by this rep"            (location_id, author_user_id, created_at_ghl)
--   "note count for the deal card"                 covered by tasks_loc_opp pattern
CREATE INDEX IF NOT EXISTS notes_loc_contact
  ON notes (location_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_loc_opp
  ON notes (location_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_loc_author_created
  ON notes (location_id, author_user_id, created_at_ghl DESC)
  WHERE author_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_loc_status_created
  ON notes (location_id, status, created_at_ghl DESC);

-- RLS scoped by location.
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON notes;
CREATE POLICY tenant_iso ON notes USING (location_id = current_setting('app.location_id', true));
