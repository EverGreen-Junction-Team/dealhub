-- 052_contacts_dnd.sql
--
-- Promote DND to real columns.
--
-- Until now DND lived only in contacts.raw_contact (see contactWriter.js:8 —
-- "dnd fields aren't promoted per CSV blueprint scope"). Two things changed
-- that make promotion necessary rather than nice-to-have:
--
--   1. The Deal Hub AI drafts outbound messages, and spec rule 7 makes DND a
--      HARD GATE — a blocked channel cannot be selected for a draft whatever
--      the model suggests. A gate that reads an un-refreshed JSONB blob is not
--      a gate.
--   2. The Contacts UI shows per-channel state ("1 channel off"), which needs
--      to be filterable and indexable, not JSON-extracted per row.
--
-- Shape follows the ContactDndUpdate payload exactly:
--   dnd                  BOOLEAN   — master switch, blocks everything
--   dnd_settings         JSONB     — per-channel { status, message, code }
--                                    keys: SMS, Call, Email, GMB, FB, WhatsApp
--   inbound_dnd_settings JSONB     — { all: { status, message } }
--
-- Per-channel status is 'active' | 'inactive'. NOTE the polarity trap: in
-- GHL's payload `status: "active"` on a channel means the DND rule is active,
-- i.e. the channel is BLOCKED. The generated columns below encode that once so
-- no caller has to remember it.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dnd                  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dnd_settings         JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS inbound_dnd_settings JSONB;

COMMENT ON COLUMN contacts.dnd IS
  'Master do-not-disturb. true = every outbound channel blocked, regardless of dnd_settings.';
COMMENT ON COLUMN contacts.dnd_settings IS
  'Per-channel DND from ContactDndUpdate: { SMS|Call|Email|GMB|FB|WhatsApp: { status, message, code } }. status "active" means the DND rule is active — the channel is BLOCKED.';
COMMENT ON COLUMN contacts.inbound_dnd_settings IS
  'Inbound DND: { all: { status, message } }. Blocks inbound rather than outbound.';

-- ─────────────────────────────────────────────────────────────────────────
-- Generated columns: the polarity rule, encoded once.
--
-- Every consumer (the AI draft gate, the Contacts UI, any future filter) asks
-- the same question: "can I contact this person on channel X?". Deriving that
-- from the JSONB at each call site invites someone getting the
-- active-means-blocked inversion backwards — which would mean messaging a
-- customer who asked not to be. So it's computed here, in one place.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dnd_email BOOLEAN
  GENERATED ALWAYS AS (
    dnd OR (dnd_settings #>> '{Email,status}') = 'active'
  ) STORED;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dnd_sms BOOLEAN
  GENERATED ALWAYS AS (
    dnd OR (dnd_settings #>> '{SMS,status}') = 'active'
  ) STORED;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dnd_call BOOLEAN
  GENERATED ALWAYS AS (
    dnd OR (dnd_settings #>> '{Call,status}') = 'active'
  ) STORED;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dnd_whatsapp BOOLEAN
  GENERATED ALWAYS AS (
    dnd OR (dnd_settings #>> '{WhatsApp,status}') = 'active'
  ) STORED;

-- Inbound is a separate axis: a contact can be blocked outbound but still
-- reach us, or vice versa.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dnd_inbound BOOLEAN
  GENERATED ALWAYS AS (
    (inbound_dnd_settings #>> '{all,status}') = 'active'
  ) STORED;

-- "Show me every contact with any channel blocked" — the Contacts UI badge
-- and any future compliance report.
CREATE INDEX IF NOT EXISTS contacts_dnd_any
  ON contacts (location_id)
  WHERE dnd OR dnd_settings IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill from raw_contact.
--
-- Every contact synced so far has the DND payload sitting in raw_contact —
-- ContactCreate/Update carry dnd + dndSettings even though we never promoted
-- them. So this recovers the current state without re-fetching from GHL.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE contacts
   SET dnd = COALESCE((raw_contact -> 'dnd')::boolean, false),
       dnd_settings = raw_contact -> 'dndSettings',
       inbound_dnd_settings = raw_contact -> 'inboundDndSettings'
 WHERE raw_contact IS NOT NULL
   AND (raw_contact ? 'dnd' OR raw_contact ? 'dndSettings')
   AND dnd_settings IS NULL
   AND dnd = false;
