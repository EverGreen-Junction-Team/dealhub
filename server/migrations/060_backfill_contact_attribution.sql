-- 060_backfill_contact_attribution.sql
--
-- Promote the nine paid-search attribution fields out of contacts.custom_fields
-- into the typed columns that have existed, empty, since migration 026.
--
-- WHY. The website form has been capturing these since at least 7 August. Every
-- value landed in custom_fields under its GHL key and stopped there:
-- PROMOTED_FIELD_KEYS in contactWriter.js never listed them, and the INSERT
-- never carried the columns. A complete Google Ads chain — click id, campaign,
-- ad group, keyword — sat in the database invisible to every query that reads
-- the columns.
--
-- The writer is fixed, so new contacts populate correctly from now on. This
-- recovers the history. Unlike the field-history defect, nothing was lost:
-- custom_fields still holds every value.
--
-- KEY NAMING. GHL's key is `google_click_id`; our column is `gclid`. The other
-- eight match. That single mismatch is the likely reason the set was missed.
--
-- SHAPE OF custom_fields. contactWriter keys it by GHL's own fieldKey, which
-- INCLUDES the `contact.` prefix — that is why PROMOTED_FIELD_KEYS is written
-- as 'contact.client_type' and not 'client_type'.
--
-- Both forms are tried below regardless. Rows written by the backfill script or
-- by an older path may carry the bare key, and a lookup that misses is far
-- worse here than one extra COALESCE branch: it would silently leave the value
-- unpromoted, which is the exact failure this migration exists to undo.
--
-- SAFE TO RE-RUN. Every UPDATE is guarded on `IS NULL`, so a value already
-- promoted — or edited by hand since — is never overwritten.

-- One statement per column rather than a single wide UPDATE: a column whose
-- key is absent on most rows should not force a rewrite of every row.

UPDATE contacts
   SET gclid = COALESCE(
         NULLIF(custom_fields->>'google_click_id', ''),
         NULLIF(custom_fields->>'contact.google_click_id', ''),
         NULLIF(custom_fields->>'gclid', '')
       )
 WHERE gclid IS NULL
   AND COALESCE(
         NULLIF(custom_fields->>'google_click_id', ''),
         NULLIF(custom_fields->>'contact.google_click_id', ''),
         NULLIF(custom_fields->>'gclid', '')
       ) IS NOT NULL;

UPDATE contacts
   SET gbraid = COALESCE(NULLIF(custom_fields->>'gbraid',''), NULLIF(custom_fields->>'contact.gbraid',''))
 WHERE gbraid IS NULL
   AND COALESCE(NULLIF(custom_fields->>'gbraid',''), NULLIF(custom_fields->>'contact.gbraid','')) IS NOT NULL;

UPDATE contacts
   SET wbraid = COALESCE(NULLIF(custom_fields->>'wbraid',''), NULLIF(custom_fields->>'contact.wbraid',''))
 WHERE wbraid IS NULL
   AND COALESCE(NULLIF(custom_fields->>'wbraid',''), NULLIF(custom_fields->>'contact.wbraid','')) IS NOT NULL;

UPDATE contacts
   SET gad_source = COALESCE(NULLIF(custom_fields->>'gad_source',''), NULLIF(custom_fields->>'contact.gad_source',''))
 WHERE gad_source IS NULL
   AND COALESCE(NULLIF(custom_fields->>'gad_source',''), NULLIF(custom_fields->>'contact.gad_source','')) IS NOT NULL;

UPDATE contacts
   SET utm_source = COALESCE(NULLIF(custom_fields->>'utm_source',''), NULLIF(custom_fields->>'contact.utm_source',''))
 WHERE utm_source IS NULL
   AND COALESCE(NULLIF(custom_fields->>'utm_source',''), NULLIF(custom_fields->>'contact.utm_source','')) IS NOT NULL;

UPDATE contacts
   SET utm_medium = COALESCE(NULLIF(custom_fields->>'utm_medium',''), NULLIF(custom_fields->>'contact.utm_medium',''))
 WHERE utm_medium IS NULL
   AND COALESCE(NULLIF(custom_fields->>'utm_medium',''), NULLIF(custom_fields->>'contact.utm_medium','')) IS NOT NULL;

UPDATE contacts
   SET utm_campaign = COALESCE(NULLIF(custom_fields->>'utm_campaign',''), NULLIF(custom_fields->>'contact.utm_campaign',''))
 WHERE utm_campaign IS NULL
   AND COALESCE(NULLIF(custom_fields->>'utm_campaign',''), NULLIF(custom_fields->>'contact.utm_campaign','')) IS NOT NULL;

UPDATE contacts
   SET utm_content = COALESCE(NULLIF(custom_fields->>'utm_content',''), NULLIF(custom_fields->>'contact.utm_content',''))
 WHERE utm_content IS NULL
   AND COALESCE(NULLIF(custom_fields->>'utm_content',''), NULLIF(custom_fields->>'contact.utm_content','')) IS NOT NULL;

UPDATE contacts
   SET utm_term = COALESCE(NULLIF(custom_fields->>'utm_term',''), NULLIF(custom_fields->>'contact.utm_term',''))
 WHERE utm_term IS NULL
   AND COALESCE(NULLIF(custom_fields->>'utm_term',''), NULLIF(custom_fields->>'contact.utm_term','')) IS NOT NULL;

-- "Which contacts came from paid search" is the query this whole set exists to
-- answer. Partial, because a minority of contacts carry a click id.
CREATE INDEX IF NOT EXISTS contacts_loc_gclid
  ON contacts (location_id, gclid)
  WHERE gclid IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_loc_utm_source
  ON contacts (location_id, utm_source)
  WHERE utm_source IS NOT NULL;

COMMENT ON COLUMN contacts.gclid IS 'Google click id. Source key is contact.google_click_id — the names differ, which is why this went unmapped until migration 060.';
