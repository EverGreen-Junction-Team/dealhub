import express from 'express';
import { requireSession } from './auth.js';
import { withTenant } from '../db.js';
import { listSkills } from '../services/ai/skillStore.js';
import { isConfigured, MODEL, tokenTotals } from '../services/ai/claudeClient.js';
import { askDeal } from '../services/ai/askDeal.js';
import { askPortfolio } from '../services/ai/askPortfolio.js';
import {
  recordFeedback, recordRunRating, deleteConversation, renameConversation, askHistory, portfolioHistory
} from '../services/ai/runLog.js';
import {
  listMemories, createMemory, importMemories, deleteMemory, deleteAllMemories
} from '../services/ai/memoryStore.js';
import { getAction } from '../services/ai/actionStore.js';
import { confirmAction, rejectAction, ActionExecutionError } from '../services/ai/actionExecutor.js';
import { logger } from '../utils/logger.js';
import { labelForSenderType } from '../services/messageSource.js';

export const aiRouter = express.Router();
aiRouter.use(requireSession);

// Deal Hub AI endpoints.
//
//   GET  /api/ai/status                 → is the AI layer available
//   GET  /api/ai/usage                  → token counts, from ai_runs
//   POST /api/ai/deals/:id/ask          → Call 2, Ask this deal
//   GET  /api/ai/deals/:id/ask/history  → past Q&A, to resume a chat
//   POST /api/ai/runs/:runId/feedback   → human confirm/dismiss on a proposal
//
// Calls 1 (analysis), 3 (next step) and 4 (task proposals) land next, in the
// spec's shipping order. Call 5 (deal assignment) already has a deterministic
// implementation in attributionEngine.js — the LLM there will be a fallback
// for the cases the rule set flags ambiguous, not a replacement.

const MAX_QUESTION = 2000;

// What a REP sees for each AI failure state.
//
// The provider's own error text must never reach the client. An exhausted
// credit balance arrives as the literal string
//   400 {"type":"error","error":{"type":"invalid_request_error", ...}}
// and passing err.message straight through put that JSON blob on screen —
// api/client.js prefers the server's `error` field precisely because it is
// supposed to be written for a human, so a raw provider payload there
// defeats the whole contract. Seen in production 2026-09-25.
//
// The client maps `code` to its own copy where it wants surface-specific
// wording; these are the fallbacks, and they have to stand alone.
const AI_ERROR_MESSAGE = {
  no_credit:
    'The AI account has run out of credit. An admin needs to top it up before '
    + 'this will work — retrying will not help.',
  timeout: 'The model took too long. Try again, or ask something narrower.',
  rate_limited: 'Too many requests just now. Wait a moment and try again.',
  malformed: 'The model returned something unreadable. Try rephrasing the question.',
  api_error: 'The AI service could not be reached. Try again in a moment.',
  // Anthropic's output filter refused the answer twice (the loop already
  // retried once). Not a server or connection problem, and not permanent —
  // a differently worded question over the same thread usually goes through.
  content_filtered:
    'The AI\'s content filter blocked that answer. This is usually a one-off — '
    + 'please try again. If it happens twice, rephrase the question.'
};

function aiErrorMessage(aiStatus) {
  return AI_ERROR_MESSAGE[aiStatus] || 'Could not get an answer. Try again in a moment.';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Channels a question can be scoped to. Whitelisted so an arbitrary string
// can't silently match nothing and return "no messages" for a question the
// rep expected an answer to.
// 'note' and 'task' are evidence KINDS rather than message channels, but they
// travel in the same scope list because the UI presents them as one row of
// chips — "what should this answer read".
const ALLOWED_CHANNELS = new Set([
  'email', 'sms', 'whatsapp', 'imessage', 'call', 'note', 'task'
]);

// The UI needs to know whether to show the AI panels at all. Cheaper and
// clearer than letting every call 503.
aiRouter.get('/status', (_req, res) => {
  res.json({ available: isConfigured() });
});

function requireAI(_req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'The AI layer is not configured on this server.',
      code: 'AI_NOT_CONFIGURED'
    });
  }
  next();
}

// ── POST /api/ai/deals/:id/ask ────────────────────────────────────────

// Attached images, validated before they reach the model.
//
// Three layers, and each catches a different thing:
//
//   1. The BROWSER checks file.size at pick time, before reading the file, so
//      an oversized image never uploads and the message names the file and its
//      size. This is where a real user meets the limit.
//   2. THIS function re-checks per-image and total size. A client check is a
//      courtesy, not a guarantee — anything calling the API directly lands
//      here.
//   3. express.json's 7mb limit is the backstop, and index.js turns its 413
//      into a readable message.
//
// Layer 2 only sees payloads small enough to parse, so its specific messages
// ("image 1 is 6.0 MB") fire for direct API callers within the body limit; a
// far-oversized body is refused at layer 3 with the general message. Raising
// the body limit to make layer 2 catch everything would reopen a ~20MB upload
// path, which is the thing the limit exists to prevent.
//
// Limits are deliberate: a 5MB base64 payload is ~6.7MB of JSON, and the API
// rejects images over 5MB anyway — better a clear 400 here than an opaque
// upstream failure. Three per question is well beyond any real use and caps
// the request size.
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Total across all attachments. Must stay under the 7mb express.json limit in
// index.js once base64 inflation (4/3) is applied: 5MB of pixels is ~6.7MB of
// JSON, so 5MB is the most that can fit in one request.
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp'
]);

