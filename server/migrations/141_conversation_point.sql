-- 141_conversation_point.sql
--
-- CONVERSATION POINT — provider-agnostic call recording + transcription.
--
-- James's brief (24 Oct 2026): record and transcribe every call, link it to
-- the right contact, deal and rep, and feed transcripts into insights. One
-- connector per phone provider (Allo first; Aircall, RingCentral, Ringover,
-- HiHi later). From each provider we take ONLY the audio recording and the
-- call metadata. Provider transcripts are ignored — we transcribe every call
-- ourselves (OpenAI Whisper) so the format is the same across providers.
--
-- Tables:
--   call_providers    per-location connector credentials + settings
--   call_events       raw webhook events, as received (audit + replay)
--   calls             the canonical call — one row per (provider, call id)
--   call_transcripts  our own transcript per call (segments w/ timestamps)
--   call_jobs         step queue: match → download → transcribe → ghl_sync
--   call_user_map     provider user / extension / number → GHL user
--
-- The GHL-side mirror (messages.is_call, call_recordings,
-- call_transcriptions keyed by GHL message_id) stays as it is. Once a call is
-- synced to GHL the worker writes our transcript into call_transcriptions
-- under the new message_id, so the Deal Hub timeline and Deal AI see it
-- through the path they already use.

-- ─── call_providers ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_providers (
  location_id          TEXT NOT NULL,
  provider             TEXT NOT NULL,                  -- allo | aircall | ringcentral | ringover | hihi
  enabled              BOOLEAN NOT NULL DEFAULT true,
  api_key              TEXT,                           -- provider REST API key (Allo: Authorization: Api-Key)
  webhook_secret       TEXT,                           -- HMAC secret for inbound webhooks
  provider_account_id  TEXT,                           -- workspace / account id on the provider side
  webhook_id           TEXT,                           -- id of the webhook we registered with the provider
  settings             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- settings keys (all optional):
  --   default_country   'GB'                 national → E.164 default
  --   rep_channel       'left' | 'right'     which stereo channel is the rep (dual-channel recordings)
  --   our_numbers       ['+44…', …]          numbers that belong to the business (direction sanity)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, provider)
);

ALTER TABLE call_providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON call_providers;
CREATE POLICY tenant_iso ON call_providers
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

COMMENT ON TABLE call_providers IS
  'Conversation Point: per-location phone-provider connector config. One row per (location, provider).';

-- ─── call_events ─────────────────────────────────────────────────────────
-- Every webhook we receive, verbatim, before any interpretation. Internal
-- table (no RLS) like processed_events: the worker reads it with rawQuery.

