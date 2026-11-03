// callStore.js — persistence for Conversation Point: raw events, the calls
// table, and the step queue.
//
// Everything here goes through rawQuery. The worker is not a request on
// behalf of a tenant, it is the system working through every tenant's
// queue, and the pool's role bypasses RLS the same way callRecordingSync
// and the sweeps do. The dashboard routes read calls through withTenant.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

export const STEPS = ['match', 'download', 'transcribe', 'ghl_sync'];
const NEXT_STEP = { match: 'download', download: 'transcribe', transcribe: 'ghl_sync', ghl_sync: null };

// ─── events ──────────────────────────────────────────────────────────────

/**
 * Store a webhook verbatim. Returns { id, duplicate }. A duplicate is the
 * provider retrying an event we already hold — the caller answers 200 and
 * does nothing else.
 */
export async function recordEvent({
  provider, locationId = null, providerEventId = null, topic = null,
  providerCallId = null, payload, headers = null, signatureOk = null
}) {
  if (providerEventId) {
    const { rows } = await rawQuery(
      `INSERT INTO call_events
         (provider, location_id, provider_event_id, topic, provider_call_id, payload, headers, signature_ok)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [provider, locationId, providerEventId, topic, providerCallId,
       JSON.stringify(payload ?? null), headers ? JSON.stringify(headers) : null, signatureOk]
    );
    if (rows.length === 0) return { id: null, duplicate: true };
    return { id: rows[0].id, duplicate: false };
  }
  const { rows } = await rawQuery(
    `INSERT INTO call_events
       (provider, location_id, topic, provider_call_id, payload, headers, signature_ok)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
     RETURNING id`,
    [provider, locationId, topic, providerCallId,
     JSON.stringify(payload ?? null), headers ? JSON.stringify(headers) : null, signatureOk]
  );
  return { id: rows[0].id, duplicate: false };
}

export async function markEvent(id, status, error = null) {
  if (!id) return;
  try {
    await rawQuery(
      `UPDATE call_events SET status = $2, error = $3, processed_at = now() WHERE id = $1`,
      [id, status, error ? String(error).slice(0, 2000) : null]
    );
  } catch (err) {
    logger.warn({ err, id, status }, 'callStore: markEvent failed (non-fatal)');
  }
}

// ─── calls ───────────────────────────────────────────────────────────────

/**
 * Insert or merge a normalised call. Later events fill in what earlier ones
 * lacked (COALESCE new over old); a completed event's direction / result /
 * recording_url override, because they are final.
 *
 * Returns the full row plus `inserted`.
 */
export async function upsertCall(locationId, c, { final = false } = {}) {
  const { rows } = await rawQuery(
    `INSERT INTO calls (
       location_id, provider, provider_call_id,
       direction, result, from_number, to_number, from_e164, to_e164,
       customer_number, our_number, extension,
       provider_user_id, provider_user_email, provider_user_name,
       started_at, answered_at, ended_at, duration_seconds, talk_seconds,
       recording_url, raw
     ) VALUES (
       $1,$2,$3, $4,$5,$6,$7,$8,$9, $10,$11,$12, $13,$14,$15, $16,$17,$18,$19,$20, $21,$22::jsonb
     )
     ON CONFLICT (location_id, provider, provider_call_id) DO UPDATE SET
       direction           = CASE WHEN $23 AND EXCLUDED.direction <> 'unknown' THEN EXCLUDED.direction
                                  ELSE COALESCE(NULLIF(calls.direction,'unknown'), EXCLUDED.direction) END,
       result              = CASE WHEN $23 AND EXCLUDED.result <> 'unknown' THEN EXCLUDED.result
                                  ELSE COALESCE(NULLIF(calls.result,'unknown'), EXCLUDED.result) END,
       from_number         = COALESCE(EXCLUDED.from_number, calls.from_number),
       to_number           = COALESCE(EXCLUDED.to_number, calls.to_number),
       from_e164           = COALESCE(EXCLUDED.from_e164, calls.from_e164),
       to_e164             = COALESCE(EXCLUDED.to_e164, calls.to_e164),
       customer_number     = COALESCE(EXCLUDED.customer_number, calls.customer_number),
       our_number          = COALESCE(EXCLUDED.our_number, calls.our_number),
       extension           = COALESCE(EXCLUDED.extension, calls.extension),
       provider_user_id    = COALESCE(EXCLUDED.provider_user_id, calls.provider_user_id),
       provider_user_email = COALESCE(EXCLUDED.provider_user_email, calls.provider_user_email),
       provider_user_name  = COALESCE(EXCLUDED.provider_user_name, calls.provider_user_name),
       started_at          = COALESCE(calls.started_at, EXCLUDED.started_at),
       answered_at         = COALESCE(EXCLUDED.answered_at, calls.answered_at),
       ended_at            = COALESCE(EXCLUDED.ended_at, calls.ended_at),
       duration_seconds    = COALESCE(EXCLUDED.duration_seconds, calls.duration_seconds),
       talk_seconds        = COALESCE(EXCLUDED.talk_seconds, calls.talk_seconds),
       recording_url       = COALESCE(EXCLUDED.recording_url, calls.recording_url),
       raw                 = CASE WHEN $23 THEN EXCLUDED.raw ELSE COALESCE(calls.raw, EXCLUDED.raw) END,
       updated_at          = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      locationId, c.provider, c.providerCallId,
      c.direction || 'unknown', c.result || 'unknown', c.fromNumber, c.toNumber, c.fromE164, c.toE164,
      c.customerNumber, c.ourNumber, c.extension,
      c.providerUserId, c.providerUserEmail, c.providerUserName,
      c.startedAt, c.answeredAt, c.endedAt, c.durationSeconds, c.talkSeconds,
      c.recordingUrl, JSON.stringify(c.raw ?? null),
      !!final
    ]
  );
  return rows[0];
}