function parseImages(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error('images must be an array');
  if (raw.length > MAX_IMAGES) {
    throw new Error(`at most ${MAX_IMAGES} images per question`);
  }

  const parsed = raw.map((img, i) => {
    const mediaType = String(img?.mediaType || '').toLowerCase();
    const data = String(img?.data || '');

    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
      throw new Error(
        `image ${i + 1}: type must be one of ${[...ALLOWED_IMAGE_TYPES].join(', ')}`
      );
    }
    // Reject anything that isn't clean base64 before it reaches the API —
    // a data: URL prefix left on the front is the common mistake.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error(`image ${i + 1}: data must be base64 with no data: prefix`);
    }
    // 4 base64 chars encode 3 bytes.
    const bytes = Math.floor(data.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(
        `image ${i + 1} is ${mb(bytes)} — the limit is ${mb(MAX_IMAGE_BYTES)} per image`
      );
    }
    return { mediaType, data, bytes };
  });

  // Per-image checks alone let three 4MB images through, which is 12MB of
  // pixels and ~16MB of JSON — past the body limit, so Express would 413 it
  // and the rep would see a network error rather than a reason.
  const total = parsed.reduce((n, p) => n + p.bytes, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      `attachments total ${mb(total)} — the limit is ${mb(MAX_TOTAL_BYTES)} per question`
    );
  }

  return parsed.map(({ mediaType, data }) => ({ mediaType, data }));
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

aiRouter.post('/deals/:id/ask', requireAI, async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const question = String(req.body?.question || '').trim();

  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: `question must be under ${MAX_QUESTION} characters` });
  }

  // Prior Q&A for follow-ups. Client-held rather than server-persisted: the
  // chat is scratch context, and ai_runs already records every question with
  // its answer for the audit trail.
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((h) => h && typeof h.content === 'string')
        .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }))
    : [];

  // The conversation this question belongs to. Absent = start a new one.
  //
  // Validated as a UUID rather than trusted: it is written straight onto
  // ai_runs, and a malformed value would fail the insert AFTER the model call
  // — losing a paid answer to a typo in the request body.
  const rawConv = req.body?.conversationId;
  const conversationId =
    typeof rawConv === 'string' && UUID_RE.test(rawConv) ? rawConv : null;

  // Optional per-question channel scope, e.g. ['sms']. Transient: it narrows
  // this one answer and is recorded on the run, but never changes stored
  // inclusion state.
  const channels = Array.isArray(req.body?.channels)
    ? req.body.channels
        .filter((c) => typeof c === 'string')
        .map((c) => c.toLowerCase())
        .filter((c) => ALLOWED_CHANNELS.has(c))
    : null;

  // Optional attached images.
  //
  // These are a QUESTION AID, never evidence: they help the model understand
  // what is being asked ("is this the profile they meant?"), but rule 1 still
  // stands — every claim must quote a real message, and validate.js still drops
  // anything unquotable. An image has no message id, so a claim resting on one
  // could never be verified by clicking through, which is exactly what the
  // citation system exists to prevent.
  let images;
  try {
    images = parseImages(req.body?.images);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await askDeal({
      locationId,
      opportunityId,
      question,
      // Hidden reply target from the timeline's Reply button — see askDeal.
      replyTo: req.body?.replyTo && typeof req.body.replyTo === 'object' && req.body.replyTo.messageId
        ? { messageId: String(req.body.replyTo.messageId).slice(0, 128),
            subject: String(req.body.replyTo.subject || '').slice(0, 300) }
        : null,
      history,
      images,
      channels: channels && channels.length ? channels : null,
      conversationId,
      userId: req.session?.userId || null
    });
    res.json(result);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    // Model failures get a real status and code so the UI can render a
    // specific state rather than a permanent spinner (spec §5).
    if (err.aiStatus) {
      logger.warn(
        { locationId, opportunityId, aiStatus: err.aiStatus, runId: err.runId },
        'ai: ask failed'
      );
      return res.status(err.status || 502).json({
        // Never err.message — that is the provider's raw payload.
        error: aiErrorMessage(err.aiStatus),
        code: err.aiStatus.toUpperCase(),
        runId: err.runId || null
      });
    }
    logger.error({ err, locationId, opportunityId }, 'POST /api/ai/deals/:id/ask failed');
    next(err);
  }
});

// ── POST /api/ai/portfolio/ask ────────────────────────────────────────
//
// One question across EVERY deal in the sub-account — "which deals are
// stalling?", "who has gone quiet?".
//
// Two model calls, not one: step one reads deal facts only (no message
// bodies) and decides which deals matter; step two reads just those threads
// and answers with verbatim quotes. That is what lets rule 1 — every claim
// quotes a real message — survive at pipeline scale. Many questions never
// reach step two and cost a single call.
//
// No :id, so nothing to scope to a deal. RLS still scopes it to the location.

