-- 003_internal.sql
--
-- App-internal tables (not part of the 4 canonical analytics tables):
--   - installs            OAuth tokens + per-tenant T₀ tracking anchor
--   - pending_opportunities   Orphan-opportunity queue for the daily sweep
--   - processed_events    Idempotency log for webhook redeliveries
--
-- These deliberately DO NOT have RLS enabled — the app needs raw access to
-- iterate across tenants (e.g. for the daily sweep cron).

-- -------------------------------------------------------- installs
-- One row per GHL sub-account that's been installed. installed_at +
-- tracking_started_at are set ON FIRST INSTALL and never updated, even on
-- reinstall — so customers don't lose history just by reinstalling.
CREATE TABLE IF NOT EXISTS installs (
  location_id          TEXT PRIMARY KEY,
  company_id           TEXT,
  user_type            TEXT NOT NULL DEFAULT 'Location',
  -- Tokens are NULLable on purpose: uninstall blanks them out (see ghlClient.markUninstalled).
  -- The not-null invariant is enforced indirectly — any active install (uninstalled_at IS NULL)
  -- always has fresh tokens, because OAuth callback upserts both atomically.
  access_token         TEXT,
  refresh_token        TEXT,
  token_expires_at     TIMESTAMPTZ,
  scopes               TEXT[] NOT NULL DEFAULT '{}',
  installed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),    -- FIRST install (immutable)
  tracking_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),    -- T₀ for forward-only tracking (immutable)
  reinstalled_at       TIMESTAMPTZ,                           -- MOST RECENT install on re-install
  uninstalled_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS installs_active ON installs (location_id) WHERE uninstalled_at IS NULL;

-- ----------------------------------------- pending_opportunities (orphan q)
-- When an opportunity_created webhook fires, we insert here. When the same
-- opportunity later gets a stage_updated webhook, we delete the row. The
-- daily sweep walks anything still present and fires a "still pending"
-- synthetic webhook ONCE, then deletes the row so we don't notify again.
-- Columns pipeline_stage_id and queued_at were later renamed to
-- observed_stage_id and created_event_at (migration 030) to match James's
-- CSV blueprint. Fresh clones still create the original names here; 030's
-- rename block turns them into the blueprint names.
CREATE TABLE IF NOT EXISTS pending_opportunities (
  location_id          TEXT NOT NULL,
  opportunity_id       TEXT NOT NULL,
  contact_id           TEXT,
  pipeline_id          TEXT,
  pipeline_stage_id    TEXT,
  created_at_ghl       TIMESTAMPTZ NOT NULL,
  queued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id)
);
-- The index has to reference whichever column name currently exists.
-- On re-run after migration 030, `queued_at` no longer exists (it's
-- `created_event_at`), and 030 already created the equivalent index
-- (`pending_opportunities_created_event_at`). Do a guarded create so
-- both fresh clones and re-runs succeed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='pending_opportunities' AND column_name='queued_at') THEN
    CREATE INDEX IF NOT EXISTS pending_opportunities_queued
      ON pending_opportunities (queued_at);
  END IF;
END $$;

-- -------------------------------------------------- processed_events
-- Idempotency log. Each GHL webhook carries a unique event id; we record it
-- here BEFORE processing. Duplicate deliveries hit the unique key and we
-- skip them. Rows expire after 14 days via the cleanup job (since pg does
-- not support row TTLs natively).
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     TEXT PRIMARY KEY,
  location_id  TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processed_events_processed_at ON processed_events (processed_at);
