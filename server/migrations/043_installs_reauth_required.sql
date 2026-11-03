-- 043_installs_reauth_required.sql
--
-- Surfaces installs whose OAuth credentials are dead (refresh_token no longer
-- accepted by GHL). Set by the ghlClient 401→refresh→retry handler when the
-- second attempt also 401s — that means the refresh_token itself is invalid
-- (revoked, reinstalled elsewhere, etc), not just a stale access_token.
--
-- Reason: without this, sync crons silently 401 forever on a dead install
-- and the sweep cursor never advances. Ops needs a visible flag.
--
-- Cleared automatically on the next successful upsertInstall (a fresh OAuth
-- exchange re-authorises the location and reactivates syncs).

ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS reauth_required_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS installs_reauth_required_idx
  ON installs (reauth_required_at)
  WHERE reauth_required_at IS NOT NULL;

COMMENT ON COLUMN installs.reauth_required_at IS
  'Set by the 401 handler when refresh_token is also rejected. Non-null = install is dead, needs the user to reinstall in GHL Marketplace. Cleared on next successful OAuth upsert.';