// ── GET /api/ai/skills ────────────────────────────────────────────────
// The skills a REP can mention with @ in the composer.
//
// Deliberately not /api/control/skills: that one is for whoever configures
// them and returns the whole row — view name, column mappings, parameter
// operators. A rep picking from a menu needs a name and a sentence, and
// nothing about the database should reach a sales rep's screen.
//
// Portfolio only. Deal AI's answer path is a single schema-constrained call
// with no tools, so a skill cannot run there — offering one in that composer
// would be a menu of things that silently do nothing.
aiRouter.get('/skills', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const skills = await listSkills(locationId, {
      enabledOnly: true,
      surface: 'portfolio'
    });
    res.json({
      skills: skills.map((s) => ({
        name: s.name,
        // What the picker shows under the name. The admin description is
        // written FOR the model ("use for 'which of Sarah's deals...'"), which
        // is close enough to what a rep needs to be worth reusing rather than
        // making someone write it twice.
        description: s.description
      }))
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/ai/skills failed');
    next(err);
  }
});

aiRouter.post('/portfolio/ask', requireAI, async (req, res, next) => {
  const locationId = req.locationId;
  const question = String(req.body?.question || '').trim();

  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: `question must be under ${MAX_QUESTION} characters` });
  }

  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((h) => h && typeof h.content === 'string')
        .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }))
    : [];

  const rawConv = req.body?.conversationId;
  const conversationId =
    typeof rawConv === 'string' && UUID_RE.test(rawConv) ? rawConv : null;

  // Optional attached images — same contract as the per-deal ask above: a
  // QUESTION AID, never evidence. Rule 1 still stands, and validate.js still
  // drops any claim that can't quote a real message.
  let images;
  try {
    images = parseImages(req.body?.images);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await askPortfolio({
      locationId,
      question,
      history,
      images,
      conversationId,
      userId: req.session?.userId || null
    });
    res.json(result);
  } catch (err) {
    if (err.aiStatus) {
      logger.warn({ locationId, aiStatus: err.aiStatus }, 'ai: portfolio ask failed');
      return res.status(err.status || 502).json({
        // Never err.message — that is the provider's raw payload.
        error: aiErrorMessage(err.aiStatus),
        code: err.aiStatus.toUpperCase()
      });
    }
    logger.error({ err, locationId }, 'POST /api/ai/portfolio/ask failed');
    next(err);
  }
});

// ── DELETE /api/ai/conversations/:conversationId ──────────────────────
// The sidebar's "Delete chat" — same route for a deal conversation or a
// portfolio one, since deleteConversation only needs the id, not which kind
// it is. ai_feedback and ai_run_rating cascade on the deleted ai_runs rows.

aiRouter.delete('/conversations/:conversationId', async (req, res, next) => {
  const locationId = req.locationId;
  const conversationId = req.params.conversationId;

  if (!UUID_RE.test(conversationId)) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }

  try {
    const deleted = await deleteConversation(locationId, conversationId);
    if (deleted === 0) {
      // Not an error: a rep double-clicking Delete, or a stale rail entry
      // for a conversation already gone, should read as "already deleted"
      // rather than fail — the end state the rep wanted is achieved either
      // way.
      return res.status(404).json({ error: 'Conversation not found', deleted: 0 });
    }
    logger.info({ locationId, conversationId, deleted }, 'ai: conversation deleted');
    res.json({ deleted });
  } catch (err) {
    logger.error({ err, locationId, conversationId }, 'DELETE /api/ai/conversations/:conversationId failed');
    next(err);
  }
});

// ── PATCH /api/ai/conversations/:conversationId ───────────────────────
// The sidebar's "Rename" — same route shape as delete. There's no
// ai_conversations row to update; renameConversation overwrites the
// custom_title column on the conversation's first ai_runs row, which is the
// only row either history query reads a title from.

aiRouter.patch('/conversations/:conversationId', async (req, res, next) => {
  const locationId = req.locationId;
  const conversationId = req.params.conversationId;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';

  if (!UUID_RE.test(conversationId)) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (title.length > 200) {
    return res.status(400).json({ error: 'title is too long (max 200 characters)' });
  }

  try {
    const updated = await renameConversation(locationId, conversationId, title);
    if (updated === 0) {
      return res.status(404).json({ error: 'Conversation not found', updated: 0 });
    }
    logger.info({ locationId, conversationId }, 'ai: conversation renamed');
    res.json({ title });
  } catch (err) {
    logger.error({ err, locationId, conversationId }, 'PATCH /api/ai/conversations/:conversationId failed');
    next(err);
  }
});

// ── GET /api/ai/portfolio/ask/history ─────────────────────────────────
// Past portfolio conversations. Same shape as the deal history, but for runs
// with no opportunity_id.

aiRouter.get('/portfolio/ask/history', async (req, res, next) => {
  const locationId = req.locationId;
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  try {
    const chats = await portfolioHistory(locationId, limit);
    res.json({ chats });
  } catch (err) {
    logger.error({ err, locationId }, 'GET portfolio ask/history failed');
    next(err);
  }
});

// ── GET /api/ai/deals/:id/ask/history ─────────────────────────────────
// Past Q&A for this deal, so a rep can reopen a chat after a reload. Served
// from ai_runs — no separate chat store to drift out of sync with the audit
// trail. Deliberately NOT gated on requireAI: history should still be
// readable when the key is missing or the model is down (spec §5 — confirmed
// values must remain readable when the model is unavailable).

aiRouter.get('/deals/:id/ask/history', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  try {
    const chats = await askHistory(locationId, opportunityId, limit);
    res.json({ chats });
  } catch (err) {
    logger.error({ err, locationId, opportunityId }, 'GET ask/history failed');
    next(err);
  }
});

