// worker.js — drains call_jobs, one step at a time.
//
//   match      contact / rep / deal (matcher.js) — never blocks on audio
//   download   provider URL → our storage (recordingStore.js)
//   transcribe our Whisper pass (transcriber.js) → call_transcripts
//   ghl_sync   Call message in GHL + transcript under its message_id
//
// Each step enqueues the next when it finishes. A failing step retries with
// backoff up to max_attempts, then stays 'failed' with its error on the row
// until someone re-queues it (POST /api/calls/:id/retry or SQL).
//
// Single poller, started from index.js. PM2 runs one instance; claimJob
// uses SKIP LOCKED anyway so a second would be safe, only wasteful.

import { config } from '../config.js';
import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';
import { getProvider } from './providers/index.js';
import { getProviderConfig } from './providerConfig.js';
import {
  claimJob, finishJob, retryOrFail, requeueStale, enqueue, nextStep, getCall, updateCall
} from './callStore.js';
import { matchCall } from './matcher.js';
import { storeRecording, materialise, probe } from './recordingStore.js';
import { transcribeCall } from './transcriber.js';
import { syncCallToGhl } from './ghlSync.js';

// ─── steps ───────────────────────────────────────────────────────────────

async function stepMatch(call) {
  const cfg = await getProviderConfig(call.location_id, call.provider);
  const fields = await matchCall(call.location_id, call, cfg.settings);
  await updateCall(call.id, fields);
  logger.info({ callId: call.id, ...fields }, 'conversationPoint: matched');
  return 'done';
}

async function stepDownload(call) {
  if (call.recording_status === 'stored') return 'done';
  if (!call.recording_url) {
    await updateCall(call.id, { recording_status: 'none', transcript_status: 'none' });
    return 'skipped';
  }
  const provider = getProvider(call.provider);
  const cfg = await getProviderConfig(call.location_id, call.provider);
  const { buffer, contentType } = await provider.fetchRecording(call.recording_url, cfg);
  if (!buffer || buffer.length < 1024) {
    throw new Error(`recording download returned ${buffer?.length || 0} bytes`);
  }
  const stored = await storeRecording({
    locationId: call.location_id, callId: call.id, buffer, contentType, sourceUrl: call.recording_url
  });
  await updateCall(call.id, {
    recording_status: 'stored',
    recording_storage: stored.storage,
    recording_key: stored.key,
    recording_bytes: stored.bytes,
    recording_content_type: stored.contentType,
    recording_error: null
  });
  // Channel count + duration now, so the dashboard can show them before the
  // transcript exists and so we learn early whether a provider is dual-channel.
  try {
    const local = await materialise({ ...call, recording_storage: stored.storage, recording_key: stored.key });
    try {
      const info = await probe(local.path);
      await updateCall(call.id, { recording_channels: info.channels, recording_duration_seconds: info.durationSeconds });
    } finally { await local.cleanup(); }
  } catch (err) {
    logger.debug({ err: err.message, callId: call.id }, 'conversationPoint: probe skipped');
  }
  logger.info({ callId: call.id, bytes: stored.bytes, storage: stored.storage }, 'conversationPoint: recording stored');
  return 'done';
}