CREATE TABLE IF NOT EXISTS call_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        TEXT,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT,                              -- webhook-id header / payload id; dedup key
  topic              TEXT,                              -- call.completed, call.answered, …
  provider_call_id   TEXT,
  payload            JSONB NOT NULL,
  headers            JSONB,
  signature_ok       BOOLEAN,
  status             TEXT NOT NULL DEFAULT 'received',  -- received | processed | ignored | failed
  error              TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS call_events_provider_event
  ON call_events (provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_events_loc_received
  ON call_events (location_id, received_at DESC);
CREATE INDEX IF NOT EXISTS call_events_call
  ON call_events (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;

COMMENT ON TABLE call_events IS
  'Conversation Point: raw provider webhook events. Audit trail + replay source. Never mutated except status/error.';

-- ─── calls ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id                TEXT NOT NULL,
  provider                   TEXT NOT NULL,
  provider_call_id           TEXT NOT NULL,

  -- Metadata (the only thing we take from the provider besides audio)
  direction                  TEXT,                     -- inbound | outbound | internal | unknown
  result                     TEXT,                     -- answered | missed | voicemail | busy | failed | unknown
  from_number                TEXT,                     -- as the provider sent it
  to_number                  TEXT,
  from_e164                  TEXT,
  to_e164                    TEXT,
  customer_number            TEXT,                     -- E.164 of the external party (derived from direction)
  our_number                 TEXT,                     -- E.164 of the business line / DDI involved
  extension                  TEXT,                     -- extension that handled the call, when the provider says
  provider_user_id           TEXT,                     -- the provider's own user id for the rep
  provider_user_email        TEXT,
  provider_user_name         TEXT,
  started_at                 TIMESTAMPTZ,
  answered_at                TIMESTAMPTZ,
  ended_at                   TIMESTAMPTZ,
  duration_seconds           INTEGER,                  -- total, as the provider reports
  talk_seconds               INTEGER,                  -- answered → ended, when derivable

  -- Recording (our copy — the provider URL may expire)
  recording_url              TEXT,                     -- provider's URL, as received
  recording_status           TEXT NOT NULL DEFAULT 'pending',  -- pending | stored | none | failed
  recording_storage          TEXT,                     -- local | supabase
  recording_key              TEXT,                     -- path / object key in that storage
  recording_content_type     TEXT,
  recording_bytes            BIGINT,
  recording_channels         INTEGER,                  -- 1 mono / 2 stereo (dual-channel = free speaker labels)
  recording_duration_seconds NUMERIC,
  recording_error            TEXT,

  transcript_status          TEXT NOT NULL DEFAULT 'pending',  -- pending | done | none | failed

  -- Matching
  contact_id                 TEXT,
  contact_match_method       TEXT,                     -- db_phone | ghl_search | manual | none
  user_id                    TEXT,                     -- GHL user (the rep)
  user_match_method          TEXT,                     -- map_user | email | map_extension | map_number | users_phone | manual | none
  opportunity_id             TEXT,
  deal_match_status          TEXT,                     -- mapped | ambiguous | unassigned | excluded_multi_open | manually_resolved
  deal_match_rule            TEXT,
  deal_match_confidence      NUMERIC(4,3),
  match_status               TEXT NOT NULL DEFAULT 'pending',  -- pending | matched | partial | unmatched

  -- GHL mirror
  ghl_message_id             TEXT,
  ghl_conversation_id        TEXT,
  ghl_sync_status            TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | skipped | failed
  ghl_sync_error             TEXT,
  ghl_synced_at              TIMESTAMPTZ,

  raw                        JSONB,                    -- the normalised-from payload, for re-normalising later
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (location_id, provider, provider_call_id)
);

CREATE INDEX IF NOT EXISTS calls_loc_started     ON calls (location_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_loc_contact     ON calls (location_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_loc_opp         ON calls (location_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_loc_user        ON calls (location_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_loc_match       ON calls (location_id, match_status);
CREATE INDEX IF NOT EXISTS calls_loc_ghl_message ON calls (location_id, ghl_message_id) WHERE ghl_message_id IS NOT NULL;

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON calls;
CREATE POLICY tenant_iso ON calls
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

COMMENT ON TABLE calls IS
  'Conversation Point: one row per phone call from any provider. Source of truth for call analytics. Audio lives in recording_storage/recording_key; transcript in call_transcripts.';

-- ─── call_transcripts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_transcripts (
  call_id            UUID PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  location_id        TEXT NOT NULL,
  text               TEXT,
  -- [{ speaker, start, end, text }] — start/end in seconds from call start.
  -- speaker is 'rep' | 'customer' when known, 'speaker_1' | 'speaker_2' when
  -- the channels are split but unlabelled, null when mono + no diarization.
  segments           JSONB,
  language           TEXT,
  model              TEXT,                              -- whisper-1 | gpt-4o-transcribe | …
  speaker_method     TEXT,                              -- dual_channel | diarization | none
  duration_seconds   NUMERIC,
  -- { gaps: n, silence_seconds, longest_gap_seconds, talk_seconds_by_speaker: {…}, talk_ratio }
  silence_stats      JSONB,
  status             TEXT NOT NULL DEFAULT 'done',      -- done | failed
  error              TEXT,
  transcribed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_transcripts_loc ON call_transcripts (location_id);
CREATE INDEX IF NOT EXISTS call_transcripts_fts
  ON call_transcripts USING gin (to_tsvector('english', COALESCE(text, '')));

ALTER TABLE call_transcripts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON call_transcripts;
CREATE POLICY tenant_iso ON call_transcripts
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

COMMENT ON TABLE call_transcripts IS
  'Conversation Point: OUR transcript of a call (not the provider''s). Same shape for every provider.';

-- ─── call_jobs ───────────────────────────────────────────────────────────
-- Postgres-backed step queue. Internal (no RLS). One process polls it
-- (PM2 runs a single instance), FOR UPDATE SKIP LOCKED keeps it safe if a
-- second one ever appears.

CREATE TABLE IF NOT EXISTS call_jobs (
  id            BIGSERIAL PRIMARY KEY,
  call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL,
  step          TEXT NOT NULL,                          -- match | download | transcribe | ghl_sync
  status        TEXT NOT NULL DEFAULT 'queued',         -- queued | running | done | failed | skipped
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id, step)
);

CREATE INDEX IF NOT EXISTS call_jobs_pick ON call_jobs (status, run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS call_jobs_call ON call_jobs (call_id);

COMMENT ON TABLE call_jobs IS
  'Conversation Point: per-call step queue. Retry a step by setting status=queued, run_after=now().';

-- ─── call_user_map ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_user_map (
  location_id   TEXT NOT NULL,
  provider      TEXT NOT NULL,
  key_type      TEXT NOT NULL,                          -- user | extension | number | email
  key           TEXT NOT NULL,                          -- provider user id / '204' / '+441onal…' / 'rep@co.uk'
  user_id       TEXT NOT NULL,                          -- GHL user id
  user_name     TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',         -- auto | manual
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, provider, key_type, key)
);

ALTER TABLE call_user_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON call_user_map;
CREATE POLICY tenant_iso ON call_user_map
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

COMMENT ON TABLE call_user_map IS
  'Conversation Point: how a provider identifies a rep (user id, extension, DDI, email) → GHL user. Auto rows come from the provider user sync; manual rows win.';

-- ─── contacts: phone tail index for call matching ────────────────────────
-- Matching compares the last 10 digits of a number, which survives the
-- +44 / 0 / spaces / brackets variants GHL stores. Expression index so the
-- lookup is a seek, not a scan over every contact in the location.

CREATE INDEX IF NOT EXISTS contacts_loc_phone_tail
  ON contacts (location_id, right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10))
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_loc_phone_tail
  ON users (location_id, right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10))
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_loc_email_lower
  ON users (location_id, lower(email))
  WHERE email IS NOT NULL;
