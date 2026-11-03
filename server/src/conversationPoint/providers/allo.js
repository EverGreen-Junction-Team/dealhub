// providers/allo.js — the Allo connector (withallo.com).
//
// What Allo gives us (public docs, Oct 2026):
//   • Webhooks: POST https://api.withallo.com/v2/api/webhooks { url, topics }.
//     Topics: call.received, call.triggered, call.answered, call.completed,
//     sms.*, contact.*, tag.*. Retries up to 8 times over ~27h, replay
//     available. Signature in the `webhook-signature` header over the RAW
//     body — the header names match the Standard Webhooks spec
//     (webhook-id / webhook-timestamp / webhook-signature), so that is the
//     first scheme tried, with a plain HMAC-of-body fallback.
//   • REST: Authorization: Api-Key <key>. 20 reads/s. GET /v2/api/users,
//     GET /v2/api/numbers, GET /v2/api/conversations (calls with recordings).
//
// Documented call.completed example:
//   { topic: 'call.completed', version: '2.0', timestamp, data: {
//       id, from_number, to, type: 'INBOUND', result: 'ANSWERED',
//       summary, recording_url } }
//
// Allo ALSO sends a transcript and AI summary. We ignore both on purpose:
// every provider's calls go through our own Whisper pass so the format is
// identical and the quality is ours to control.
//
// FIELDS WE HAVE NOT SEEN YET (duration, answered user, extension, start /
// end times) are read through `pick()` from every plausible key. When the
// first real payloads land, tighten the lists in normaliseCall() — nothing
// else needs to change.

import crypto from 'node:crypto';
import { toE164 } from '../../utils/phone.js';
import { logger } from '../../utils/logger.js';

const NAME = 'allo';
const WEBHOOK_TOPICS = ['call.completed', 'call.answered', 'call.received', 'call.triggered'];
const DEFAULT_BASE = 'https://api.withallo.com';

// ─── helpers ──────────────────────────────────────────────────────────────

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (k.includes('.')) {
      const v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    } else if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return obj[k];
    }
  }
  return undefined;
}

function toDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

const DIRECTION = {
  INBOUND: 'inbound', INCOMING: 'inbound', IN: 'inbound',
  OUTBOUND: 'outbound', OUTGOING: 'outbound', OUT: 'outbound',
  INTERNAL: 'internal'
};
const RESULT = {
  ANSWERED: 'answered', COMPLETED: 'answered', CONNECTED: 'answered',
  MISSED: 'missed', NO_ANSWER: 'missed', NOANSWER: 'missed', UNANSWERED: 'missed', ABANDONED: 'missed',
  VOICEMAIL: 'voicemail',
  BUSY: 'busy',
  FAILED: 'failed', CANCELED: 'failed', CANCELLED: 'failed', REJECTED: 'failed', DECLINED: 'failed'
};

function mapEnum(table, v) {
  if (v === undefined || v === null) return 'unknown';
  return table[String(v).toUpperCase().replace(/[\s-]+/g, '_')] || 'unknown';
}

// ─── signature verification ──────────────────────────────────────────────

