-- 008_message_status.sql
--
-- GHL exposes a delivery status on each message (`status` field on the
-- message object — typical values: 'sent', 'delivered', 'read', 'failed',
-- 'undelivered', 'pending', 'queued'). Without this column we can't answer
-- questions like "what % of outbound SMS in stage X actually got delivered"
-- — every message currently looks identical.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_status TEXT;

-- Filter index for "show me failed messages per opportunity / stage".
CREATE INDEX IF NOT EXISTS messages_loc_status
  ON messages (location_id, message_status);
