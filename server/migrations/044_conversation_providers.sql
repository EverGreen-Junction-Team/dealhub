-- 044_conversation_providers.sql
--
-- Adds a per-location catalogue of conversation providers (Twilio, Mailgun,
-- SMTP accounts, custom marketplace SMS/Email senders). Messages carry a
-- conversationProviderId — we need the resolved name/type so downstream
-- consumers can say "this SMS came from the WhatsApp custom provider" rather
-- than an opaque id.
--
-- Sync strategy (two-track):
--   1. Daily catalogue sync — hits
--         GET /locations/{locationId}/conversationChannels/SMS
--         GET /locations/{locationId}/conversationChannels/Email
--      once per install per day. Upserts everything the endpoint returns.
--   2. On-demand — when a message arrives with a conversation_provider_id
--      not present in this table, messageWriter fires a fetch for that
--      channel type immediately (per-location advisory lock, re-check on
--      lock acquire). Upserts the returned list.
--
-- Soft-delete: any provider we've cached that stops appearing in a daily
-- sync gets is_deleted=true + deleted_at=now(). Never DROP — historical
-- messages reference these IDs.
--
-- Also promotes conversation_provider_id onto messages (webhook envelopes
-- + /conversations/messages responses both carry it).

CREATE TABLE IF NOT EXISTS conversation_providers (
  location_id             TEXT       NOT NULL,
  provider_id             TEXT       NOT NULL,
  name                    TEXT,
  type                    TEXT       CHECK (type IN ('SMS', 'Email')),
  is_default              BOOLEAN    NOT NULL DEFAULT false,
  is_native               BOOLEAN    NOT NULL DEFAULT false,
  is_deleted              BOOLEAN    NOT NULL DEFAULT false,
  deleted_at              TIMESTAMPTZ,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_via           TEXT       CHECK (last_seen_via IN ('daily_sync', 'on_demand')),
  raw_provider            JSONB,
  PRIMARY KEY (location_id, provider_id)
);

CREATE INDEX IF NOT EXISTS conversation_providers_type_idx
  ON conversation_providers (location_id, type)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS conversation_providers_deleted_idx
  ON conversation_providers (deleted_at)
  WHERE is_deleted = true;

COMMENT ON TABLE conversation_providers IS
  'Per-location catalogue of SMS/Email conversation providers (Twilio, Mailgun, SMTP, custom marketplace senders). Fed by daily sync + on-demand fetch on message ingest.';
COMMENT ON COLUMN conversation_providers.is_native IS
  'true for GHL-managed providers (twilio_provider, mailgun_provider, smtp_provider_*). false for custom marketplace / CP providers with Mongo ObjectIds.';
COMMENT ON COLUMN conversation_providers.is_deleted IS
  'Set when a daily sync no longer returns this provider, or on-demand fetch fails to resolve. Name is preserved for historical context.';

-- RLS — same tenant_iso pattern as the rest of the schema.
ALTER TABLE conversation_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON conversation_providers;
CREATE POLICY tenant_iso ON conversation_providers
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

-- Promote conversation_provider_id on messages so downstream joins/filters
-- don't have to dig through raw_message JSONB.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conversation_provider_id TEXT;

CREATE INDEX IF NOT EXISTS messages_conversation_provider_id_idx
  ON messages (location_id, conversation_provider_id)
  WHERE conversation_provider_id IS NOT NULL;

COMMENT ON COLUMN messages.conversation_provider_id IS
  'Which sender/channel provider handled this message (matches conversation_providers.provider_id). NULL if the webhook payload did not carry it (some older shapes).';
