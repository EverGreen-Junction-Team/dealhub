-- 031_messages_extend.sql
--
-- Complete messages per James's CSV blueprint (Stage 1 · Table 13).
-- Adds 14 columns to support:
--   • Email threading + subject + reply chain (thread_id, subject, reply_to_message_id)
--   • Sender attribution (sender_user_id, sender_name, sender_type)
--   • Call metadata (call_duration_seconds, recording_url)
--   • Audit trail (ingest_event_id, sync_run_id, last_synced_at, cleaning_version)
--   • Soft delete + backfill marker (deleted_at, from_backfill)
--   • Raw payload archive (raw_message JSONB) — future-proofing
--
-- All new columns nullable. Existing rows keep NULL until touched by a
-- webhook, stage-transition fetch, or reconciliation sweep.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id              TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS subject                TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cleaning_version       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_user_id         TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name            TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_type            TEXT;   -- contact / user / automation / system / unknown
ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_duration_seconds  INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recording_url          TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ingest_event_id        TEXT;   -- links to ghl_raw.event_id
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sync_run_id            UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_synced_at         TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at             TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_backfill          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_message            JSONB;

-- Indexes for the hot query paths
CREATE INDEX IF NOT EXISTS messages_loc_thread
  ON messages (location_id, thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_loc_convo_ts
  ON messages (location_id, conversation_id, message_timestamp);
CREATE INDEX IF NOT EXISTS messages_loc_sender_user
  ON messages (location_id, sender_user_id) WHERE sender_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_loc_active
  ON messages (location_id) WHERE deleted_at IS NULL;
