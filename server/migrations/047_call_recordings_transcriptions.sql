-- 047_call_recordings_transcriptions.sql
--
-- Harvest recording URLs + transcriptions for every call message. Two GHL
-- endpoints:
--
--   GET /conversations/messages/{messageId}/locations/{locationId}/recording
--     → binary WAV/MP3. We only store the URL (the request URL itself, or a
--       Location header when returned). We do NOT re-download the audio.
--
--   GET /conversations/locations/{locationId}/messages/{messageId}/transcription
--     → JSON with segment array + full transcript text. We store the joined
--       text and the raw segments JSONB.
--
-- Retry policy (per user directive): NEVER retry on error, except 429 rate
-- limit. Rate limits already handled by axios-retry in ghlClient. So each
-- call gets exactly one non-429 attempt. If GHL 404s or 500s, we log the
-- error and stop.
--
-- Sweep candidate = `messages WHERE is_call = true AND no row in
-- call_recordings|call_transcriptions`. On next sweep, only rows we've
-- never tried get picked up. Rows that failed once stay in their failed
-- status until manually reset.

-- ─────────────────────────────────────────────────────────────────────────
-- call_recordings — URL only, one per (location, message_id)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_recordings (
  location_id      TEXT       NOT NULL,
  message_id       TEXT       NOT NULL,
  recording_url    TEXT,
  content_type     TEXT,
  size_bytes       BIGINT,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_status     TEXT       NOT NULL CHECK (fetch_status IN ('ok', 'not_found', 'unauthorized', 'failed')),
  http_status      INTEGER,
  last_error       TEXT,
  PRIMARY KEY (location_id, message_id)
);

CREATE INDEX IF NOT EXISTS call_recordings_status_idx
  ON call_recordings (location_id, fetch_status);

COMMENT ON TABLE call_recordings IS
  'Per-call recording metadata. URL only — we do not download the audio. One row per (location_id, message_id). Populated by callRecordingSync. Retry policy: never retry on error (except 429, handled by axios-retry).';
COMMENT ON COLUMN call_recordings.recording_url IS
  'GHL API URL that returns the audio. May be a signed redirect that expires — refetch to guarantee playability.';
COMMENT ON COLUMN call_recordings.fetch_status IS
  'ok = 2xx with audio, not_found = 404 (no recording exists), unauthorized = 401/403, failed = other errors.';

ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON call_recordings;
CREATE POLICY tenant_iso ON call_recordings
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- call_transcriptions — full text + raw segments JSONB
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_transcriptions (
  location_id      TEXT       NOT NULL,
  message_id       TEXT       NOT NULL,
  transcript_text  TEXT,
  segments         JSONB,
  language         TEXT,
  provider         TEXT,
  duration_seconds NUMERIC,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_status     TEXT       NOT NULL CHECK (fetch_status IN ('ok', 'not_found', 'unauthorized', 'failed')),
  http_status      INTEGER,
  last_error       TEXT,
  PRIMARY KEY (location_id, message_id)
);

CREATE INDEX IF NOT EXISTS call_transcriptions_status_idx
  ON call_transcriptions (location_id, fetch_status);
CREATE INDEX IF NOT EXISTS call_transcriptions_text_search_idx
  ON call_transcriptions USING gin (to_tsvector('english', COALESCE(transcript_text, '')));

COMMENT ON TABLE call_transcriptions IS
  'Per-call transcription (full text + raw segments). One row per (location_id, message_id). Populated by callRecordingSync. Retry policy: never retry on error (except 429).';
COMMENT ON COLUMN call_transcriptions.segments IS
  'Raw JSONB from GHL — typically [{speaker, start, end, text}, ...]. Shape varies by provider.';
COMMENT ON COLUMN call_transcriptions.fetch_status IS
  'ok = 2xx with content, not_found = 404 (no transcription — feature off or async lag), unauthorized = 401/403, failed = other errors.';

ALTER TABLE call_transcriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON call_transcriptions;
CREATE POLICY tenant_iso ON call_transcriptions
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

COMMENT ON SCHEMA public IS
  'Application schema. anon role has NO grants (revoked in migration 046). All reads/writes go through service_role or authenticated with RLS filtering. Historical Supabase-default grants revoked following audit v2 S2.';
