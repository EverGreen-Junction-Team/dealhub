-- 058_note_fields.sql
--
-- Promote title, color and pinned out of raw_note into real columns.
--
-- WHY NOW. GHL's note API carries all three (documented on Create Note:
-- title max 255, color as a hex string, pinned boolean with a limit of two
-- pinned notes per contact), and migration 017 stored none of them — they have
-- been sitting inside raw_note, unread, since notes first synced.
--
-- That gap is visible in the product. With no title column, the UI derives a
-- heading by splitting the body's first block (splitNote() in NotesTab.jsx),
-- so a note whose author DID give it a title shows that title as body text and
-- invents a heading from the first sentence instead. Now that notes are
-- writable, the editor needs somewhere to put a real title.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS or an idempotent UPDATE.
--
-- BACKFILL. raw_note already holds these fields for every note synced so far,
-- so existing rows are populated from it rather than left null until someone
-- edits them. Notes predating the field in GHL simply have nothing to copy.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS title  TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS color  TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the stored payload.
--
-- NULLIF(...,'') so an empty-string title becomes NULL rather than a heading
-- that renders as blank space. The WHERE clause keeps this idempotent: a second
-- run touches nothing, and it never overwrites a value already promoted.
UPDATE notes
   SET title = NULLIF(raw_note->>'title', '')
 WHERE title IS NULL
   AND raw_note ? 'title'
   AND NULLIF(raw_note->>'title', '') IS NOT NULL;

UPDATE notes
   SET color = NULLIF(raw_note->>'color', '')
 WHERE color IS NULL
   AND raw_note ? 'color'
   AND NULLIF(raw_note->>'color', '') IS NOT NULL;

-- pinned is NOT NULL DEFAULT false, so the only rows worth touching are the
-- ones GHL says are pinned.
UPDATE notes
   SET pinned = true
 WHERE pinned = false
   AND raw_note->>'pinned' = 'true';

-- GHL returns pinned notes first, then newest dateAdded. Our reads sort the
-- same way, so index for it. Partial: pinned notes are a handful per contact
-- (GHL caps them at two), which makes a full index mostly dead weight.
CREATE INDEX IF NOT EXISTS notes_loc_contact_pinned
  ON notes (location_id, contact_id, created_at_ghl DESC)
  WHERE pinned = true AND status = 'active';

COMMENT ON COLUMN notes.title  IS 'GHL note.title (max 255). NULL when the author gave none — the UI then derives a heading from the body.';
COMMENT ON COLUMN notes.color  IS 'GHL note.color, a hex string such as #FFAA00. Set by the author; not a status we compute.';
COMMENT ON COLUMN notes.pinned IS 'GHL note.pinned. GHL allows at most two pinned notes per contact and rejects a third.';