// ── PUT /api/ai/deals/:id/messages/:messageId/inclusion ───────────────
// Include or exclude one message from what the AI reads (spec §1C).
//
// Excluding is a deliberate rep judgement, so it's persisted with who and
// why — and it invalidates any cached analysis, because the message set the
// cache key is built from has changed (spec rule 5: source change
// invalidates).

// ── GET /api/ai/usage ─────────────────────────────────────────────────
// Token usage for this location, from ai_runs. Broken down by call type so a
// heavy prompt is identifiable, and by day so a spike is visible.
//
// Tokens, not money: per-model rates aren't returned by the API and change
// over time, so anything computed here would be a guess presented as fact.
// Anthropic's console is the authority on cost.
//
// ?days=N (default 30, max 365)

aiRouter.get('/usage', async (req, res, next) => {
  const locationId = req.locationId;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  try {
    const out = await withTenant(locationId, async (client) => {
      const byCall = await client.query(
        `SELECT call_type,
                COUNT(*)::int                                  AS calls,
                COUNT(*) FILTER (WHERE status <> 'ok')::int     AS failed,
                COALESCE(SUM(input_tokens), 0)::bigint          AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint         AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0)::bigint     AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0)::bigint    AS cache_write_tokens,
                ROUND(AVG(latency_ms))::int                     AS avg_latency_ms
           FROM ai_runs
          WHERE location_id = $1
            AND created_at > now() - ($2 || ' days')::interval
          GROUP BY call_type
          ORDER BY calls DESC`,
        [locationId, String(days)]
      );
      const byDay = await client.query(
        `SELECT date_trunc('day', created_at)::date       AS day,
                COUNT(*)::int                             AS calls,
                COALESCE(SUM(input_tokens), 0)::bigint    AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint   AS output_tokens
           FROM ai_runs
          WHERE location_id = $1
            AND created_at > now() - ($2 || ' days')::interval
          GROUP BY 1
          ORDER BY 1 DESC`,
        [locationId, String(days)]
      );
      return { byCall: byCall.rows, byDay: byDay.rows };
    });

    const rows = out.byCall.map((r) => ({
      callType: r.call_type,
      calls: r.calls,
      failed: r.failed,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      avgLatencyMs: r.avg_latency_ms,
      // Tokens only — cost depends on current per-model rates the API doesn't
      // return, so we report what we measured, not what we guessed.
      totalInputTokens:
        Number(r.input_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens)
    }));

    res.json({
      days,
      model: MODEL,
      totals: {
        calls: rows.reduce((n, r) => n + r.calls, 0),
        failed: rows.reduce((n, r) => n + r.failed, 0),
        inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
        cacheReadTokens: rows.reduce((n, r) => n + r.cacheReadTokens, 0),
        cacheWriteTokens: rows.reduce((n, r) => n + r.cacheWriteTokens, 0)
      },
      byCall: rows,
      byDay: out.byDay.map((d) => ({
        day: d.day,
        calls: d.calls,
        inputTokens: Number(d.input_tokens),
        outputTokens: Number(d.output_tokens)
      })),
      // What this process has spent since its last restart — useful when
      // watching a change land, whereas the figures above are durable.
      sinceRestart: tokenTotals()
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/ai/usage failed');
    next(err);
  }
});

// Mirrors the per-call estimate in claudeClient. Duplicated deliberately: the
// aggregate has only summed columns to work from, not a per-call breakdown of
// fresh vs cached input, so it can't reuse the same function signature.
// ── GET /api/ai/deals/:id/scope ───────────────────────────────────────
// What the AI would read right now, broken down by channel. Powers the counts
// on the "Ask about" chips so a rep can see the scope BEFORE spending a call —
// "SMS · 6" tells you the filter is worth applying; "Email · 0" tells you it
// isn't.
//
// Same three filters as the real context build (filed to this deal, readable,
// not excluded), so the numbers can't disagree with what an answer reports.
// Not gated on requireAI: the counts are useful even with no key configured.

aiRouter.get('/deals/:id/scope', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  try {
    const out = await withTenant(locationId, async (client) => {
      // Aggregate in SQL rather than reusing buildDealContext: that runs 9
      // queries and pulls every message body, which is a lot of work to
      // produce a number on a chip — and this fires on every deal open.
      // Same three filters, so the counts can't disagree with a real answer.
      const r = await client.query(
        `SELECT
           CASE
             WHEN m.is_call OR upper(coalesce(m.message_channel,'')) LIKE '%CALL%'
               OR upper(coalesce(m.message_channel,'')) LIKE '%VOICEMAIL%' THEN 'call'
             WHEN upper(coalesce(m.message_channel,'')) LIKE '%EMAIL%'     THEN 'email'
             WHEN upper(coalesce(m.message_channel,'')) LIKE '%WHATSAPP%'  THEN 'whatsapp'
             WHEN upper(coalesce(m.message_channel,'')) LIKE '%IMESSAGE%'  THEN 'imessage'
             WHEN upper(coalesce(m.message_channel,'')) LIKE '%SMS%'       THEN 'sms'
             ELSE 'other'
           END AS channel,
           -- Readable = has text the model could actually consume. A call
           -- needs a transcript; everything else needs a body.
           COUNT(*) FILTER (
             WHERE x.subject_id IS NULL
               AND CASE
                     WHEN m.is_call OR upper(coalesce(m.message_channel,'')) LIKE '%CALL%'
                       THEN ct.fetch_status = 'ok' AND coalesce(ct.transcript_text,'') <> ''
                     ELSE coalesce(m.message_body, '') <> ''
                   END
           )::int AS readable,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE x.subject_id IS NOT NULL)::int AS excluded
         FROM messages m
         JOIN message_opportunity_map mom
           ON mom.location_id = m.location_id
          AND mom.message_id  = m.message_id
          AND mom.superseded_at IS NULL
          AND mom.mapping_status IN ('mapped', 'manually_resolved')
         LEFT JOIN call_transcriptions ct
           ON ct.location_id = m.location_id AND ct.message_id = m.message_id
         LEFT JOIN ai_exclusions x
           ON x.location_id    = m.location_id
          AND x.subject_type   = 'message'
          AND x.subject_id     = m.message_id
          AND x.opportunity_id = mom.opportunity_id
        WHERE m.location_id = $1
          AND mom.opportunity_id = $2
          AND m.deleted_at IS NULL
        GROUP BY 1`,
        [locationId, opportunityId]
      );
      const notes = await client.query(
        `SELECT COUNT(*)::int AS n FROM notes
          WHERE location_id = $1 AND opportunity_id = $2 AND status = 'active'`,
        [locationId, opportunityId]
      );
      return { rows: r.rows, notes: notes.rows[0].n };
    });

    const byChannel = {};
    let readable = 0;
    let total = 0;
    let excluded = 0;
    let untranscribedCalls = 0;
    for (const r of out.rows) {
      if (r.readable > 0) byChannel[r.channel] = r.readable;
      readable += r.readable;
      total += r.total;
      excluded += r.excluded;
      if (r.channel === 'call') {
        untranscribedCalls += r.total - r.excluded - r.readable;
      }
    }

    const unreadReasons = [];
    if (untranscribedCalls > 0) {
      unreadReasons.push(
        `${untranscribedCalls} call${untranscribedCalls === 1 ? '' : 's'} not transcribed`
      );
    }
    if (excluded > 0) unreadReasons.push(`${excluded} excluded`);

    res.json({
      readable,
      notes: out.notes,
      byChannel,
      coverage: { messagesTotal: total, messagesRead: readable, unreadReasons }
    });
  } catch (err) {
    logger.error({ err, locationId, opportunityId }, 'GET deal scope failed');
    next(err);
  }
});

// ── GET /api/ai/runs/:runId/messages ──────────────────────────────────
// The messages one run actually read, resolved from ai_runs.input_message_ids.
// Powers the "N messages considered · show more" modal on a chat.
//
// Reads the ids stored ON THE RUN rather than recomputing from the deal, so an
// old chat shows what it truly read even after the thread has grown or the
// inclusion state has changed. That's the difference between an audit trail
// and a guess.

aiRouter.get('/runs/:runId/messages', async (req, res, next) => {
  const locationId = req.locationId;
  const runId = req.params.runId;
  try {
    const out = await withTenant(locationId, async (client) => {
      const run = await client.query(
        `SELECT input_message_ids, question, created_at, messages_total,
                messages_read, unread_reasons
           FROM ai_runs
          WHERE location_id = $1 AND id = $2`,
        [locationId, runId]
      );
      if (!run.rowCount) return null;
      const ids = run.rows[0].input_message_ids || [];
      if (ids.length === 0) return { run: run.rows[0], messages: [] };

      // Notes are citable evidence too, so an id may be a note rather than a
      // message — union both so the modal accounts for every id.
      const msgs = await client.query(
        `SELECT m.message_id AS id, m.message_channel, m.message_direction,
                m.message_body, m.message_timestamp, m.is_call,
                c.first_name, c.last_name, m.sender_name, m.sender_type,
                cp.name AS provider_name,
                ct.transcript_text
           FROM messages m
           LEFT JOIN contacts c
             ON c.location_id = m.location_id AND c.contact_id = m.contact_id
           LEFT JOIN conversation_providers cp
             ON cp.location_id = m.location_id AND cp.provider_id = m.conversation_provider_id
           LEFT JOIN call_transcriptions ct
             ON ct.location_id = m.location_id AND ct.message_id = m.message_id
          WHERE m.location_id = $1 AND m.message_id = ANY($2::text[])
          ORDER BY m.message_timestamp ASC`,
        [locationId, ids]
      );
      const notes = await client.query(
        `SELECT note_id AS id, body, author_name,
                COALESCE(created_at_ghl, imported_at) AS ts
           FROM notes
          WHERE location_id = $1 AND note_id = ANY($2::text[])`,
        [locationId, ids]
      );
      return { run: run.rows[0], messages: msgs.rows, notes: notes.rows };
    });

    if (!out) return res.status(404).json({ error: 'Run not found' });

    const items = [
      ...out.messages.map((m) => {
        const isCall = m.is_call || /CALL|VOICEMAIL/i.test(m.message_channel || '');
        return {
          id: m.id,
          kind: 'message',
          channel: normaliseAskChannel(m.message_channel, isCall),
          direction: m.message_direction === 'inbound' ? 'in' : 'out',
          // "Us" was a dishonest generic label when GHL's own payload omits
          // which rep sent an outbound message (confirmed unrecoverable —
          // see routes/deals.js). Same sender_type + provider distinction
          // as the deal timeline.
          who: m.message_direction === 'inbound'
            ? [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Contact'
            : (m.sender_name || labelForSenderType(m.sender_type, m.provider_name)),
          body: isCall ? m.transcript_text : m.message_body,
          at: m.message_timestamp
        };
      }),
      ...(out.notes || []).map((n) => ({
        id: n.id,
        kind: 'note',
        channel: 'note',
        direction: 'out',
        who: n.author_name || 'Note',
        body: n.body,
        at: n.ts
      }))
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    res.json({
      question: out.run.question,
      askedAt: out.run.created_at,
      messagesTotal: out.run.messages_total,
      messagesRead: out.run.messages_read,
      unreadReasons: out.run.unread_reasons || [],
      items
    });
  } catch (err) {
    if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid run id' });
    logger.error({ err, locationId, runId }, 'GET run messages failed');
    next(err);
  }
});

function normaliseAskChannel(raw, isCall) {
  if (isCall) return 'call';
  const c = String(raw || '').toUpperCase();
  if (c.includes('EMAIL')) return 'email';
  if (c.includes('WHATSAPP')) return 'whatsapp';
  if (c.includes('IMESSAGE')) return 'imessage';
  if (c.includes('SMS')) return 'sms';
  if (c.includes('NOTE')) return 'note';
  return c.toLowerCase() || 'unknown';
}

// Batch form. The timeline ticks several boxes before asking, so the client
// accumulates changes and flushes them in one request rather than firing a
// PUT per click — five checkboxes was five round trips.
aiRouter.put('/deals/:id/inclusions', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const changes = req.body?.changes;

  if (!Array.isArray(changes)) {
    return res.status(400).json({ error: 'changes must be an array' });
  }
  if (changes.length > 500) {
    return res.status(400).json({ error: 'too many changes in one request' });
  }

  // Last write wins per subject, so a tick-untick-tick sequence collapses to
  // one decision instead of three conflicting rows.
  //
  // Keyed on "type:id" rather than id alone: a note and a message can share an
  // id, and keying on id would let one silently overwrite the other's decision.
  const SUBJECT_TYPES = new Set(['message', 'note', 'task']);
  const byKey = new Map();
  for (const c of changes) {
    if (!c || typeof c.included !== 'boolean') continue;
    // `messageId` is the original field name and still accepted, so an older
    // client keeps working without a coordinated deploy.
    const id = typeof c.subjectId === 'string' ? c.subjectId
      : typeof c.messageId === 'string' ? c.messageId
        : null;
    if (!id) continue;
    const type = SUBJECT_TYPES.has(c.subjectType) ? c.subjectType : 'message';
    byKey.set(`${type}:${id}`, {
      id, type, included: c.included, reason: c.reason || null
    });
  }
  if (byKey.size === 0) return res.json({ applied: 0 });

  const rows = [...byKey.values()];
  const excluded = rows.filter((r) => !r.included);
  const included = rows.filter((r) => r.included);
  const actor = req.session?.userName || req.session?.userId || null;

  try {
    await withTenant(locationId, async (client) => {
      // Re-including is the default state, so it removes rows. Type travels as
      // a parallel array so one statement covers messages, notes and tasks.
      if (included.length) {
        await client.query(
          `DELETE FROM ai_exclusions
            WHERE location_id = $1 AND opportunity_id = $2
              AND (subject_type, subject_id) IN (
                SELECT t.stype, t.sid
                  FROM unnest($3::text[], $4::text[]) AS t(stype, sid)
              )`,
          [
            locationId, opportunityId,
            included.map((r) => r.type),
            included.map((r) => r.id)
          ]
        );
      }
      if (excluded.length) {
        // Reasons are per-subject, so they travel as a parallel array rather
        // than one value smeared across every row — otherwise excluding two
        // items for different reasons would record the first one twice.
        await client.query(
          `INSERT INTO ai_exclusions
             (location_id, opportunity_id, subject_type, subject_id, excluded_by, reason)
           SELECT $1, $2, t.stype, t.sid, $5, t.reason
             FROM unnest($3::text[], $4::text[], $6::text[]) AS t(stype, sid, reason)
           ON CONFLICT (location_id, opportunity_id, subject_type, subject_id)
           DO UPDATE SET excluded_by = EXCLUDED.excluded_by,
                         reason      = EXCLUDED.reason,
                         created_at  = now()`,
          [
            locationId,
            opportunityId,
            excluded.map((r) => r.type),
            excluded.map((r) => r.id),
            actor,
            excluded.map((r) => r.reason)
          ]
        );
      }
    });
    logger.info(
      { locationId, opportunityId, excluded: excluded.length, included: included.length },
      'ai: inclusions batch applied'
    );
    res.json({
      applied: byKey.size,
      excluded: excluded.map((r) => ({ subjectType: r.type, subjectId: r.id })),
      included: included.map((r) => ({ subjectType: r.type, subjectId: r.id }))
    });
  } catch (err) {
    logger.error({ err, locationId, opportunityId }, 'PUT inclusions batch failed');
    next(err);
  }
});

// Single-message form. Kept for direct/scripted use; the UI uses the batch
// endpoint above.
aiRouter.put('/deals/:id/messages/:messageId/inclusion', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const messageId = req.params.messageId;
  const included = req.body?.included;

  if (typeof included !== 'boolean') {
    return res.status(400).json({ error: 'included must be a boolean' });
  }

  try {
    await withTenant(locationId, async (client) => {
      if (included) {
        // Included is the default state, so re-including just removes the row.
        await client.query(
          `DELETE FROM ai_exclusions
            WHERE location_id = $1 AND opportunity_id = $2
              AND subject_type = 'message' AND subject_id = $3`,
          [locationId, opportunityId, messageId]
        );
      } else {
        await client.query(
          `INSERT INTO ai_exclusions
             (location_id, opportunity_id, subject_type, subject_id, excluded_by, reason)
           VALUES ($1, $2, 'message', $3, $4, $5)
           ON CONFLICT (location_id, opportunity_id, subject_type, subject_id)
           DO UPDATE SET excluded_by = EXCLUDED.excluded_by,
                         reason      = EXCLUDED.reason,
                         created_at  = now()`,
          [
            locationId,
            opportunityId,
            messageId,
            req.session?.userName || req.session?.userId || null,
            req.body?.reason ? String(req.body.reason).slice(0, 500) : null
          ]
        );
      }
    });
    logger.info({ locationId, opportunityId, messageId, included }, 'ai: inclusion updated');
    res.json({ messageId, included });
  } catch (err) {
    logger.error({ err, locationId, opportunityId, messageId }, 'PUT inclusion failed');
    next(err);
  }
});

// ── POST /api/ai/runs/:runId/rating ───────────────────────────────────
// Thumbs up/down on a Co-Pilot ANSWER. Separate from /feedback above, which
// confirms/dismisses/edits a proposed CRM item — a reaction has no item to
// identify, nothing to edit, and one rating per run rather than one per item.

const RATINGS = new Set(['up', 'down']);

// Same chip ids as GHL's own NegativeFeedbackModal.vue
// (NEGATIVE_FEEDBACK_REASON_IDS) — kept in lockstep intentionally, so a
// report can group our ratings by reason the same way GHL's own analytics
// do. Whitelisted rather than trusted free text: an arbitrary string here
// would silently fail to group with anything.
const RATING_REASON_IDS = new Set([
  'ui_bug', 'not_factually_correct', 'didnt_follow_instructions',
  'refused_when_it_shouldnt', 'incomplete_response', 'report_content', 'other'
]);

aiRouter.post('/runs/:runId/rating', requireAI, async (req, res, next) => {
  const locationId = req.locationId;
  const runId = req.params.runId;
  const { rating, reason } = req.body || {};

  if (!RATINGS.has(rating)) {
    return res.status(400).json({ error: 'rating must be up or down' });
  }

  // Chip ids from the negative-feedback modal. Silently dropped rather than
  // 400ing on an unknown id — a stale client sending an old id set should
  // not fail the whole rating over a cosmetic mismatch.
  const reasons = Array.isArray(req.body?.reasons)
    ? req.body.reasons.filter((r) => typeof r === 'string' && RATING_REASON_IDS.has(r))
    : [];

  try {
    const row = await recordRunRating(locationId, {
      runId,
      rating,
      reasons,
      reason: reason ? String(reason).slice(0, 2000) : null,
      ratedBy: req.session?.userId || null
    });
    logger.info({ locationId, runId, rating }, 'ai: run rated');
    res.json({ id: row.id, rating: row.rating });
  } catch (err) {
    if (err?.code === '23503') {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (err?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid run id' });
    }
    logger.error({ err, locationId, runId }, 'POST /api/ai/runs/:runId/rating failed');
    next(err);
  }
});

// ── POST /api/ai/runs/:runId/feedback ─────────────────────────────────
// Confirm / dismiss / edit one proposed item. Nothing the model proposes
// counts until this is called (spec rule 2). Dismissal reasons are the
// highest-value tuning signal in the system, so `reason` is encouraged.

const ACTIONS = new Set(['confirmed', 'dismissed', 'edited']);

aiRouter.post('/runs/:runId/feedback', requireAI, async (req, res, next) => {
  const locationId = req.locationId;
  const runId = req.params.runId;
  const { itemType, itemKey, itemPayload, action, reason, editedPayload, opportunityId } =
    req.body || {};

  if (!ACTIONS.has(action)) {
    return res.status(400).json({ error: 'action must be confirmed, dismissed or edited' });
  }
  if (!itemType || !itemKey) {
    return res.status(400).json({ error: 'itemType and itemKey are required' });
  }

  try {
    const row = await recordFeedback(locationId, {
      runId,
      opportunityId: opportunityId || null,
      itemType: String(itemType),
      itemKey: String(itemKey),
      itemPayload: itemPayload ?? null,
      action,
      reason: reason ? String(reason).slice(0, 2000) : null,
      editedPayload: editedPayload ?? null,
      actedBy: req.session?.userId || null
    });
    logger.info({ locationId, runId, itemType, action }, 'ai: feedback recorded');
    res.json({ id: row.id, action: row.action });
  } catch (err) {
    // A bad run id is a client error, not a server fault.
    if (err?.code === '23503') {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (err?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid run id' });
    }
    logger.error({ err, locationId, runId }, 'POST /api/ai/runs/:runId/feedback failed');
    next(err);
  }
});

// ── Co-Pilot memories ("Personalization") ──────────────────────────────
//
// Facts a rep has told Co-Pilot to remember across every future chat.
// Per-user, not per-run — there is no runId here, unlike everything above.
// requireSession (applied to the whole router) guarantees req.session, but
// not that it carries a userId — an install predating that field, or a
// session type this route was never exercised against, would otherwise 500
// deep inside a query with a null user_id rather than a clear 401 here.
function requireUserId(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'No user on this session' });
  }
  next();
}

