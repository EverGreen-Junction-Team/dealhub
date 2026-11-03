-- 001_schema.sql
--
-- The 4 canonical tables described in STAGE_HISTORY_WEBHOOK_PLAN Section 5.
-- Run inside the self-hosted Supabase Postgres on the UK server.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so this migration is safe to
-- run multiple times on the same database during dev.

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- for gen_random_uuid()

-- ---------------------------------------------------------------- contacts
CREATE TABLE IF NOT EXISTS contacts (
  location_id        TEXT NOT NULL,
  contact_id         TEXT NOT NULL,
  -- Note: postcode is intentionally NOT here. The client uses an opportunity-
  -- level postcode (see opportunities.postcode). Contact-level addresses are
  -- carried inside custom_fields for now and only promoted if needed later.
  gclid              TEXT,
  gbraid             TEXT,
  wbraid             TEXT,
  gad_source         TEXT,
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  utm_content        TEXT,
  utm_term           TEXT,
  marketing_consent  BOOLEAN,
  custom_fields      JSONB,
  imported_at        TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, contact_id)
);
CREATE INDEX IF NOT EXISTS contacts_custom_fields_gin ON contacts USING GIN (custom_fields);

-- ----------------------------------------------------------- opportunities
CREATE TABLE IF NOT EXISTS opportunities (
  location_id          TEXT NOT NULL,
  opportunity_id       TEXT NOT NULL,
  contact_id           TEXT NOT NULL,
  name                 TEXT,
  pipeline_id          TEXT,
  pipeline_name        TEXT,
  current_stage_id     TEXT,                                -- live stage id
  current_stage_name   TEXT,                                -- live stage display name
  first_stage_id       TEXT,                                -- stage id at first sighting (set once, never updated)
  first_stage_name     TEXT,                                -- stage display name at first sighting (set once)
  status               TEXT,
  monetary_value       NUMERIC(12, 2),
  assigned_to          TEXT,                                -- GHL user id
  assigned_to_name     TEXT,                                -- human-readable name (resolved by enrichment)
  meddic_1             TEXT, meddic_2  TEXT, meddic_3  TEXT,
  meddic_4             TEXT, meddic_5  TEXT, meddic_6  TEXT,
  meddic_7             TEXT, meddic_8  TEXT, meddic_9  TEXT,
  meddic_10            TEXT,
  client_type          TEXT,
  product_system       TEXT,   -- brand/material — Crittall, Cortizo, Genosal, …
  product_type         TEXT,   -- specific product — Bifold Door, Casement Window, …
  postcode             TEXT,   -- opportunity-level postcode (NOT contact address)
  first_contact_method TEXT,
  lead_source_opportunity TEXT,
  inquiry              TEXT,
  custom_fields        JSONB,
  is_ghost             BOOLEAN DEFAULT false,
  is_deleted           BOOLEAN DEFAULT false,
  created_at_ghl       TIMESTAMPTZ,
  imported_at          TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id),
  FOREIGN KEY (location_id, contact_id) REFERENCES contacts (location_id, contact_id)
);
CREATE INDEX IF NOT EXISTS opportunities_loc_contact ON opportunities (location_id, contact_id);
CREATE INDEX IF NOT EXISTS opportunities_loc_status  ON opportunities (location_id, status);
CREATE INDEX IF NOT EXISTS opportunities_custom_fields_gin ON opportunities USING GIN (custom_fields);

-- ----------------------------------------------------------- stage_history
CREATE TABLE IF NOT EXISTS stage_history (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id                 TEXT NOT NULL,
  opportunity_id              TEXT NOT NULL,
  contact_id                  TEXT NOT NULL,
  stage_id                    TEXT,                  -- stable pipeline_stage_id — CANONICAL
  stage_name                  TEXT NOT NULL,         -- snapshot of display name at this moment
  pipeline_id                 TEXT,
  pipeline_name               TEXT,
  entered_at                  TIMESTAMPTZ NOT NULL,
  left_at                     TIMESTAMPTZ,
  in_stage_duration_seconds   INTEGER,
  current_stage               BOOLEAN DEFAULT false,
  deleted                     BOOLEAN DEFAULT false,
  ghost_opportunity           BOOLEAN DEFAULT false,
  -- Snapshot of opportunity custom fields AT THE MOMENT of this stage change.
  -- opportunities table holds the LIVE value; stage_history rows hold the
  -- HISTORICAL value. Lets us answer "what was the product_type when this
  -- deal was at Sales Qualified?" even after the opportunity was edited.
  product_system              TEXT,
  product_type                TEXT,
  custom_fields_snapshot      JSONB,
  triggered_by                TEXT,                       -- 'opportunity_created' | 'opportunity_stage_updated' | 'daily_sweep'
  imported_at                 TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS stage_history_loc_opp_entered ON stage_history (location_id, opportunity_id, entered_at);
CREATE INDEX IF NOT EXISTS stage_history_loc_stage_id ON stage_history (location_id, stage_id);
CREATE INDEX IF NOT EXISTS stage_history_loc_stage_name ON stage_history (location_id, stage_name);
CREATE INDEX IF NOT EXISTS stage_history_cfs_gin ON stage_history USING GIN (custom_fields_snapshot);
-- Fast path for "find the open stage row for this opportunity" — there is
-- only one at a time, enforced in code via single-writer per opportunity.
CREATE INDEX IF NOT EXISTS stage_history_loc_opp_current ON stage_history (location_id, opportunity_id, current_stage);

-- ---------------------------------------------------------------- messages
CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         TEXT NOT NULL,
  contact_id          TEXT NOT NULL,
  opportunity_id      TEXT,
  stage_history_id    UUID,
  message_id          TEXT,                -- GHL message id (used for dedupe)
  conversation_id     TEXT,
  message_timestamp   TIMESTAMPTZ NOT NULL,
  message_body        TEXT,                -- CLEANED
  message_body_raw    TEXT,                -- original (drop after validation period)
  message_direction   TEXT,
  message_channel     TEXT,
  message_status      TEXT,                       -- 'delivered' | 'failed' | 'read' | 'sent' | 'pending' | ... (GHL's value)
  is_call             BOOLEAN DEFAULT false,
  imported_at         TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id),
  FOREIGN KEY (stage_history_id)             REFERENCES stage_history (id) ON DELETE SET NULL,
  FOREIGN KEY (location_id, contact_id)      REFERENCES contacts (location_id, contact_id)
);
CREATE INDEX IF NOT EXISTS messages_loc_opp_ts ON messages (location_id, opportunity_id, message_timestamp);
CREATE INDEX IF NOT EXISTS messages_loc_contact_ts ON messages (location_id, contact_id, message_timestamp);
CREATE INDEX IF NOT EXISTS messages_loc_stage_history ON messages (location_id, stage_history_id);
-- Used to dedupe re-deliveries: same GHL message_id ⇒ same row.
CREATE UNIQUE INDEX IF NOT EXISTS messages_loc_message_id_uniq ON messages (location_id, message_id) WHERE message_id IS NOT NULL;
