-- 063_vault_refresh_tokens.sql
--
-- Move the GoHighLevel REFRESH tokens out of a plaintext column and into
-- Supabase Vault, leaving only a uuid reference in `installs`.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY THE REFRESH TOKEN AND NOT BOTH
-- ═════════════════════════════════════════════════════════════════════════
--
-- The two tokens have very different risk profiles, and treating them the
-- same would cost real performance for no security gain:
--
--   access_token   ~24h lifetime, replaced automatically on every refresh.
--                  Read on EVERY GHL API call — ghlRequest calls
--                  ensureFreshToken, which reads the install row. A leaked
--                  one expires on its own within a day.
--
--   refresh_token  INDEFINITE. Our own code keeps the existing value when
--                  GHL does not return a new one:
--                      data.refresh_token || install.refresh_token
--                  So it does not rotate. Whoever holds it can mint fresh
--                  access tokens for as long as the install lives. This is
--                  the credential that matters.
--
-- Vaulting the refresh token puts a decrypt on the REFRESH path — about once
-- a day per location. Vaulting the access token too would put a decrypt on
-- the REQUEST path: every page of every paginated sync, thousands per cron
-- run. That would need an in-memory cache to be viable, which reintroduces a
-- plaintext copy in process memory and buys nothing over a column holding a
-- credential that expires in 24 hours anyway.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT DO
-- ═════════════════════════════════════════════════════════════════════════
--
-- 1. It does not rotate anything. The refresh tokens moved here are the SAME
--    values that have been readable in plaintext for the life of the database
--    and across every backup. They must be assumed compromised and rotated
--    separately, which requires re-consent per sub-account in the GHL
--    marketplace — client coordination, not a deploy.
--
-- 2. It does not remove the need to revoke access. vault.decrypted_secrets is
--    a VIEW, and reading it is a grant like any other. The analyst role must
--    have it revoked (see scripts/create_analyst_role.sql). What Vault buys is
--    that a leak of the `installs` TABLE is now harmless — not that
--    permissions stop mattering.
--
-- 3. It does not encrypt the access_token column. See above.
--
-- ═════════════════════════════════════════════════════════════════════════
-- SAFE TO RE-RUN
-- ═════════════════════════════════════════════════════════════════════════
--
-- The column add is IF NOT EXISTS; the migration loop skips rows that already
-- have a secret id. Re-running does not create duplicate secrets.
--
-- The old column is NOT dropped in this migration. That is deliberate: if the
-- application deploy is rolled back, the previous code still needs the column
-- to authenticate, and dropping it would take all three sub-accounts offline.
-- Dropping happens in a follow-up migration once the new code is confirmed
-- working — see the note at the bottom.

-- ── 1. Vault must be available ───────────────────────────────────────────
--
-- Supabase provisions this, but a local or self-hosted database will not have
-- it. Failing loudly here is better than the migration appearing to succeed
-- and every token write silently going nowhere.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault'
  ) THEN
    RAISE EXCEPTION
      'supabase_vault extension is not installed. Enable Vault for this project '
      '(Dashboard -> Integrations -> Vault) before running this migration.';
  END IF;
END $$;

-- ── 2. The reference column ──────────────────────────────────────────────

ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS refresh_token_secret_id uuid;

COMMENT ON COLUMN installs.refresh_token_secret_id IS
  'vault.secrets id holding this install''s GHL refresh token. The token itself is never stored in this table. Read it via vault.decrypted_secrets, which must NOT be granted to analyst or reporting roles.';

-- ── 3. Move the existing tokens in ───────────────────────────────────────
--
-- One secret per location, named so it is identifiable in the Vault UI
-- without exposing the value. vault.create_secret returns the new uuid.
--
-- Only rows that HAVE a refresh token and do NOT yet have a secret id, so a
-- re-run is a no-op and an uninstalled row (token blanked to '') is skipped.
DO $$
DECLARE
  r        record;
  new_id   uuid;
  moved    int := 0;
  skipped  int := 0;
BEGIN
  FOR r IN
    SELECT location_id, refresh_token
      FROM installs
     WHERE refresh_token IS NOT NULL
       AND refresh_token <> ''
       AND refresh_token_secret_id IS NULL
  LOOP
    new_id := vault.create_secret(
      r.refresh_token,
      'ghl_refresh_token_' || r.location_id,
      'GoHighLevel OAuth refresh token for sub-account ' || r.location_id
    );

    UPDATE installs
       SET refresh_token_secret_id = new_id
     WHERE location_id = r.location_id;

    moved := moved + 1;
  END LOOP;

  SELECT count(*) INTO skipped
    FROM installs
   WHERE refresh_token_secret_id IS NULL;

  RAISE NOTICE 'vault migration: % token(s) moved, % row(s) without a secret (uninstalled or already migrated)',
    moved, skipped;
END $$;

-- ── 4. Blank the plaintext, keep the column ──────────────────────────────
--
-- The VALUE goes now — that is the point of the migration and it is what
-- removes the credential from future backups. The COLUMN stays until the
-- application deploy is confirmed, so a rollback has something to fail
-- against loudly rather than a missing column that crashes on boot.
--
-- Only where the secret exists: never blank a token we failed to move.
UPDATE installs
   SET refresh_token = ''
 WHERE refresh_token_secret_id IS NOT NULL
   AND refresh_token <> '';

-- ── 5. Keep secrets away from reporting roles ────────────────────────────
--
-- Vault's own view. Default grants vary by Supabase version, so this is
-- explicit rather than assumed — the whole exercise fails if an analyst can
-- read the decrypted view.
REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC;
REVOKE ALL ON vault.secrets           FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyst') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM analyst';
    EXECUTE 'REVOKE ALL ON SCHEMA vault FROM analyst';
    RAISE NOTICE 'vault schema revoked from analyst';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- FOLLOW-UP, after the application deploy is confirmed working
-- ═════════════════════════════════════════════════════════════════════════
--
-- Once every sub-account has refreshed successfully against the new code
-- (check the logs for 'GHL token refreshed' from each location, or query
-- installs for a token_expires_at newer than the deploy), drop the column in
-- a separate migration:
--
--   ALTER TABLE installs DROP COLUMN refresh_token;
--
-- Held back deliberately: the column is empty from step 4, so it leaks
-- nothing while it waits, and keeping it means a rollback fails on
-- authentication rather than on a missing column at startup.