const MAX_IMPORT_MEMORIES = 200;

aiRouter.get('/memory', requireUserId, async (req, res, next) => {
  try {
    const memories = await listMemories(req.locationId, req.session.userId);
    res.json({ memories });
  } catch (err) {
    logger.error({ err, locationId: req.locationId }, 'GET /api/ai/memory failed');
    next(err);
  }
});

aiRouter.post('/memory', requireUserId, async (req, res, next) => {
  try {
    const memory = await createMemory(req.locationId, {
      userId: req.session.userId,
      content: req.body?.content
    });
    res.status(201).json({ memory });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error({ err, locationId: req.locationId }, 'POST /api/ai/memory failed');
    next(err);
  }
});

aiRouter.post('/memory/import', requireUserId, async (req, res, next) => {
  const memories = Array.isArray(req.body?.memories) ? req.body.memories : [];
  if (memories.length > MAX_IMPORT_MEMORIES) {
    return res.status(400).json({ error: `At most ${MAX_IMPORT_MEMORIES} memories per import` });
  }
  try {
    const result = await importMemories(req.locationId, {
      userId: req.session.userId,
      memories
    });
    res.json(result);
  } catch (err) {
    logger.error({ err, locationId: req.locationId }, 'POST /api/ai/memory/import failed');
    next(err);
  }
});

