-- 142_agency_installs.sql
--
-- Agency-level installs. With the marketplace app distributed as "agency and
-- sub-account", an agency installs ONCE and GHL hands us a COMPANY token
-- (userType Company, no locationId). Sub-account tokens are then minted from
-- it with POST /oauth/locationToken, one per location the agency enabled the
-- app on. This table holds the agency credential; `installs` keeps holding
-- one row per sub-account exactly as before, so nothing downstream changes.
--
-- Refresh tokens live in Vault (migration 063), same as sub-account ones.

CREATE TABLE IF NOT EXISTS agency_installs (
  company_id               TEXT PRIMARY KEY,
  access_token             TEXT NOT NULL DEFAULT '',
  refresh_token_secret_id  UUID,
  token_expires_at         TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  scopes                   TEXT[] NOT NULL DEFAULT '{}',
  installed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  reinstalled_at           TIMESTAMPTZ,
  uninstalled_at           TIMESTAMPTZ,
  reauth_required_at       TIMESTAMPTZ,
  last_location_sync_at    TIMESTAMPTZ
);

-- Where a sub-account's credential came from. 'oauth' is a direct install
-- from inside the sub-account (the only kind until now); 'agency' is a token
-- minted from the agency's. The refresh path uses this: a minted token that
-- cannot be refreshed is re-minted from the agency rather than declared dead.
ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS token_source TEXT NOT NULL DEFAULT 'oauth';

COMMENT ON COLUMN installs.token_source IS
  'oauth = installed from inside the sub-account; agency = token minted from the agency install (agency_installs)';
