-- 053_custom_field_placeholder.sql
--
-- Promote `placeholder` out of raw_definition.
--
-- GHL lets you set placeholder text on a custom field, and for the MEDDIC
-- fields that placeholder IS the field's description — "What numbers matter",
-- "Who actually signs off the spend". The Control centre was asking the user
-- to retype that into its own input; reading GHL's own text instead means one
-- source of truth and nothing to fill in.
--
-- It's already captured inside raw_definition (see migration 023), so this is
-- a promotion plus a backfill, not a re-fetch.

ALTER TABLE ghl_custom_field_definitions
  ADD COLUMN IF NOT EXISTS placeholder TEXT;

COMMENT ON COLUMN ghl_custom_field_definitions.placeholder IS
  'GHL placeholder text for the field. On the MEDDIC fields this reads as the field''s description, so the Control centre shows it instead of collecting its own. Promoted from raw_definition in migration 053; kept current by customFieldsSync.';

-- Backfill from the payload we already hold. GHL has used both `placeholder`
-- and `placeHolder` across API versions, so check each in turn rather than
-- assuming one — a wrong guess here silently backfills nothing.
UPDATE ghl_custom_field_definitions
   SET placeholder = COALESCE(
         NULLIF(raw_definition ->> 'placeholder', ''),
         NULLIF(raw_definition ->> 'placeHolder', '')
       )
 WHERE raw_definition IS NOT NULL
   AND placeholder IS NULL;