export async function getCall(callId) {
  const { rows } = await rawQuery(`SELECT * FROM calls WHERE id = $1`, [callId]);
  return rows[0] || null;
}

export async function updateCall(callId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await rawQuery(
    `UPDATE calls SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
    [callId, ...keys.map((k) => fields[k])]
  );
}

// ─── jobs ────────────────────────────────────────────────────────────────

/**
 * Queue a step. Idempotent: a step already queued/running is left alone; a
 * done/failed/skipped one is re-queued only with { force: true }.
 */
export async function enqueue(callId, locationId, step, { runAfter = null, force = false } = {}) {
  if (!STEPS.includes(step)) throw new Error(`enqueue: unknown step ${step}`);
  await rawQuery(
    `INSERT INTO call_jobs (call_id, location_id, step, run_after)
     VALUES ($1, $2, $3, COALESCE($4, now()))
     ON CONFLICT (call_id, step) DO UPDATE SET
       status     = CASE WHEN call_jobs.status IN ('queued','running') OR NOT $5 THEN call_jobs.status ELSE 'queued' END,
       run_after  = CASE WHEN $5 AND call_jobs.status NOT IN ('queued','running') THEN COALESCE($4, now()) ELSE call_jobs.run_after END,
       attempts   = CASE WHEN $5 AND call_jobs.status NOT IN ('queued','running') THEN 0 ELSE call_jobs.attempts END,
       last_error = CASE WHEN $5 AND call_jobs.status NOT IN ('queued','running') THEN NULL ELSE call_jobs.last_error END`,
    [callId, locationId, step, runAfter, !!force]
  );
}

export function nextStep(step) {
  return NEXT_STEP[step] || null;
}

/** Claim one queued job. null when nothing is due. */
export async function claimJob() {
  const { rows } = await rawQuery(
    `UPDATE call_jobs SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM call_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`
  );
  return rows[0] || null;
}

export async function finishJob(id, status, error = null) {
  await rawQuery(
    `UPDATE call_jobs SET status = $2, last_error = $3, finished_at = now() WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 2000) : null]
  );
}

/** Put a failed attempt back with exponential backoff, or mark it failed. */
export async function retryOrFail(job, error) {
  const msg = error?.message || String(error);
  if (job.attempts >= job.max_attempts || error?.permanent) {
    await finishJob(job.id, 'failed', msg);
    return 'failed';
  }
  const delaySec = Math.min(3600, 30 * 2 ** (job.attempts - 1));
  await rawQuery(
    `UPDATE call_jobs SET status = 'queued', last_error = $2, run_after = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [job.id, msg.slice(0, 2000), String(delaySec)]
  );
  return 'retry';
}

/** Jobs left 'running' by a crash: re-queue anything older than 30 minutes. */
export async function requeueStale() {
  const { rowCount } = await rawQuery(
    `UPDATE call_jobs SET status = 'queued', last_error = COALESCE(last_error, '') || ' [requeued after stale running]'
      WHERE status = 'running' AND started_at < now() - interval '30 minutes'`
  );
  if (rowCount) logger.warn({ rowCount }, 'callStore: requeued stale running jobs');
}

export async function jobsForCall(callId) {
  const { rows } = await rawQuery(
    `SELECT step, status, attempts, max_attempts, run_after, started_at, finished_at, last_error
       FROM call_jobs WHERE call_id = $1 ORDER BY id`,
    [callId]
  );
  return rows;
}