function decodeSecret(secret) {
  const s = String(secret || '');
  if (s.startsWith('whsec_')) return Buffer.from(s.slice(6), 'base64');
  return Buffer.from(s, 'utf8');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify an Allo webhook. Returns { ok, method }.
 *  method: 'standard-webhooks' | 'hmac-body' | 'no-secret' | 'missing-header'
 *
 * With no secret configured we cannot verify. The route decides what to do
 * with that (accept + flag in dev, reject in prod).
 */
function verifyWebhook({ rawBody, headers, secret }) {
  if (!secret) return { ok: false, method: 'no-secret' };
  const h = (k) => headers?.[k] ?? headers?.[k.toLowerCase()] ?? null;
  const sigHeader = h('webhook-signature') || h('x-webhook-signature') || h('x-allo-signature');
  if (!sigHeader) return { ok: false, method: 'missing-header' };
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const key = decodeSecret(secret);

  // 1. Standard Webhooks: "v1,<base64>" (one or more, space separated),
  //    signed content = "<webhook-id>.<webhook-timestamp>.<body>".
  const id = h('webhook-id'); const ts = h('webhook-timestamp');
  if (id && ts) {
    const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
    const candidates = String(sigHeader).split(/\s+/).map((p) => p.split(',').pop());
    if (candidates.some((c) => safeEqual(c, expected))) {
      const skew = Math.abs(Date.now() / 1000 - Number(ts));
      if (Number.isFinite(skew) && skew > 60 * 10) {
        logger.warn({ skew }, 'allo webhook: signature ok but timestamp is stale');
      }
      return { ok: true, method: 'standard-webhooks' };
    }
  }

  // 2. Plain HMAC-SHA256 over the body, hex or base64, optional "sha256=" prefix.
  const given = String(sigHeader).replace(/^(sha256=|v1,)/i, '').trim();
  const hex = crypto.createHmac('sha256', key).update(body).digest('hex');
  const b64 = crypto.createHmac('sha256', key).update(body).digest('base64');
  if (safeEqual(given, hex) || safeEqual(given, b64)) return { ok: true, method: 'hmac-body' };
  // Raw-utf8 secret for a whsec_-prefixed value, in case Allo does not base64 it.
  if (String(secret).startsWith('whsec_')) {
    const k2 = Buffer.from(secret, 'utf8');
    const hex2 = crypto.createHmac('sha256', k2).update(body).digest('hex');
    const b642 = crypto.createHmac('sha256', k2).update(body).digest('base64');
    if (safeEqual(given, hex2) || safeEqual(given, b642)) return { ok: true, method: 'hmac-body' };
  }
  return { ok: false, method: 'mismatch' };
}

// ─── normalisation ───────────────────────────────────────────────────────

/**
 * Allo call object (webhook `data` or a conversation item) → normalised
 * partial call. Only what we know is present is set; the store merges.
 */
function normaliseCall(d, { defaultCountry = 'GB' } = {}) {
  if (!d || typeof d !== 'object') return null;
  const providerCallId = pick(d, ['id', 'call_id', 'callId', 'uuid']);
  if (!providerCallId) return null;

  const fromRaw = pick(d, ['from_number', 'from', 'caller', 'caller_number', 'source']);
  const toRaw = pick(d, ['to_number', 'to', 'callee', 'callee_number', 'destination', 'dialed_number']);
  const direction = mapEnum(DIRECTION, pick(d, ['type', 'direction', 'call_type']));
  const result = mapEnum(RESULT, pick(d, ['result', 'status', 'outcome', 'disposition']));

  const user = pick(d, ['user', 'agent', 'assignee', 'answered_by', 'owner', 'member']);
  const providerUserId = pick(d, ['user_id', 'agent_id', 'answered_by_id', 'assignee_id'])
    ?? (user && typeof user === 'object' ? pick(user, ['id', 'user_id']) : (typeof user === 'string' ? user : undefined));
  const providerUserEmail = user && typeof user === 'object' ? pick(user, ['email']) : pick(d, ['user_email', 'agent_email']);
  const providerUserName = user && typeof user === 'object'
    ? (pick(user, ['name', 'full_name', 'display_name']) || [pick(user, ['first_name']), pick(user, ['last_name'])].filter(Boolean).join(' ') || undefined)
    : pick(d, ['user_name', 'agent_name']);
  const extension = pick(d, ['extension', 'ext', 'line', 'line_number', 'user.extension', 'agent.extension']);

  const startedAt = toDate(pick(d, ['started_at', 'start_time', 'start', 'created_at', 'initiated_at', 'timestamp']));
  const answeredAt = toDate(pick(d, ['answered_at', 'answer_time', 'connected_at']));
  const endedAt = toDate(pick(d, ['ended_at', 'end_time', 'end', 'completed_at', 'finished_at']));
  let durationSeconds = toInt(pick(d, ['duration', 'duration_seconds', 'duration_sec', 'total_duration', 'call_duration']));
  const durationMs = toInt(pick(d, ['duration_ms']));
  if (durationSeconds === null && durationMs !== null) durationSeconds = Math.round(durationMs / 1000);
  if (durationSeconds === null && startedAt && endedAt) durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  let talkSeconds = toInt(pick(d, ['talk_time', 'talk_seconds', 'talk_duration', 'billable_seconds']));
  if (talkSeconds === null && answeredAt && endedAt) talkSeconds = Math.max(0, Math.round((endedAt - answeredAt) / 1000));

  const recordingUrl = pick(d, ['recording_url', 'recording.url', 'recordingUrl', 'recording', 'audio_url']);

  const fromE164 = toE164(fromRaw, { defaultCountry });
  const toE164v = toE164(toRaw, { defaultCountry });
  let customerNumber = null; let ourNumber = null;
  if (direction === 'inbound') { customerNumber = fromE164; ourNumber = toE164v; }
  else if (direction === 'outbound') { customerNumber = toE164v; ourNumber = fromE164; }

  return {
    provider: NAME,
    providerCallId: String(providerCallId),
    direction, result,
    fromNumber: fromRaw != null ? String(fromRaw) : null,
    toNumber: toRaw != null ? String(toRaw) : null,
    fromE164, toE164: toE164v, customerNumber, ourNumber,
    extension: extension != null ? String(extension) : null,
    providerUserId: providerUserId != null ? String(providerUserId) : null,
    providerUserEmail: providerUserEmail ? String(providerUserEmail).toLowerCase() : null,
    providerUserName: providerUserName ? String(providerUserName) : null,
    startedAt, answeredAt, endedAt, durationSeconds, talkSeconds,
    recordingUrl: typeof recordingUrl === 'string' && /^https?:\/\//.test(recordingUrl) ? recordingUrl : null,
    raw: d
  };
}

/**
 * Webhook envelope → event description.
 */
function parseEvent(payload, headers = {}, opts = {}) {
  const topic = String(pick(payload, ['topic', 'event', 'type']) || '').toLowerCase();
  const data = pick(payload, ['data', 'payload', 'call']) || payload;
  const h = (k) => headers?.[k] ?? null;
  const providerEventId = h('webhook-id') || pick(payload, ['id', 'event_id', 'eventId']) || null;
  const call = topic.startsWith('call.') ? normaliseCall(data, opts) : null;
  if (call && !call.startedAt && payload?.timestamp && topic !== 'call.completed') {
    call.startedAt = toDate(payload.timestamp);
  }
  // call.completed arrives once the recording exists → full pipeline.
  // Earlier call.* events create / update the row (they may carry the user
  // who answered) but do not trigger download or transcription.
  let kind = 'ignore';
  if (topic === 'call.completed' || topic === 'call.ended' || topic === 'call.finished') kind = 'call_completed';
  else if (topic.startsWith('call.')) kind = 'call_update';
  return {
    providerEventId: providerEventId ? String(providerEventId) : null,
    topic: topic || null,
    providerCallId: call?.providerCallId || null,
    kind: call ? kind : 'ignore',
    call
  };
}

// ─── REST API ────────────────────────────────────────────────────────────

function api(creds = {}) {
  const base = (creds.apiBaseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const apiKey = creds.apiKey;
  if (!apiKey) {
    const err = new Error('Allo API key is not configured for this location');
    err.code = 'NO_API_KEY';
    throw err;
  }

  async function request(method, path, { query, body } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!resp.ok) {
      const err = new Error(`Allo ${method} ${path} → HTTP ${resp.status}${json?.message ? `: ${json.message}` : ''}`);
      err.status = resp.status; err.body = json || text;
      throw err;
    }
    return json;
  }

  // Allo's list envelope is not documented; accept the common shapes.
  const items = (json) => (Array.isArray(json) ? json : (json?.data || json?.items || json?.results || []));
  const nextCursor = (json) => json?.next_cursor || json?.next || json?.meta?.next_cursor || json?.pagination?.next || null;

  async function listAll(path, query = {}) {
    const out = []; let cursor = null; let guard = 0;
    do {
      const json = await request('GET', path, { query: { ...query, ...(cursor ? { cursor } : {}) } });
      out.push(...items(json));
      cursor = nextCursor(json);
    } while (cursor && ++guard < 200);
    return out;
  }

  return {
    me: () => request('GET', '/v2/api/me'),
    listUsers: () => listAll('/v2/api/users'),
    listNumbers: () => listAll('/v2/api/numbers'),
    // Historical calls. Filters are best-effort until the reference is
    // confirmed; the backfill script passes what it has and we filter again
    // client-side on type/date.
    listConversations: (query = {}) => listAll('/v2/api/conversations', query),
    searchItems: (body = {}) => request('POST', '/v2/api/conversations/items/search', { body }),
    listWebhooks: () => request('GET', '/v2/api/webhooks'),
    createWebhook: (url, topics = WEBHOOK_TOPICS) => request('POST', '/v2/api/webhooks', { body: { url, topics } }),
    deleteWebhook: (id) => request('DELETE', `/v2/api/webhooks/${encodeURIComponent(id)}`)
  };
}

/**
 * Download a recording. The documented URL is on storage.withallo.com and
 * looks public-but-unguessable; if it answers 401/403 we retry with the API
 * key, since that is the other obvious contract.
 */
async function fetchRecording(url, creds = {}) {
  const attempt = async (headers) => fetch(url, { headers, redirect: 'follow' });
  let resp = await attempt({});
  if ((resp.status === 401 || resp.status === 403) && creds.apiKey) {
    resp = await attempt({ Authorization: `Api-Key ${creds.apiKey}` });
  }
  if (!resp.ok) {
    const err = new Error(`recording fetch → HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

export const allo = {
  name: NAME,
  webhookTopics: WEBHOOK_TOPICS,
  verifyWebhook,
  parseEvent,
  normaliseCall,
  fetchRecording,
  api
};