aiRouter.delete('/memory/:memoryId', requireUserId, async (req, res, next) => {
  try {
    const found = await deleteMemory(req.locationId, {
      userId: req.session.userId,
      memoryId: req.params.memoryId
    });
    if (!found) return res.status(404).json({ error: 'Memory not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid memory id' });
    }
    logger.error({ err, locationId: req.locationId }, 'DELETE /api/ai/memory/:memoryId failed');
    next(err);
  }
});

aiRouter.delete('/memory', requireUserId, async (req, res, next) => {
  try {
    const count = await deleteAllMemories(req.locationId, req.session.userId);
    res.json({ deleted: count });
  } catch (err) {
    logger.error({ err, locationId: req.locationId }, 'DELETE /api/ai/memory failed');
    next(err);
  }
});

// ── AI-proposed CRM writes ──────────────────────────────────────────────
//
// A propose tool (registry.js) only ever INSERTs a 'pending' row into
// ai_actions. These three routes are the entire surface where a rep turns
// that into a real GHL write — GET to render the ActionCard, POST /confirm
// to execute it (optionally with edits), POST /reject to dismiss it. There
// is no other path from a Co-Pilot answer to a CRM write.

aiRouter.get('/actions/:actionId', async (req, res, next) => {
  try {
    const action = await getAction(req.locationId, req.params.actionId);
    if (!action) return res.status(404).json({ error: 'That proposal no longer exists' });
    res.json({
      id: action.id,
      actionType: action.action_type,
      opportunityId: action.opportunity_id,
      proposedPayload: action.proposed_payload,
      status: action.status,
      result: action.result
    });
  } catch (err) {
    if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid proposal id' });
    logger.error({ err, locationId: req.locationId }, 'GET /api/ai/actions/:actionId failed');
    next(err);
  }
});

