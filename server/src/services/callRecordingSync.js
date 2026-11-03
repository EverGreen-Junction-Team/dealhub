// callRecordingSync.js — sweep pass that fetches recording URL + transcription
// for every call message we don't already have.
//
// Endpoints (both GET):
//   /conversations/messages/{messageId}/locations/{locationId}/recording
//     → binary audio. We only store the request URL (no re-download).
//
//   /conversations/locations/{locationId}/messages/{messageId}/transcription
//     → JSON transcription (segments + text). Stored inline.
//
// Retry policy per user directive: NO retry on error, except 429 which is
// handled transparently by ghlClient's axios-retry. So each candidate row
// gets exactly one non-429 attempt per sweep. If it fails, that row's
// status stays 'failed' / 'not_found' / 'unauthorized' and the next sweep
// SKIPS it (candidate query excludes rows already tried).
//
// To force a re-attempt on a failed row: DELETE the row from call_recordings
// or call_transcriptions manually. The candidate query will re-pick it up.
//
// Sweep is idempotent — safe to run manually multiple times per day.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

// Candidate messages: is_call=true, no row yet in the target table.
// We DON'T include soft-deleted messages. Order by newest first — fresh
// calls are likelier to have transcriptions ready.
async function loadCandidatesForRecordings(locationId, limit) {
  const { rows } = await rawQuery(
    `SELECT m.message_id
       FROM messages m
      WHERE m.location_id = $1
        AND m.is_call = true
        AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM call_recordings r
           WHERE r.location_id = m.location_id
             AND r.message_id  = m.message_id
        )
      ORDER BY m.message_timestamp DESC
      LIMIT $2`,
    [locationId, limit]
  );
  return rows.map((r) => r.message_id);
}

async function loadCandidatesForTranscriptions(locationId, limit) {
  const { rows } = await rawQuery(
    `SELECT m.message_id
       FROM messages m
      WHERE m.location_id = $1
        AND m.is_call = true
        AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM call_transcriptions t
           WHERE t.location_id = m.location_id
             AND t.message_id  = m.message_id
        )
      ORDER BY m.message_timestamp DESC
      LIMIT $2`,
    [locationId, limit]
  );
  return rows.map((r) => r.message_id);
}

// Recording. We HEAD-then-store approach doesn't work here — GHL only supports
// GET on the recording endpoint. We fire the GET but discard the body; only
// the URL + response metadata gets stored. The `responseType: 'arraybuffer'`
// with `maxContentLength: 1` guard would abort early, but axios doesn't
// stream cleanly through ghlAxios's retry layer. Safer: let the body come,
// don't read it into a variable.
async function fetchRecording(install, messageId) {
  const locationId = install.location_id;
  const url = `${GHL_BASE}/conversations/messages/${encodeURIComponent(messageId)}/locations/${encodeURIComponent(locationId)}/recording`;

  try {
    const resp = await ghlRequest(install, {
      method: 'GET',
      url: `/conversations/messages/${encodeURIComponent(messageId)}/locations/${encodeURIComponent(locationId)}/recording`,
      responseType: 'arraybuffer',
      // Cap read size — we don't need the body. 512 KB is enough to detect
      // an audio stream vs an error page.
      maxContentLength: 512 * 1024,
      validateStatus: () => true
    });
    const status = resp.status;
    const contentType = resp.headers?.['content-type'] || null;
    const contentLength = Number(resp.headers?.['content-length']) || null;

    if (status >= 200 && status < 300) {
      return {
        fetch_status: 'ok',
        http_status: status,
        recording_url: url,
        content_type: contentType,
        size_bytes: contentLength,
        last_error: null
      };
    }
    if (status === 404) {
      return { fetch_status: 'not_found', http_status: 404, recording_url: null, content_type: null, size_bytes: null, last_error: null };
    }
    if (status === 401 || status === 403) {
      return { fetch_status: 'unauthorized', http_status: status, recording_url: null, content_type: null, size_bytes: null, last_error: `HTTP ${status}` };
    }
    return { fetch_status: 'failed', http_status: status, recording_url: null, content_type: null, size_bytes: null, last_error: `HTTP ${status}` };
  } catch (err) {
    // axios throws when maxContentLength is exceeded — treat as ok (body was
    // large audio, which is exactly what we wanted to confirm).
    if (err.code === 'ERR_BAD_RESPONSE' && /maxContentLength/i.test(err.message || '')) {
      return { fetch_status: 'ok', http_status: 200, recording_url: url, content_type: null, size_bytes: null, last_error: null };
    }
    return {
      fetch_status: 'failed',
      http_status: err.response?.status || null,
      recording_url: null,
      content_type: null,
      size_bytes: null,
      last_error: (err.message || String(err)).slice(0, 500)
    };
  }
}

