-- 026_contacts_promote_columns.sql
--
-- Promote GHL contact fields + client-specific custom fields per James's
-- CSV blueprint (Stage 1 · Table 10 · 51 columns total).
--
-- We already have: location_id, contact_id, gclid, gbraid, wbraid, gad_source,
-- utm_source, utm_medium, utm_campaign, utm_content, utm_term, marketing_consent,
-- custom_fields, from_backfill, imported_at, updated_at, tags.
--
-- This migration adds:
--   • Standard GHL identity/contact/address/timezone fields (18)
--   • Promoted custom fields from ghl_custom_field_definitions (16)
--
-- All columns nullable — contacts get progressively enriched via ContactUpdate
-- webhooks and the optional backfill script.
--
-- Soft-delete: deleted_at TIMESTAMPTZ. NULL = active. Set on ContactDelete
-- webhook. We NEVER DROP rows — opportunities/messages FK to contacts.

-- ─── Standard GHL fields ─────────────────────────────────────────────────

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name        TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email             TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone             TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_name      TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_source    TEXT;         -- GHL contact.source (NOT utm_source)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type      TEXT;         -- contact.type: 'lead' | 'customer' | ...
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS date_of_birth     DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address1          TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city              TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state             TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS postal_code       TEXT;         -- text so UK codes like "SW1A 1AA" survive
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country           TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS website           TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timezone          TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_at_ghl    TIMESTAMPTZ;  -- contact.dateAdded
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at_ghl    TIMESTAMPTZ;  -- contact.dateUpdated (API only)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;  -- soft-delete marker (NULL = active)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS raw_contact       JSONB;        -- full API/webhook payload for future-proofing

-- ─── Promoted custom fields (client-specific, from CSV) ─────────────────
-- These stay ALSO in custom_fields JSONB — promoted for cheap analytics.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS client_type                     TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel                         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS product_type                    TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS leadform_enquiry_text           TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS leadform_files                  JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS webchat_inquiry_text            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS webchat_files                   JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enquiries_email_inquiry_text    TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enquiries_email_attachments     JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS crittall_leadform_files         JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS crittall_email_inquiry_text     TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS crittall_email_files            JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_contact_method            JSONB;   -- checkbox array
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS crittall_assignment_checkbox    JSONB;   -- checkbox array
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_value_raw               TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nonleadform_files               JSONB;

-- ─── Indexes for hot filters ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS contacts_loc_email        ON contacts (location_id, email);
CREATE INDEX IF NOT EXISTS contacts_loc_phone        ON contacts (location_id, phone);
CREATE INDEX IF NOT EXISTS contacts_loc_postal_code  ON contacts (location_id, postal_code);
CREATE INDEX IF NOT EXISTS contacts_loc_type         ON contacts (location_id, contact_type);
CREATE INDEX IF NOT EXISTS contacts_loc_source       ON contacts (location_id, contact_source);
CREATE INDEX IF NOT EXISTS contacts_loc_client_type  ON contacts (location_id, client_type);
CREATE INDEX IF NOT EXISTS contacts_loc_channel      ON contacts (location_id, channel);
CREATE INDEX IF NOT EXISTS contacts_loc_product_type ON contacts (location_id, product_type);
-- Partial index for the common "active only" query
CREATE INDEX IF NOT EXISTS contacts_loc_active       ON contacts (location_id) WHERE deleted_at IS NULL;
