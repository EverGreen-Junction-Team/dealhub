-- 022_processed_events_status.sql
--
-- Add processing outcome to processed_events. INSERT still happens up-front
-- (dedup requires the row to exist before we know if processing succeeds),
-- but we UPDATE `status` and `error` once the handler resolves — so we can
-- retrospectively query "which webhooks failed and why".
--
-- Match to ghl_raw via event_id (already on both tables); no FK column
-- needed. Retention: unchanged 14-day rolling purge.

ALTER TABLE processed_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'success' | 'failed'
  ADD COLUMN IF NOT EXISTS error  TEXT;                              -- populated on failure

-- Existing rows from before this migration were all successful (they wouldn't
-- have been INSERTed otherwise — pre-migration behaviour). Stamp them so
-- the "unresolved pending" query below never surfaces them.
UPDATE processed_events SET status = 'success' WHERE status = 'pending';

-- Partial index — only the interesting states. 99%+ of rows will be
-- 'success' and don't need an index; failed/pending is the useful subset.
CREATE INDEX IF NOT EXISTS processed_events_status_open
  ON processed_events (processed_at DESC, event_type)
  WHERE status <> 'success';