// Transcription. JSON response — we take whatever GHL gives back and store
// the full text (joined) plus the raw shape as JSONB.
async function fetchTranscription(install, messageId) {
  const locationId = install.location_id;
  try {
    const resp = await ghlRequest(install, {
      method: 'GET',
      url: `/conversations/locations/${encodeURIComponent(locationId)}/messages/${encodeURIComponent(messageId)}/transcription`,
      validateStatus: () => true
    });
    const status = resp.status;

    if (status >= 200 && status < 300) {
      const data = resp.data || {};
      // GHL's response shape has drifted historically. Handle both common shapes:
      //   { transcription: { text, segments, language, provider, duration } }
      //   { text, segments, language, provider, duration }
      const t = data.transcription || data.transcript || data;
      const segments = Array.isArray(t?.segments) ? t.segments : null;
      const joinedText = t?.text
        || (segments ? segments.map((s) => s?.text || '').filter(Boolean).join(' ') : null)
        || null;
      return {
        fetch_status: 'ok',
        http_status: status,
        transcript_text: joinedText,
        segments: segments ? JSON.stringify(segments) : null,
        language: t?.language || null,
        provider: t?.provider || null,
        duration_seconds: (typeof t?.duration === 'number') ? t.duration : null,
        last_error: null
      };
    }
    if (status === 404) {
      return { fetch_status: 'not_found', http_status: 404, transcript_text: null, segments: null, language: null, provider: null, duration_seconds: null, last_error: null };
    }
    if (status === 401 || status === 403) {
      return { fetch_status: 'unauthorized', http_status: status, transcript_text: null, segments: null, language: null, provider: null, duration_seconds: null, last_error: `HTTP ${status}` };
    }
    return { fetch_status: 'failed', http_status: status, transcript_text: null, segments: null, language: null, provider: null, duration_seconds: null, last_error: `HTTP ${status}` };
  } catch (err) {
    return {
      fetch_status: 'failed',
      http_status: err.response?.status || null,
      transcript_text: null,
      segments: null,
      language: null,
      provider: null,
      duration_seconds: null,
      last_error: (err.message || String(err)).slice(0, 500)
    };
  }
}

async function upsertRecording(locationId, messageId, result) {
  await rawQuery(
    `INSERT INTO call_recordings
       (location_id, message_id, recording_url, content_type, size_bytes,
        fetched_at, fetch_status, http_status, last_error)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8)
     ON CONFLICT (location_id, message_id) DO NOTHING`,
    [locationId, messageId, result.recording_url, result.content_type, result.size_bytes,
     result.fetch_status, result.http_status, result.last_error]
  );
}

async function upsertTranscription(locationId, messageId, result) {
  await rawQuery(
    `INSERT INTO call_transcriptions
       (location_id, message_id, transcript_text, segments, language, provider,
        duration_seconds, fetched_at, fetch_status, http_status, last_error)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now(), $8, $9, $10)
     ON CONFLICT (location_id, message_id) DO NOTHING`,
    [locationId, messageId, result.transcript_text, result.segments,
     result.language, result.provider, result.duration_seconds,
     result.fetch_status, result.http_status, result.last_error]
  );
}

// Public: sweep one install. Pulls candidates for both endpoints and processes
// them sequentially. `perTypeLimit` caps how many candidates we take per run
// so a huge backlog doesn't chew the whole daily window.
export async function syncCallMediaForLocation(install, { perTypeLimit = 500 } = {}) {
  const locationId = install.location_id;
  const startedAt = new Date();

  try {
    const [recCandidates, txCandidates] = await Promise.all([
      loadCandidatesForRecordings(locationId, perTypeLimit),
      loadCandidatesForTranscriptions(locationId, perTypeLimit)
    ]);

    let recOk = 0, recNotFound = 0, recFailed = 0;
    for (const messageId of recCandidates) {
      const r = await fetchRecording(install, messageId);
      await upsertRecording(locationId, messageId, r);
      if (r.fetch_status === 'ok')            recOk++;
      else if (r.fetch_status === 'not_found') recNotFound++;
      else                                     recFailed++;
    }

    let txOk = 0, txNotFound = 0, txFailed = 0;
    for (const messageId of txCandidates) {
      const t = await fetchTranscription(install, messageId);
      await upsertTranscription(locationId, messageId, t);
      if (t.fetch_status === 'ok')            txOk++;
      else if (t.fetch_status === 'not_found') txNotFound++;
      else                                     txFailed++;
    }

    logger.info(
      { locationId,
        recordings:     { attempted: recCandidates.length, ok: recOk, not_found: recNotFound, failed: recFailed },
        transcriptions: { attempted: txCandidates.length, ok: txOk, not_found: txNotFound, failed: txFailed },
        durationMs: Date.now() - startedAt.getTime() },
      'callRecordingSync: location complete'
    );

    await recordSyncRun({
      jobName: 'callRecordingSync', objectType: 'call_media',
      locationId, scope: 'location', status: 'success', startedAt,
      stats: {
        rec_attempted: recCandidates.length, rec_ok: recOk, rec_not_found: recNotFound, rec_failed: recFailed,
        tx_attempted:  txCandidates.length,  tx_ok:  txOk,  tx_not_found:  txNotFound,  tx_failed:  txFailed
      }
    });

    return {
      recordings:     { attempted: recCandidates.length, ok: recOk, not_found: recNotFound, failed: recFailed },
      transcriptions: { attempted: txCandidates.length, ok: txOk, not_found: txNotFound, failed: txFailed }
    };
  } catch (err) {
    logger.error({ err, locationId }, 'callRecordingSync: location failed');
    await recordSyncRun({
      jobName: 'callRecordingSync', objectType: 'call_media',
      locationId, scope: 'location', status: 'failed', startedAt,
      error: err.message
    });
    throw err;
  }
}

export async function syncCallMediaForAllInstalls(opts) {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs
      WHERE uninstalled_at IS NULL AND reauth_required_at IS NULL`
  );
  const totals = {
    locations: rows.length,
    recordings:     { attempted: 0, ok: 0, not_found: 0, failed: 0 },
    transcriptions: { attempted: 0, ok: 0, not_found: 0, failed: 0 }
  };
  for (const r of rows) {
    const install = await getActiveInstall(r.location_id);
    if (!install) continue;
    try {
      const result = await syncCallMediaForLocation(install, opts);
      for (const k of ['attempted','ok','not_found','failed']) {
        totals.recordings[k]     += result.recordings[k];
        totals.transcriptions[k] += result.transcriptions[k];
      }
    } catch (err) {
      logger.error({ err, locationId: r.location_id }, 'callRecordingSync: install failed');
    }
  }
  return totals;
}
