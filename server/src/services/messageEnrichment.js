import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

// Per STAGE_HISTORY_WEBHOOK_PLAN Section 3, each stage transition emits one
// row per (message × stage). To produce those rows we have to fetch the
// conversation messages that occurred between `enteredAt` and `leftAt` (or
// `now` for the open row) on the contact's conversations, then assign each
// to the right stage_history row.
//
// This module does just the GHL-side fetch. The stage_history writer
// decides which messages belong to which stage window.

const PAGE_LIMIT = 100;

// Numeric GHL message type → readable channel. Mirrors the mapping we use
// in convoVault's Lambda CSV writer.
export const MESSAGE_TYPE_NAMES = {
  1: 'CALL', 2: 'SMS', 3: 'EMAIL',
  4: 'SMS_REVIEW_REQUEST', 5: 'WEBCHAT', 6: 'SMS_NO_SHOW_REQUEST',
  7: 'CAMPAIGN_SMS', 8: 'CAMPAIGN_CALL', 9: 'CAMPAIGN_EMAIL',
  10: 'CAMPAIGN_VOICEMAIL', 11: 'FACEBOOK', 12: 'CAMPAIGN_FACEBOOK',
  13: 'CAMPAIGN_MANUAL_CALL', 14: 'CAMPAIGN_MANUAL_SMS', 15: 'GMB',
  16: 'CAMPAIGN_GMB', 17: 'REVIEW', 18: 'INSTAGRAM', 19: 'WHATSAPP',
  20: 'CUSTOM_SMS', 21: 'CUSTOM_EMAIL', 22: 'CUSTOM_PROVIDER_SMS',
  23: 'CUSTOM_PROVIDER_EMAIL', 24: 'IVR_CALL',
  25: 'ACTIVITY_CONTACT', 26: 'ACTIVITY_INVOICE', 27: 'ACTIVITY_PAYMENT',
  28: 'ACTIVITY_OPPORTUNITY', 29: 'LIVE_CHAT', 30: 'LIVE_CHAT_INFO_MESSAGE',
  31: 'ACTIVITY_APPOINTMENT', 32: 'FACEBOOK_COMMENT', 33: 'INSTAGRAM_COMMENT',
  34: 'CUSTOM_CALL', 35: 'GROUP_SMS', 36: 'INTERNAL_CHAT',
  37: 'INTERNAL_COMMENT', 38: 'ACTIVITY_EMPLOYEE_ACTION_LOG',
  40: 'EXTERNAL_HUBSPOT', 41: 'TIKTOK', 42: 'TIKTOK_COMMENT',
  43: 'RCS', 44: 'ACTIVITY_WHATSAPP', 45: 'SMS_REACTION',
  50: 'FORM_SUBMISSION', 60: 'FACEBOOK_MARKETING_MESSAGE', 100: 'NO_SHOW'
};

function readableChannel(m) {
  if (m.channel) return String(m.channel);
  const mt = m.messageType;
  if (typeof mt === 'string' && mt.startsWith('TYPE_')) return mt.replace(/^TYPE_/, '');
  if (typeof mt === 'string' && mt) return mt;
  const t = m.type;
  if (typeof t === 'number' && MESSAGE_TYPE_NAMES[t]) return MESSAGE_TYPE_NAMES[t];
  if (t != null) return String(t);
  return '';
}

// List all conversations for a contact. GHL paginates; we follow until done.
async function listContactConversations(install, contactId) {
  const conversations = [];
  let startAfter = null;
  for (let i = 0; i < 20; i++) { // safety bound
    const params = new URLSearchParams({
      locationId: install.location_id,
      contactId,
      limit: String(PAGE_LIMIT)
    });
    if (startAfter) params.set('startAfter', startAfter);
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/conversations/search?${params.toString()}`
    });
    const batch = data?.conversations || [];
    conversations.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    startAfter = batch[batch.length - 1]?.id;
    if (!startAfter) break;
  }
  return conversations;
}

// Fetch all messages on a given conversation, descending by date. Limit
// the walk to a window — GHL returns newest first, so we stop walking once
// we drop below `windowStart`.
async function fetchConversationMessages(install, conversationId, windowStart, windowEnd) {
  const messages = [];
  let lastMessageId = null;
  for (let i = 0; i < 50; i++) { // safety bound
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (lastMessageId) params.set('lastMessageId', lastMessageId);
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/conversations/${conversationId}/messages?${params.toString()}`
    });
    const batch = data?.messages?.messages || data?.messages || [];
    if (!batch.length) break;
    let droppedBelowWindow = false;
    for (const m of batch) {
      const ts = new Date(m.dateAdded || m.timestamp);
      if (Number.isNaN(ts.getTime())) continue;
      if (ts < windowStart) { droppedBelowWindow = true; continue; }
      if (windowEnd && ts > windowEnd) continue;
      messages.push({
        messageId: m.id || m.messageId,
        conversationId,
        timestamp: ts,
        body: m.body || '',
        direction: m.direction || (m.type === 1 ? 'outbound' : (m.direction || 'inbound')),
        channel: readableChannel(m),
        isCall: m.type === 1 || m.messageType === 'TYPE_CALL'
      });
    }
    if (droppedBelowWindow) break; // older pages can't help
    lastMessageId = batch[batch.length - 1]?.id;
    if (!lastMessageId || batch.length < PAGE_LIMIT) break;
  }
  return messages;
}

