-- 059_business_fields.sql
--
-- Add domainname and companylogo, the two documented Business fields migration
-- 056 didn't store. Both live in raw_business today, unread.
--
-- WHY NOW. Businesses become writable in this change. An edit form that shows
-- nine fields and silently drops the tenth is worse than one that shows nine —
-- and domainname in particular is UNIQUE PER LOCATION on the public API, so a
-- rep needs to see the current value before changing it or they get an opaque
-- 422 from GHL.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS or a guarded UPDATE.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS domain_name  TEXT;
-- JSONB, not TEXT: GHL's shape is an array of { url, meta? } (max 1 entry), and
-- flattening it to a url string would lose meta on every write we echo back.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS company_logo JSONB;

-- Backfill from the payload we already hold. NULLIF so an empty string becomes
-- NULL rather than a domain that renders as blank space; the guard keeps this
-- idempotent and stops it overwriting a value already promoted.
UPDATE businesses
   SET domain_name = NULLIF(raw_business->>'domainname', '')
 WHERE domain_name IS NULL
   AND raw_business ? 'domainname'
   AND NULLIF(raw_business->>'domainname', '') IS NOT NULL;

-- CASE, not a chain of ANDs. Postgres does NOT guarantee left-to-right
-- evaluation of WHERE conditions -- the planner reorders them by estimated
-- cost, so jsonb_array_length can be hoisted above the jsonb_typeof guard and
-- run against a scalar. That is exactly what happened: GHL sends companylogo
-- as a bare string on some businesses, and the migration aborted with
-- "cannot get array length of a scalar". CASE is one of the few constructs
-- with defined sequential evaluation.
UPDATE businesses
   SET company_logo = raw_business->'companylogo'
 WHERE company_logo IS NULL
   AND raw_business ? 'companylogo'
   -- GHL sends [] for "no logo". Storing that is indistinguishable from NULL
   -- for every read we do, and NULL is the honest value.
   AND CASE
         WHEN jsonb_typeof(raw_business->'companylogo') = 'array'
           THEN jsonb_array_length(raw_business->'companylogo') > 0
         ELSE false
       END;

-- domainname is unique per location on the public API. This index does NOT
-- enforce that (GHL is the authority, and our copy can be mid-sync), but it
-- makes the duplicate check before a write a lookup rather than a scan.
CREATE INDEX IF NOT EXISTS businesses_loc_domain
  ON businesses (location_id, domain_name)
  WHERE domain_name IS NOT NULL AND is_active = true;

COMMENT ON COLUMN businesses.domain_name  IS 'GHL domainname — bare domain, no protocol, max 253. UNIQUE per location on the public API.';
COMMENT ON COLUMN businesses.company_logo IS 'GHL companylogo — array of { url, meta? }, max 1 entry. url must be https.';