aiRouter.post('/actions/:actionId/confirm', requireAI, async (req, res, next) => {
  try {
    // `edits` — only the fields a rep actually changed in the ActionCard
    // before confirming; merged over the model's own proposal in
    // confirmAction, so the request body need not repeat every field.
    const { edits } = req.body || {};
    const out = await confirmAction(
      req.locationId, req.params.actionId, edits || null, req.session?.userId || null
    );
    res.json(out);
  } catch (err) {
    if (err instanceof ActionExecutionError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Every write error carrying its own rep-facing message and status —
    // MessageWriteError, TaskWriteError, the rest. They were falling through
    // to the generic handler, which sends a bare 502 with no `error` field,
    // and the dashboard turned that into "Couldn't reach the server". So a
    // 404 "that sender no longer exists" reached a rep as a network problem:
    // wrong cause, wrong fix, and it hid a message the code had already
    // written for exactly this case.
    if (err?.status && err?.message && /Error$/.test(err?.name || '')) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid proposal id' });
    logger.error({ err, locationId: req.locationId }, 'POST /api/ai/actions/:actionId/confirm failed');
    next(err);
  }
});

aiRouter.post('/actions/:actionId/reject', async (req, res, next) => {
  try {
    const out = await rejectAction(req.locationId, req.params.actionId, req.session?.userId || null);
    res.json(out);
  } catch (err) {
    if (err instanceof ActionExecutionError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid proposal id' });
    logger.error({ err, locationId: req.locationId }, 'POST /api/ai/actions/:actionId/reject failed');
    next(err);
  }
});