// LEGACY — kept for fallback / one-off use. Per-conversation message paging
// via GET /conversations/{conversationId}/messages. Slower than the bulk
// export endpoint and more chatty against GHL. Not called from the writer
// anymore — see fetchContactMessagesViaExport below.
export async function fetchContactMessagesInWindow(install, contactId, windowStart, windowEnd) {
  if (!contactId) return [];
  try {
    const conversations = await listContactConversations(install, contactId);
    const all = [];
    for (const c of conversations) {
      const msgs = await fetchConversationMessages(install, c.id, windowStart, windowEnd);
      all.push(...msgs);
    }
    // NON_CONVERSATION_CHANNELS was referenced here but never defined anywhere
    // in the codebase — this function would throw a ReferenceError on its first
    // call. It is exported but has no callers (the export path,
    // fetchContactMessagesViaExport, replaced it), so nothing has hit it.
    //
    // Left unfiltered rather than guessing which channels the filter meant to
    // exclude: readableChannel's MESSAGE_TYPE_NAMES lists a dozen candidates
    // and picking a subset would be inventing behaviour. If this function is
    // ever revived, define the set deliberately.
    return all.sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    logger.error({ err, contactId }, 'messageEnrichment(legacy): fetch failed');
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// NEW: bulk export via /conversations/messages/export (by location)
// https://marketplace.gohighlevel.com/docs/ghl/conversations/export-messages-by-location
//
// Why: the per-conversation paging API requires N round-trips for a contact
// with N conversations. The bulk export accepts a single time window + an
// optional conversationId filter and returns up to 500 messages per page.
//
// Important convoVault lesson preserved: this endpoint SILENTLY DROPS the
// `Email` channel unless you pass `channel=Email` explicitly. So we do two
// passes per conversation — default (everything except email) + email — and
// dedupe by message id at the end.

// Low-level bulk fetch with pagination. Returns the raw GHL message objects.
// Per GHL docs (https://marketplace.gohighlevel.com/docs/ghl/conversations/export-messages-by-location):
//   - `locationId` required on every call
//   - `startDate` / `endDate` are ISO 8601 datetime strings (NOT epoch ms)
//   - `channel` is CASE-SENSITIVE — "Email" with capital E. Must be set
//     explicitly or email messages are excluded entirely (drives our two-pass
//     pattern in fetchContactMessagesViaExport below).
//   - pagination is cursor-based: response carries `nextCursor`; pass it back
//     on the next call as `cursor`. Hard cap is 1000 messages per page.
//   - response shape: { messages: GetMessageResponseDto[], nextCursor, total }
async function fetchMessagesExport(install, options) {
  const limit = Math.min(options.limit || 500, 1000); // API hard cap is 1000

  const params = new URLSearchParams({
    locationId: install.location_id,
    limit: String(limit)
  });
  if (options.conversationId) params.set('conversationId', options.conversationId);
  if (options.channel) params.set('channel', options.channel); // exact casing, e.g. "Email"

  // Accept either a number (epoch ms) or an ISO string and normalize to ISO.
  const toIso = (v) => (typeof v === 'number' ? new Date(v).toISOString() : String(v));
  if (options.startTimestamp != null) params.set('startDate', toIso(options.startTimestamp));
  if (options.endTimestamp != null) params.set('endDate', toIso(options.endTimestamp));

  if (options.sortBy) params.set('sortBy', options.sortBy);          // 'createdAt' | 'updatedAt'
  if (options.sortOrder) params.set('sortOrder', options.sortOrder); // 'asc' | 'desc'

  const all = [];
  let cursor = options.cursor || null;
  // Safety cap. 50 pages × 1000 = 50k messages per (conversation, pass) —
  // way more than any sane stage window. Stops runaway pagination bugs.
  for (let page = 0; page < 50; page++) {
    if (cursor) params.set('cursor', cursor); else params.delete('cursor');

    const url = `/conversations/messages/export?${params.toString()}`;
    const startedAt = Date.now();

    logger.info(
      {
        url,
        page,
        conversationId: options.conversationId,
        channel: options.channel || '(default)',
        startDate: params.get('startDate'),
        endDate: params.get('endDate'),
        limit,
        cursor: cursor || null
      },
      'ghl.export: request'
    );

    const { data, status } = await ghlRequest(install, { method: 'GET', url });

    // What did GHL actually send back? Log the shape so we can spot
    // response-format drift without dumping the full message bodies.
    const batch = Array.isArray(data?.messages) ? data.messages : [];
    logger.info(
      {
        url,
        status,
        page,
        responseTimeMs: Date.now() - startedAt,
        messagesCount: batch.length,
        nextCursor: data?.nextCursor || null,
        total: data?.total ?? null,
        // If the response is unexpectedly empty / weird shape, surface the
        // top-level keys to debug. Otherwise stay silent.
        ...(batch.length === 0 ? { responseKeys: Object.keys(data || {}), responsePreview: JSON.stringify(data).slice(0, 500) } : {})
      },
      'ghl.export: response'
    );

    if (batch.length === 0) break;
    all.push(...batch);

    const nextCursor = data?.nextCursor || null;
    if (!nextCursor || nextCursor === cursor) break; // no more pages / cursor stuck → bail
    cursor = nextCursor;
  }
  return all;
}

// High-level wrapper. Returns every message for a contact within
// [windowStart, windowEnd], normalised + deduped + sorted ascending by time.
//
// Algorithm:
//   1. List the contact's conversations (one round-trip)
//   2. For each conversation, fire TWO bulk export pages:
//        a. default (no channel filter) → SMS, WhatsApp, Call, Webchat, etc.
//        b. channel=Email → emails specifically (workaround for the silent drop)
//   3. Dedupe by message id (a few channels overlap across passes)
//   4. Filter out activity-event noise and out-of-window stragglers
//   5. Normalise to our internal shape + sort
export async function fetchContactMessagesViaExport(install, contactId, windowStart, windowEnd) {
  if (!contactId) return [];
  const startMs = (windowStart instanceof Date ? windowStart : new Date(windowStart)).getTime();
  const endMs = (windowEnd instanceof Date ? windowEnd : new Date(windowEnd)).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    return []; // empty / inverted window → nothing to do
  }

  try {
    const conversations = await listContactConversations(install, contactId);
    if (conversations.length === 0) {
      logger.debug({ contactId }, 'messageEnrichment.export: contact has no conversations');
      return [];
    }

    const startedAt = Date.now();
    const raw = [];
    for (const c of conversations) {
      const conversationId = c.id;
      // Pass A — default (everything except Email, per GHL's case-sensitive
      // "Email" channel filter requirement).
      const passA = await fetchMessagesExport(install, {
        conversationId, startTimestamp: startMs, endTimestamp: endMs
      });
      // Pass B — Email explicitly (capital E, per docs).
      const passB = await fetchMessagesExport(install, {
        conversationId, channel: 'Email', startTimestamp: startMs, endTimestamp: endMs
      });
      raw.push(...passA, ...passB);
    }

    // Dedupe + normalise + filter
    const seen = new Set();
    const normalised = [];
    for (const m of raw) {
      const id = m.id || m.messageId;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const ts = new Date(m.dateAdded || m.timestamp);
      if (Number.isNaN(ts.getTime())) continue;
      if (ts.getTime() < startMs || ts.getTime() > endMs) continue;

      normalised.push({
        messageId: id,
        conversationId: m.conversationId,
        timestamp: ts,
        body: m.body || '',
        direction: m.direction || (m.type === 1 ? 'outbound' : 'inbound'),
        channel: readableChannel(m),
        // GHL message lifecycle: 'queued' → 'sent' → 'delivered' → 'read'
        // (or failure path: 'failed' / 'undelivered'). Field name varies
        // slightly across GHL versions — accept either `status` or
        // `deliveryStatus`. Lower-cased for stable downstream queries.
        status: (m.status || m.deliveryStatus || null)?.toString().toLowerCase() || null,
        isCall: m.type === 1 || m.messageType === 'TYPE_CALL'
      });
    }
    normalised.sort((a, b) => a.timestamp - b.timestamp);

    // Channel breakdown — useful to verify pass A + pass B aren't producing
    // overlapping results. Dedup happens twice (Set on messageId during
    // normalisation, and UNIQUE INDEX (location_id, message_id) on the messages
    // table). If rawMessages > afterDedupeAndFilter by a large margin, that's
    // not a bug — it's the expected overlap; but the channelBreakdown lets us
    // confirm at-a-glance that email msgs actually made it through pass B.
    const channelBreakdown = {};
    for (const m of normalised) {
      const ch = m.channel || 'UNKNOWN';
      channelBreakdown[ch] = (channelBreakdown[ch] || 0) + 1;
    }

    logger.info(
      {
        contactId,
        conversations: conversations.length,
        rawMessages: raw.length,
        afterDedupeAndFilter: normalised.length,
        channelBreakdown,
        windowStart: new Date(startMs).toISOString(),
        windowEnd: new Date(endMs).toISOString(),
        durationMs: Date.now() - startedAt
      },
      'messageEnrichment.export: window fetch complete'
    );
    return normalised;
  } catch (err) {
    logger.error({ err, contactId }, 'messageEnrichment.export: fetch failed');
    return [];
  }
}