async function stepTranscribe(call) {
  if (call.recording_status !== 'stored') {
    await updateCall(call.id, { transcript_status: 'none' });
    return 'skipped';
  }
  const cfg = await getProviderConfig(call.location_id, call.provider);
  const local = await materialise(call);
  try {
    const t = await transcribeCall(local.path, { repChannel: cfg.settings.repChannel });
    await rawQuery(
      `INSERT INTO call_transcripts
         (call_id, location_id, text, segments, language, model, speaker_method,
          duration_seconds, silence_stats, status, error, transcribed_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,'done',NULL,now())
       ON CONFLICT (call_id) DO UPDATE SET
         text = EXCLUDED.text, segments = EXCLUDED.segments, language = EXCLUDED.language,
         model = EXCLUDED.model, speaker_method = EXCLUDED.speaker_method,
         duration_seconds = EXCLUDED.duration_seconds, silence_stats = EXCLUDED.silence_stats,
         status = 'done', error = NULL, transcribed_at = now()`,
      [call.id, call.location_id, t.text, JSON.stringify(t.segments), t.language, t.model,
       t.speakerMethod, t.duration, JSON.stringify(t.silenceStats)]
    );
    await updateCall(call.id, {
      transcript_status: 'done',
      recording_channels: call.recording_channels ?? t.channels ?? null
    });
    logger.info({ callId: call.id, segments: t.segments.length, speakers: t.speakerMethod, model: t.model },
      'conversationPoint: transcribed');
    return 'done';
  } catch (err) {
    await rawQuery(
      `INSERT INTO call_transcripts (call_id, location_id, status, error)
       VALUES ($1,$2,'failed',$3)
       ON CONFLICT (call_id) DO UPDATE SET status = 'failed', error = EXCLUDED.error`,
      [call.id, call.location_id, String(err.message).slice(0, 2000)]
    );
    await updateCall(call.id, { transcript_status: 'failed' });
    throw err;
  } finally {
    await local.cleanup();
  }
}

async function stepGhlSync(call) {
  const { rows } = await rawQuery(
    `SELECT text, segments, language, model, duration_seconds FROM call_transcripts WHERE call_id = $1 AND status = 'done'`,
    [call.id]
  );
  const result = await syncCallToGhl(call, rows[0] || null);
  if (result.status === 'skipped') {
    await updateCall(call.id, { ghl_sync_status: 'skipped', ghl_sync_error: result.reason });
    return 'skipped';
  }
  await updateCall(call.id, {
    ghl_sync_status: 'synced', ghl_sync_error: null, ghl_synced_at: new Date(),
    ghl_message_id: result.messageId, ghl_conversation_id: result.conversationId
  });
  return 'done';
}

const STEP_FN = { match: stepMatch, download: stepDownload, transcribe: stepTranscribe, ghl_sync: stepGhlSync };

// ─── loop ────────────────────────────────────────────────────────────────

async function runOne(job) {
  const call = await getCall(job.call_id);
  if (!call) { await finishJob(job.id, 'failed', 'call row missing'); return; }
  const fn = STEP_FN[job.step];
  if (!fn) { await finishJob(job.id, 'failed', `unknown step ${job.step}`); return; }
  try {
    const outcome = await fn(call);
    await finishJob(job.id, outcome === 'skipped' ? 'skipped' : 'done');
    const next = nextStep(job.step);
    // match → download is queued by ingest only when the call is final; the
    // other transitions always follow.
    if (next && job.step !== 'match') await enqueue(call.id, call.location_id, next, { force: true });
  } catch (err) {
    const what = await retryOrFail(job, err);
    const level = what === 'failed' ? 'error' : 'warn';
    logger[level]({ err, callId: call.id, step: job.step, attempts: job.attempts, outcome: what },
      'conversationPoint: step failed');
    if (what === 'failed' && job.step === 'download') {
      await updateCall(call.id, { recording_status: 'failed', recording_error: err.message });
    }
  }
}

let running = false;
let timer = null;

export async function tick(batch = config.conversationPoint.workerBatch) {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    for (; n < batch; n++) {
      const job = await claimJob();
      if (!job) break;
      await runOne(job);
    }
  } catch (err) {
    logger.error({ err }, 'conversationPoint: worker tick failed');
  } finally {
    running = false;
  }
  return n;
}

export function startConversationPointWorker() {
  if (!config.conversationPoint.enabled) {
    logger.info('conversationPoint: disabled (CP_ENABLED=false)');
    return;
  }
  const every = Math.max(1000, config.conversationPoint.workerIntervalMs);
  requeueStale().catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, every);
  timer.unref?.();
  logger.info(
    { everyMs: every, storage: config.conversationPoint.storage,
      transcribe: config.conversationPoint.openaiApiKey ? config.conversationPoint.transcribeModel : 'NO OPENAI KEY',
      ghlSync: config.conversationPoint.ghlCallProviderId ? 'on' : 'skipped (no GHL_CALL_PROVIDER_ID)' },
    'conversationPoint: worker started'
  );
}

export function stopConversationPointWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
