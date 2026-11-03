-- 048_opportunity_contacts_and_channel_normalise.sql
--
-- Two related additions for the Deal Hub UI:
--
-- 1) opportunity_contacts — GHL's OPPORTUNITIES_CONTACTS_ASSOCIATION mirrored
--    locally. One row per (opp, contact) association. Powers the People
--    section on a deal (primary + followers) and lets the timeline attribute
--    inbound messages from any of the linked contacts to the deal.
--    Populated by webhooks (RelationCreate / RelationDelete) + a one-off
--    backfill from GET /associations/relations/{oppId}. Reconciliation
--    deferred by design; we accept short-lived drift.
--
-- 2) messages.message_channel normalisation — historical rows carry a mix of
--    'EMAIL' + 'TYPE_EMAIL', 'SMS' + 'TYPE_CUSTOM_SMS' + 'CUSTOM_SMS', etc.
--    Collapse to a canonical set so downstream filters and the "Email" /
--    "SMS" filter chips work correctly.
--
-- Both parts are idempotent; safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────
-- opportunity_contacts
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS opportunity_contacts (
  location_id     TEXT       NOT NULL,
  relation_id     TEXT       NOT NULL,   -- GHL relation id (stable across create/delete)
  opportunity_id  TEXT       NOT NULL,
  contact_id      TEXT       NOT NULL,
  is_primary      BOOLEAN    NOT NULL DEFAULT false,
  pipeline_id     TEXT,
  association_id  TEXT       NOT NULL,   -- 'OPPORTUNITIES_CONTACTS_ASSOCIATION' (others ignored)
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_via   TEXT       NOT NULL CHECK (last_seen_via IN ('webhook', 'backfill', 'on_demand')),
  raw_relation    JSONB,
  PRIMARY KEY (location_id, relation_id)
);

CREATE INDEX IF NOT EXISTS opportunity_contacts_opp_idx
  ON opportunity_contacts (location_id, opportunity_id);
CREATE INDEX IF NOT EXISTS opportunity_contacts_contact_idx
  ON opportunity_contacts (location_id, contact_id);
CREATE INDEX IF NOT EXISTS opportunity_contacts_primary_idx
  ON opportunity_contacts (location_id, opportunity_id)
  WHERE is_primary = true;

COMMENT ON TABLE opportunity_contacts IS
  'Multi-contact links per opportunity via GHL OPPORTUNITIES_CONTACTS_ASSOCIATION. Populated by RelationCreate/RelationDelete webhooks + one-off backfill. Primary contact matches opportunities.contact_id (source of truth on disagreement: this table).';

ALTER TABLE opportunity_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON opportunity_contacts;
CREATE POLICY tenant_iso ON opportunity_contacts
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- messages.message_channel normalisation
-- ─────────────────────────────────────────────────────────────────────────
--
-- The messageWriter's normaliseChannel() previously uppercased the raw
-- messageType without collapsing variants, leaving us with duplicate
-- channel labels for the same underlying medium. This ONE-TIME update
-- unifies historical rows so the Deal Hub timeline filters see a single
-- 'EMAIL' bucket, single 'SMS', etc. Going forward, messageWriter is
-- updated to store the canonical form directly.

UPDATE messages
   SET message_channel = CASE
     WHEN upper(message_channel) IN ('EMAIL', 'TYPE_EMAIL')                                     THEN 'EMAIL'
     WHEN upper(message_channel) IN ('SMS', 'TYPE_SMS', 'CUSTOM_SMS', 'TYPE_CUSTOM_SMS')        THEN 'SMS'
     WHEN upper(message_channel) IN ('CALL', 'TYPE_CALL')                                       THEN 'CALL'
     WHEN upper(message_channel) IN ('VOICEMAIL', 'TYPE_VOICEMAIL')                             THEN 'VOICEMAIL'
     WHEN upper(message_channel) IN ('WEBCHAT', 'TYPE_WEBCHAT', 'LIVE_CHAT', 'TYPE_LIVE_CHAT')  THEN 'WEBCHAT'
     WHEN upper(message_channel) IN ('WHATSAPP', 'TYPE_WHATSAPP')                               THEN 'WHATSAPP'
     WHEN upper(message_channel) IN ('IMESSAGE', 'TYPE_IMESSAGE')                               THEN 'IMESSAGE'
     WHEN upper(message_channel) IN ('FB', 'TYPE_FACEBOOK', 'FACEBOOK', 'TYPE_FB')              THEN 'FACEBOOK'
     WHEN upper(message_channel) IN ('IG', 'TYPE_INSTAGRAM', 'INSTAGRAM', 'TYPE_IG')            THEN 'INSTAGRAM'
     WHEN upper(message_channel) IN ('FORM_SUBMISSION', 'TYPE_FORM_SUBMISSION')                 THEN 'FORM'
     WHEN upper(message_channel) LIKE 'TYPE_ACTIVITY_%'                                         THEN 'ACTIVITY'
     WHEN upper(message_channel) = 'CUSTOM'                                                     THEN 'CUSTOM'
     ELSE upper(message_channel)
   END
 WHERE message_channel IS NOT NULL
   AND message_channel <> CASE
     WHEN upper(message_channel) IN ('EMAIL', 'TYPE_EMAIL')                                     THEN 'EMAIL'
     WHEN upper(message_channel) IN ('SMS', 'TYPE_SMS', 'CUSTOM_SMS', 'TYPE_CUSTOM_SMS')        THEN 'SMS'
     WHEN upper(message_channel) IN ('CALL', 'TYPE_CALL')                                       THEN 'CALL'
     WHEN upper(message_channel) IN ('VOICEMAIL', 'TYPE_VOICEMAIL')                             THEN 'VOICEMAIL'
     WHEN upper(message_channel) IN ('WEBCHAT', 'TYPE_WEBCHAT', 'LIVE_CHAT', 'TYPE_LIVE_CHAT')  THEN 'WEBCHAT'
     WHEN upper(message_channel) IN ('WHATSAPP', 'TYPE_WHATSAPP')                               THEN 'WHATSAPP'
     WHEN upper(message_channel) IN ('IMESSAGE', 'TYPE_IMESSAGE')                               THEN 'IMESSAGE'
     WHEN upper(message_channel) IN ('FB', 'TYPE_FACEBOOK', 'FACEBOOK', 'TYPE_FB')              THEN 'FACEBOOK'
     WHEN upper(message_channel) IN ('IG', 'TYPE_INSTAGRAM', 'INSTAGRAM', 'TYPE_IG')            THEN 'INSTAGRAM'
     WHEN upper(message_channel) IN ('FORM_SUBMISSION', 'TYPE_FORM_SUBMISSION')                 THEN 'FORM'
     WHEN upper(message_channel) LIKE 'TYPE_ACTIVITY_%'                                         THEN 'ACTIVITY'
     WHEN upper(message_channel) = 'CUSTOM'                                                     THEN 'CUSTOM'
     ELSE upper(message_channel)
   END;
