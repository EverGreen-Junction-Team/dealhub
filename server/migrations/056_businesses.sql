-- 056_businesses.sql
--
-- Businesses (v5) — first-class business records, synced from GHL.
--
-- Source: GET /businesses/?locationId=X (API version 2021-04-15). The ten
-- fields GHL shows under "Company Info" custom fields come back as native
-- properties on the business object, not in a customFields array — so they map
-- to real columns here rather than JSONB.
--
-- No webhooks. GHL emits nothing when a business is created or edited, so this
-- reconciles on the daily cron, same pattern as tags and custom-field
-- definitions. Soft-delete only: a business that disappears from GHL keeps its
-- row with is_active = false, because contacts and deals still reference it and
-- a hard delete would orphan them.
--
-- contacts.business_id is the link. GHL puts `businessId` on the contact
-- payload but we never promoted it, so this adds the column and backfills from
-- raw_contact — no re-fetch needed.

CREATE TABLE IF NOT EXISTS businesses (
  location_id     TEXT        NOT NULL,
  business_id     TEXT        NOT NULL,               -- GHL's native id
  name            TEXT,
  description     TEXT,
  website         TEXT,
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  postal_code     TEXT,
  country         TEXT,
  -- GHL sends these as objects, not ids. Kept whole rather than picking one
  -- field out, since the shape isn't documented.
  created_by      JSONB,
  updated_by      JSONB,
  raw_business    JSONB,                              -- full payload, future-proofing
  is_active       BOOLEAN     NOT NULL DEFAULT true,  -- false = gone from GHL
  created_at_ghl  TIMESTAMPTZ,
  updated_at_ghl  TIMESTAMPTZ,
  last_synced_at  TIMESTAMPTZ,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, business_id)
);

-- The list page: active businesses for a location, newest-touched first.
CREATE INDEX IF NOT EXISTS businesses_loc_active
  ON businesses (location_id, is_active);

-- Name search, and the global-search entry v5 adds.
CREATE INDEX IF NOT EXISTS businesses_loc_name
  ON businesses (location_id, lower(name));

COMMENT ON TABLE businesses IS
  'GHL business records (v5 Businesses layer). Synced from GET /businesses/ on the daily cron — GHL emits no webhooks for businesses. Soft-delete only: is_active=false when a business vanishes from GHL, because contacts and deals still reference it.';

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON businesses;
CREATE POLICY tenant_iso ON businesses
  USING (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- contacts.business_id — the link between a contact and its business.
--
-- Deliberately NOT a foreign key: the businesses sync and the contacts sync
-- run independently, so a contact can legitimately arrive referencing a
-- business we haven't pulled yet. An FK would reject that write and lose the
-- contact; a plain column keeps it and the join simply finds nothing until the
-- next business sync.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_id TEXT;

CREATE INDEX IF NOT EXISTS contacts_loc_business
  ON contacts (location_id, business_id)
  WHERE business_id IS NOT NULL;

COMMENT ON COLUMN contacts.business_id IS
  'GHL businessId from the contact payload. Not an FK — contacts and businesses sync independently, so the reference can precede the business row.';

-- Backfill from the payloads already stored. GHL has used both spellings, so
-- check each rather than assuming one — a wrong guess backfills nothing and
-- looks like "GHL does not send it".
UPDATE contacts
   SET business_id = COALESCE(
         NULLIF(raw_contact ->> 'businessId', ''),
         NULLIF(raw_contact ->> 'business_id', '')
       )
 WHERE raw_contact IS NOT NULL
   AND business_id IS NULL
   AND (raw_contact ? 'businessId' OR raw_contact ? 'business_id');
