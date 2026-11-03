-- 071_contacts_assigned_to.sql
--
-- Contact owner, so the Contacts list can filter by rep the way Deals already
-- does (opportunities.assigned_to, migration 001).
--
-- Migration 026 promoted 18 standard GHL contact fields and skipped this one.
-- The WRITE path has always supported it -- services/contactPatch.js maps
-- assignedTo -> assignedTo -- so reps could reassign a contact from our UI and
-- then had no way to filter by the result.
--
-- Two columns, mirroring opportunities:
--   assigned_to       GHL user id -- the stable thing, what we filter on
--   assigned_to_name  display-name snapshot, so the list renders one row per
--                     contact without joining users
--
-- The name is a snapshot and can go stale; reads prefer a live users join
-- and fall back to it, the same pattern as deals.js.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS assigned_to      TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS assigned_to_name TEXT;

-- Partial: the owner filter only ever asks for assigned contacts, and in a
-- fresh sub-account most rows are NULL.
CREATE INDEX IF NOT EXISTS contacts_assigned_to_idx
  ON contacts (location_id, assigned_to)
  WHERE assigned_to IS NOT NULL;

-- Backfill from raw_contact, which migration 026 has stored on every write
-- since. Existing contacts get an owner without waiting for each one to be
-- touched in GHL.
--
-- GHL has used both spellings on the contact payload depending on the source
-- (webhook vs API), so accept either. NULLIF guards the empty string, which
-- GHL sends for "unassigned" -- without it every unassigned contact would get
-- a non-NULL owner of '' and show up in the filtered list.
UPDATE contacts
   SET assigned_to = COALESCE(
         NULLIF(raw_contact->>'assignedTo', ''),
         NULLIF(raw_contact->>'assigned_to', ''))
 WHERE assigned_to IS NULL
   AND raw_contact IS NOT NULL
   AND COALESCE(
         NULLIF(raw_contact->>'assignedTo', ''),
         NULLIF(raw_contact->>'assigned_to', '')) IS NOT NULL;

-- Name the owners we can already identify locally. Contacts whose owner is not
-- in users keep a NULL name and fall back to the id at read time.
UPDATE contacts c
   SET assigned_to_name = u.name
  FROM users u
 WHERE u.location_id = c.location_id
   AND u.user_id     = c.assigned_to
   AND c.assigned_to IS NOT NULL
   AND c.assigned_to_name IS NULL
   AND u.name IS NOT NULL;
