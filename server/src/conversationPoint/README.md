# Conversation Point

Call recording and transcription for PipelinePulse. Every call from any phone
provider is stored in our database, transcribed by us, and linked to the
contact, the rep and the deal. Allo is the first connector.

## What it does

```
Allo webhook ─▶ /webhooks/calls/allo/<locationId>
                   │  verify signature, store the raw event (call_events)
                   ▼
                calls row (upsert by provider + call id)
                   │
                   ▼  call_jobs, one step at a time
   match ──▶ download ──▶ transcribe ──▶ ghl_sync
   contact     audio →       Whisper →      Call message in GHL
   rep         our storage   call_transcripts  + transcript under its message id
   deal
```

- **Only audio and metadata** come from the provider. Allo's own transcript
  and AI summary are kept in `raw` and never used. Every call goes through
  the same Whisper pass, so the transcript shape is identical across providers.
- **Timestamps per segment** come with the transcript, so gaps and silences
  are measured on day one (`call_transcripts.silence_stats`).
- **Speaker labels** need one of two things: a stereo recording with one
  party per channel (exact, free: `speaker_method = dual_channel`), or a
  diarizing model later via `TRANSCRIBE_MODEL`. A mono recording gets
  `speaker = null` on its segments.
- **GHL sync is optional.** Without `GHL_CALL_PROVIDER_ID` that step is
  skipped and everything else still works. The DB is the source of truth.

## Tables (migration 141)

| Table | One row per | Notes |
|---|---|---|
| `call_providers` | location × provider | API key, webhook secret, settings |
| `call_events` | webhook received | verbatim payload, dedup on provider event id |
| `calls` | call | metadata, recording pointer, match results, GHL ids |
| `call_transcripts` | call | text, `segments[{speaker,start,end,text}]`, silence stats |
| `call_jobs` | call × step | the queue; `status`, `attempts`, `last_error` |
| `call_user_map` | provider key → GHL user | user id / extension / number / email |

## Matching

- **Contact**: customer number → `contacts.phone` on the last 10 digits
  (indexed), then GHL contact search, else unmatched. Withheld numbers stay
  unmatched.
- **Rep**: `call_user_map` by provider user id → provider user email ↔
  `users.email` → map by extension → map by our number → `users.phone`.
  Manual map rows always win, which is how a head-office call routed to an
  extension lands on the right rep.
- **Deal**: the same rule messages use (`attributionEngine.resolveOppForContact`):
  the contact's earliest open deal; several open deals leave it unlinked
  with `deal_match_status = excluded_multi_open` for a human to pick.

Manual override: `PATCH /api/calls/:id/links { contactId, userId, opportunityId }`.

## Files

```
src/conversationPoint/
  providers/index.js   connector registry — add a provider here
  providers/allo.js    Allo: signature check, payload → normalised call, REST client
  ingest.js            event → calls row → queued steps
  callStore.js         SQL for events, calls, jobs
  matcher.js           contact / rep / deal
  recordingStore.js    our audio copy (local dir or Supabase Storage) + signed links
  transcriber.js       Whisper, stereo split, compression, chunking, silence stats
  ghlSync.js           Call message in GHL + call_transcriptions row
  worker.js            the step runner (started from index.js)
  userSync.js          provider users → call_user_map by email
src/routes/callWebhooks.js   POST /webhooks/calls/:provider/:locationId
src/routes/calls.js          /api/calls — list, detail, retry, links, provider config, user map
src/routes/media.js          GET /api/media/recording (signed) — serves the audio
src/utils/phone.js           E.164 + last-10-digit key
```

## Setting up Allo for a location

1. Run the migration: `npm run migrate`.
2. Put `OPENAI_API_KEY` in `.env` (and `ffmpeg` on the box: `apt install ffmpeg`).
3. Store the Allo API key for the location:
   `PUT /api/calls/providers/allo { "apiKey": "…" }` (or `ALLO_API_KEY` in `.env` for a single tenant).
4. Register the webhook: `npm run cp:allo:register-webhook -- --location <id>`.
   It registers `PUBLIC_BASE_URL/webhooks/calls/allo/<id>` for `call.completed`,
   `call.answered`, `call.received`, `call.triggered`. If Allo returns a
   signing secret it is stored; otherwise paste it with
   `PUT /api/calls/providers/allo { "webhookSecret": "…" }`.
5. Map reps: `npm run cp:allo:sync-users -- --location <id>`. Anyone whose
   Allo email differs from their GHL email gets a manual row via
   `PUT /api/calls/user-map { keyType: 'user' | 'extension', key, userId }`.
6. Make a test call. Watch `GET /api/calls` and the server log lines
   `conversationPoint: call ingested / matched / recording stored / transcribed`.
7. History: `npm run cp:allo:backfill -- --location <id> --since 2026-10-01 --dry`
   then without `--dry`.

In production an unverifiable signature is rejected (401). In development it
is accepted and flagged `signature_ok = false` on the event.

## Trying it without Allo

```
npm run cp:simulate -- --location <id> --file ./sample-call.mp3 --from +447700900123 --run
```

Ingests a fake call, stores the file as its recording, runs every step in
process, and prints the match result, transcript head and job states.
Delete with `DELETE FROM calls WHERE provider_call_id LIKE 'sim-%'`.

## Operations

- A failed step keeps its error on `call_jobs.last_error` and on the calls
  row (`recording_error`, `call_transcripts.error`, `ghl_sync_error`).
- Re-run a step: `POST /api/calls/:id/retry { "step": "transcribe" }` or
  `UPDATE call_jobs SET status='queued', run_after=now() WHERE …`.
- `npm run cp:tick` drains the queue from the shell with the server stopped.
- Retry policy: 5 attempts with backoff (30 s → 1 h). 400/401/403 from
  OpenAI and a missing storage config are permanent and fail at once.
- Cost: Whisper is about $0.006 per audio minute. Recordings are transcoded
  to mono 16 kHz MP3 before upload, so a one-hour call is ~14 MB.

## Adding a provider

Write `providers/<name>.js` with the contract in `providers/index.js`
(`verifyWebhook`, `parseEvent`, `normaliseCall`, `fetchRecording`, `api`),
register it in the map, and point the provider's webhook at
`/webhooks/calls/<name>/<locationId>`. Nothing downstream changes.

## Open questions for Allo (ask the account manager)

1. Does `call.completed` carry duration, start/end time and the user or
   extension that answered? If the user only appears on `call.answered`,
   we merge events per call id (already handled).
2. Is `recording_url` permanent, signed or expiring? We download immediately
   either way.
3. Audio format, and is it stereo with one party per channel?
4. Exact signing algorithm and where the secret is shown (Standard Webhooks
   `v1,<base64>` and plain HMAC-SHA256 of the body are both accepted).
5. Recording retention on Allo's side.
