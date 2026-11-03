-- 004_installs_nullable_tokens.sql
--
-- Allow access_token / refresh_token / token_expires_at to be NULL on the
-- installs table. We blank these out on uninstall to avoid keeping dead
-- credentials around (see services/ghlClient.markUninstalled).
--
-- 001_schema-style idempotence: ALTER ... DROP NOT NULL is safe to re-run.

ALTER TABLE installs
  ALTER COLUMN access_token     DROP NOT NULL,
  ALTER COLUMN refresh_token    DROP NOT NULL,
  ALTER COLUMN token_expires_at DROP NOT NULL;
