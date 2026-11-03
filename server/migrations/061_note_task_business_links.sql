-- 061_note_task_business_links.sql
--
-- business_id on notes and tasks, so a note or task can record which COMPANY
-- it belongs to as well as which deal.
--
-- WHY. GHL lets a note or task be associated with a contact, an opportunity
-- and a business. We already store the first two — notes.opportunity_id and
-- tasks.opportunity_id have existed since migrations 017 and 015 — but there
-- was nowhere to put the business link, so it was silently dropped on the way
-- in and could not be set on the way out.
--
-- ASSOCIATION SHAPES (from GHL's ghlDefinedAssociations, which are fixed
-- system-defined constants rather than anything a location configures):
--
--   NOTE_OPPORTUNITY_ASSOCIATION   note → opportunity   MANY_TO_ONE   cap 1
--   NOTE_BUSINESS_ASSOCIATION      note → business      MANY_TO_MANY  cap 1000
--   TASK_OPPORTUNITY_ASSOCIATION   task → opportunity   MANY_TO_MANY  cap 10
--   TASK_BUSINESS_ASSOCIATION      task → business      MANY_TO_MANY  cap 10
--
-- A SINGLE COLUMN, NOT A JOIN TABLE, and that is a deliberate narrowing.
--
-- Three of those four are many-to-many, so GHL can hold several businesses on
-- one note. A scalar column models "the one business this is about", which is
-- what the UI offers and what every query we have asks for. It cannot represent
-- a note deliberately filed against two companies.
--
-- The alternative — a note_relations table — is the correct general model, and
-- the right thing to build if the UI ever offers multi-select. It is not built
-- now because nothing reads it: opportunity_id has been scalar since 017 for
-- the same reason and has never been the limiting factor. The raw payload is
-- kept in full (see below), so no data is lost by choosing the narrow column
-- and a later widening can backfill from it.
--
-- NULLABLE, no default. A note about a person and no company is the normal
-- case, and NULL says exactly that.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS business_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS business_id TEXT;

-- NO FOREIGN KEY to businesses, unlike the contact and opportunity links on
-- these tables.
--
-- businesses is populated by a DAILY CRON and has no webhooks at all — GHL
-- fires none for business create/update/delete. So a note can legitimately
-- reference a business created in GHL an hour ago that our table will not know
-- about until tonight. An FK would reject that write and lose the link
-- permanently, which is strictly worse than storing an id we cannot yet join.
--
-- The same reasoning is why opportunity_id DOES carry an FK: opportunities have
-- full webhook coverage, so the parent row is always there first.

CREATE INDEX IF NOT EXISTS notes_loc_business
  ON notes (location_id, business_id)
  WHERE business_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_loc_business
  ON tasks (location_id, business_id)
  WHERE business_id IS NOT NULL;

-- Partial, both of them: only a minority of notes and tasks carry a business,
-- and "everything filed against this company" is the query these exist for.

COMMENT ON COLUMN notes.business_id IS
  'GHL business (company) id from the note''s relations array — NOTE_BUSINESS_ASSOCIATION. No FK: businesses sync daily with no webhooks, so this id may precede its row.';
COMMENT ON COLUMN tasks.business_id IS
  'GHL business (company) id from the task''s relations array — TASK_BUSINESS_ASSOCIATION. No FK, same reason as notes.business_id.';

-- ── Backfill from the payloads we already have ───────────────────────────
--
-- Added for consistency with migration 056 (contacts.business_id), which does
-- exactly this. Without it, only notes and tasks written AFTER this deploy
-- would carry a business — every existing one would read as "no company" when
-- the link is sitting in raw_note/raw_task already.
--
-- SHAPE. GHL stores the links as an array of {objectKey, recordId}:
--
--   "relations": [
--     { "objectKey": "contact",  "recordId": "c1" },
--     { "objectKey": "business", "recordId": "b1" }
--   ]
--
-- FIRST MATCH ONLY. The note→business cap is 1000 and task→business is 10, so
-- the array can hold several; the column is scalar. LIMIT 1 makes that
-- narrowing explicit rather than letting a subquery error on multiple rows.
--
-- jsonb_typeof GUARD, not a bare `->`. jsonb_array_elements throws on a
-- non-array, and `relations` is absent on some webhook shapes and has been seen
-- as a scalar. Without the CASE, one malformed payload aborts the whole
-- migration. (Same lesson as migration 059, where chained ANDs were replaced
-- with CASE because Postgres reorders WHERE conditions.)
--
-- IDEMPOTENT: guarded on business_id IS NULL, so a re-run is a no-op and a
-- value set by hand since is never overwritten.

UPDATE notes
   SET business_id = (
         SELECT r ->> 'recordId'
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(raw_note -> 'relations') = 'array'
                       THEN raw_note -> 'relations'
                       ELSE '[]'::jsonb
                  END
                ) AS r
          WHERE r ->> 'objectKey' = 'business'
            AND NULLIF(r ->> 'recordId', '') IS NOT NULL
          LIMIT 1
       )
 WHERE business_id IS NULL
   AND jsonb_typeof(raw_note -> 'relations') = 'array';

UPDATE tasks
   SET business_id = (
         SELECT r ->> 'recordId'
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(raw_task -> 'relations') = 'array'
                       THEN raw_task -> 'relations'
                       ELSE '[]'::jsonb
                  END
                ) AS r
          WHERE r ->> 'objectKey' = 'business'
            AND NULLIF(r ->> 'recordId', '') IS NOT NULL
          LIMIT 1
       )
 WHERE business_id IS NULL
   AND jsonb_typeof(raw_task -> 'relations') = 'array';

-- Same for the OPPORTUNITY link on notes, which has a real gap.
--
-- noteWriter only ever read objectKey === 'opportunity' from a LIVE fetch. When
-- that fetch failed (404, timeout, rate limit) it fell back to the attribution
-- engine's guess, and the relation in the stored payload was never revisited.
-- So some notes have GHL's own link in raw_note while opportunity_id holds an
-- inferred value or NULL.
--
-- Only fills NULLs. An existing opportunity_id is left alone even if it
-- disagrees: it may have been set by associationRefresher from GHL's API, which
-- is at least as authoritative as this payload, and overwriting it would be a
-- silent reattribution of notes nobody asked for.
UPDATE notes
   SET opportunity_id = (
         SELECT r ->> 'recordId'
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(raw_note -> 'relations') = 'array'
                       THEN raw_note -> 'relations'
                       ELSE '[]'::jsonb
                  END
                ) AS r
          WHERE r ->> 'objectKey' = 'opportunity'
            AND NULLIF(r ->> 'recordId', '') IS NOT NULL
          LIMIT 1
       )
 WHERE opportunity_id IS NULL
   AND jsonb_typeof(raw_note -> 'relations') = 'array'
   -- opportunity_id HAS an FK, unlike business_id, so a value pointing at an
   -- opportunity we have not synced would abort the statement. Only promote
   -- ids we can actually satisfy.
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(raw_note -> 'relations') AS r2
           JOIN opportunities o
             ON o.location_id    = notes.location_id
            AND o.opportunity_id = r2 ->> 'recordId'
          WHERE r2 ->> 'objectKey' = 'opportunity'
       );
