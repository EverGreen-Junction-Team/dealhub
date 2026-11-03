// messagesSync.js — Layer 3 of the 3-layer message capture strategy.
//
// Reconciliation sweep. Catches messages that Layer 1 (webhooks) dropped
// and Layer 2 (stage-transition fetch) didn't reach (contacts with no opp,
// closed deals, opps that haven't moved stages recently).
//
// Cursor-based per-location sweep:
//   1. Get sweep_cursors.success_through for (location, 'messages')
//   2. Compute window: [success_through - 5min, now] (or [now-30d, now] on
//      first run)
//   3. Outer loop: GET /conversations/search?lastMessageAfter=<window_start>
//      Paginate until empty.
//   4. Inner loop for each conversation: GET /conversations/{id}/messages,
//      paginate backwards until we hit messages older than window_start.
//      UPSERT via messageWriter's sink (dedup on (location_id, message_id))
//   5. On success only: advance success_through = window_end.
//   6. Log to sync_runs with window_start / window_end / counts.
//
// Runs from the same daily cron as tagsSync/customFieldsSync/pipelinesSync.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { upsertMessage, normaliseChannel } from './messageWriter.js';
import { MESSAGE_TYPE_NAMES } from './messageEnrichment.js';
import { getCursor, computeWindow, advanceCursor } from './sweepCursors.js';
import { recordSyncRun } from './syncRunLog.js';
import { logger } from '../utils/logger.js';
import { deriveSenderType } from './messageSource.js';

const OBJECT_TYPE = 'messages';
const CONVERSATION_PAGE_SIZE = 100;
const MESSAGE_PAGE_SIZE = 100;
// Safety caps — real-world locations should never hit these under normal
// daily-sweep windows.
const MAX_CONVERSATION_PAGES = 200;    // = 20 000 conversations per run
const MAX_MESSAGE_PAGES = 100;         // = 10 000 messages per conversation

// Map a GHL /conversations/{id}/messages row into the shape upsertMessage()
// expects (matches the webhook envelope shape as closely as possible).
function mapRestMessageToWriterShape(m, conversationId, contactId) {
  return {
    messageId: m.id,
    conversationId: m.conversationId || conversationId,
    contactId: m.contactId || contactId,
    threadId: m.threadId || m.meta?.email?.threadId || null,
    subject: m.subject || m.meta?.email?.subject || null,
    replyToMessageId: m.replyToMessageId || null,
    body: m.body || null,
    direction: m.direction || null,
    // Canonical channel, the same way the webhook path writes it. A REST row
    // sometimes carries only the numeric `type` (50 for a form submission,
    // 28 for an opportunity activity) — that used to be stored literally as
    // channel "50". The number is mapped to GHL's TYPE_ name first.
    channel: normaliseChannel(
      m.messageType
        || (typeof m.type === 'number' && MESSAGE_TYPE_NAMES[m.type] ? `TYPE_${MESSAGE_TYPE_NAMES[m.type]}` : null)
        || (m.type != null ? String(m.type) : null)
    ),
    status: m.status || null,
    isCall: (m.messageType || '').toString().toUpperCase() === 'CALL' ||
            (m.messageType || '').toString().toUpperCase() === 'VOICEMAIL',
    senderUserId: m.userId || null,
    senderType: deriveSenderType(
      {
        workflowId: m.workflowId || null,
        campaignId: m.campaignId || null,
        bulkReqId: m.bulkReqId || null,
        isAutoReply: m.isAutoReply === true,
        isAiAutoReply: m.isAiAutoReply || null,
        source: m.source || null,
        userId: m.userId || null,
        conversationProviderId: m.conversationProviderId || null
      },
      m.direction || null
    ),
    callDurationSeconds: typeof m.meta?.call?.duration === 'number' ? m.meta.call.duration : null,
    dateAddedGhl: m.dateAdded ? new Date(m.dateAdded) : null,
    ingestEventId: null,   // sweep isn't triggered by a webhook, so no envelope id
    raw: m
  };
}

// Pull every message in ONE contact's conversations since `since`, through
// the same mapper and writer the nightly sweep uses. For the case the sweep
// is paused and a message is known to be missing — a form submission that
// never comes by webhook, say — without re-walking the whole location.
export async function syncMessagesForContact(install, contactId, { since } = {}) {
  const locationId = install.location_id;
  const windowStart = since instanceof Date ? since : new Date(Date.now() - 30 * 86400000);
  let conversationsScanned = 0;
  let messagesUpserted = 0;

  const params = new URLSearchParams({ locationId, contactId, limit: '100' });
  const { data } = await ghlRequest(install, {
    method: 'GET', url: `/conversations/search?${params.toString()}`
  });
  const conversations = Array.isArray(data?.conversations) ? data.conversations : [];

  for (const conv of conversations) {
    const conversationId = conv.id;
    if (!conversationId) continue;
    conversationsScanned++;
    let lastMessageId = null;
    for (let msgPage = 0; msgPage < MAX_MESSAGE_PAGES; msgPage++) {
      const mParams = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
      if (lastMessageId) mParams.set('lastMessageId', lastMessageId);
      const resp = await ghlRequest(install, {
        method: 'GET',
        url: `/conversations/${encodeURIComponent(conversationId)}/messages?${mParams.toString()}`
      });
      const msgData = resp.data;
      const messages = Array.isArray(msgData?.messages?.messages) ? msgData.messages.messages
                     : Array.isArray(msgData?.messages) ? msgData.messages
                     : [];
      if (messages.length === 0) break;

      let hitCursor = false;
      for (const m of messages) {
        const ts = m.dateAdded ? new Date(m.dateAdded) : null;
        if (ts && ts < windowStart) { hitCursor = true; continue; }
        const shaped = mapRestMessageToWriterShape(m, conversationId, conv.contactId || contactId);
        try {
          const dbId = await upsertMessage(locationId, shaped, { fromBackfill: true });
          if (dbId) messagesUpserted++;
        } catch (err) {
          logger.warn({ locationId, contactId, messageId: m.id, err },
            'messagesSync(contact): message upsert failed — skipped');
        }
      }
      if (hitCursor || messages.length < MESSAGE_PAGE_SIZE) break;
      lastMessageId = messages[messages.length - 1]?.id || null;
      if (!lastMessageId) break;
    }
  }

  logger.info({ locationId, contactId, conversationsScanned, messagesUpserted, since: windowStart },
    'messagesSync(contact): done');
  return { conversationsScanned, messagesUpserted };
}

// Sweep one location. Returns { conversationsScanned, messagesUpserted, error }.
export async function syncMessagesForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();

  const cursor = await getCursor(locationId, OBJECT_TYPE);
  const { windowStart, windowEnd } = computeWindow(cursor, startedAt);

  // Log run entry FIRST so run_uuid is available for stamping messages.
  const runUuid = await recordSyncRun({
    jobName: 'messagesSync', objectType: OBJECT_TYPE,
    locationId, scope: 'location', status: 'success',    // provisional — updated on failure
    startedAt, finishedAt: startedAt,                    // provisional
    windowStart, windowEnd,
    stats: { phase: 'started' }
  });

  let conversationsScanned = 0;
  let messagesUpserted = 0;

  try {
    // ── Outer loop: conversations touched since windowStart ─────────────
    // GHL's /conversations/search ignores `?page=N` — pagination is via
    // startAfterDate (epoch ms of last conversation's lastMessageDate) plus
    // startAfterId for tie-breaks. Loop until an empty result or safety cap.
    let startAfterDate = null;
    let startAfterId   = null;
    let seenIds = new Set();   // safety — belt against a broken cursor stalling us

    for (let convPage = 0; convPage < MAX_CONVERSATION_PAGES; convPage++) {
      const params = new URLSearchParams({
        locationId,
        limit: String(CONVERSATION_PAGE_SIZE),
        lastMessageAfter: String(windowStart.getTime())
      });
      if (startAfterDate) params.set('startAfterDate', String(startAfterDate));
      if (startAfterId)   params.set('startAfterId',   startAfterId);

      let convData;
      try {
        const resp = await ghlRequest(install, {
          method: 'GET',
          url: `/conversations/search?${params.toString()}`
        });
        convData = resp.data;
      } catch (err) {
        logger.warn(
          { locationId, page: convPage + 1, err, status: err.response?.status },
          'messagesSync: conversations page fetch failed — stopping'
        );
        break;
      }

      const conversations = Array.isArray(convData?.conversations) ? convData.conversations : [];
      if (conversations.length === 0) break;

      // Safety: if the API returns a page whose first ID we've already seen,
      // the cursor didn't advance — bail out instead of looping forever.
      if (seenIds.has(conversations[0].id)) {
        logger.warn(
          { locationId, page: convPage + 1, firstId: conversations[0].id },
          'messagesSync: cursor did not advance — stopping to prevent infinite loop'
        );
        break;
      }

      // ── Inner loop: messages in each conversation ─────────────────────
      for (const conv of conversations) {
        conversationsScanned++;
        const conversationId = conv.id;
        const contactId = conv.contactId || null;
        if (!conversationId) continue;

        let lastMessageId = null;
        for (let msgPage = 0; msgPage < MAX_MESSAGE_PAGES; msgPage++) {
          const mParams = new URLSearchParams({
            limit: String(MESSAGE_PAGE_SIZE)
          });
          if (lastMessageId) mParams.set('lastMessageId', lastMessageId);

          let msgData;
          try {
            const resp = await ghlRequest(install, {
              method: 'GET',
              url: `/conversations/${encodeURIComponent(conversationId)}/messages?${mParams.toString()}`
            });
            msgData = resp.data;
          } catch (err) {
            logger.warn(
              { locationId, conversationId, err },
              'messagesSync: conversation messages fetch failed — skipping convo'
            );
            break;
          }

          const messages = Array.isArray(msgData?.messages?.messages) ? msgData.messages.messages
                         : Array.isArray(msgData?.messages) ? msgData.messages
                         : [];
          if (messages.length === 0) break;

          let hitCursor = false;
          for (const m of messages) {
            const ts = m.dateAdded ? new Date(m.dateAdded) : null;
            if (ts && ts < windowStart) { hitCursor = true; continue; }
            const shaped = mapRestMessageToWriterShape(m, conversationId, contactId);
            try {
              const dbId = await upsertMessage(locationId, shaped, {
                fromBackfill: false,
                syncRunId: runUuid
              });
              if (dbId) messagesUpserted++;
            } catch (err) {
              logger.warn(
                { locationId, messageId: m.id, err },
                'messagesSync: message upsert failed — skipped'
              );
            }
          }

          if (hitCursor || messages.length < MESSAGE_PAGE_SIZE) break;
          lastMessageId = messages[messages.length - 1]?.id || null;
          if (!lastMessageId) break;
        }
      }

      // Track IDs seen this run — cursor-didn't-advance safety guard uses this
      for (const c of conversations) seenIds.add(c.id);

      // Advance the cursor to the LAST conversation's lastMessageDate.
      // GHL orders by lastMessageDate ASC when using lastMessageAfter, so the
      // last row gives us the correct "start after this" position for the
      // next page. Tie-break by ID handles duplicate timestamps.
      const last = conversations[conversations.length - 1];
      const lastDate = last?.lastMessageDate || last?.dateAdded || null;
      startAfterDate = lastDate ? new Date(lastDate).getTime() : null;
      startAfterId   = last?.id || null;

      // Emit progress every page — helps future debugging.
      logger.info(
        { locationId, page: convPage + 1, conversationsScanned, messagesUpserted, startAfterDate, startAfterId },
        'messagesSync: conversation page done'
      );

      if (conversations.length < CONVERSATION_PAGE_SIZE) break;
      if (!startAfterDate) break;  // no cursor to advance — stop
    }

    // Advance cursor only on success — window_end is authoritative for
    // "we've seen everything up to here."
    await advanceCursor(locationId, OBJECT_TYPE, windowEnd);

    logger.info(
      { locationId, conversationsScanned, messagesUpserted, windowStart, windowEnd },
      'messagesSync: location synced'
    );
    // NOTE: the earlier recordSyncRun already wrote the "started" row.
    // We could UPDATE that row instead of writing a second — for now we
    // write a second finalising row and let sync_runs have both.
    await recordSyncRun({
      jobName: 'messagesSync', objectType: OBJECT_TYPE,
      locationId, scope: 'location', status: 'success',
      startedAt, finishedAt: new Date(),
      windowStart, windowEnd,
      stats: { conversationsScanned, messagesUpserted, cursor_advanced_to: windowEnd }
    });
    return { conversationsScanned, messagesUpserted };
  } catch (err) {
    logger.error(
      { locationId, err, stack: err.stack },
      'messagesSync: location failed'
    );
    await recordSyncRun({
      jobName: 'messagesSync', objectType: OBJECT_TYPE,
      locationId, scope: 'location', status: 'failed',
      startedAt, finishedAt: new Date(),
      windowStart, windowEnd,
      stats: { conversationsScanned, messagesUpserted },
      error: err.message
    });
    return { conversationsScanned, messagesUpserted, error: err.message };
  }
}

export async function syncMessagesForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('messagesSync: no active installs — skipping');
    return { locations: 0 };
  }

  let totalConversations = 0;
  let totalMessages = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { conversationsScanned, messagesUpserted, error } = await syncMessagesForLocation(install);
    totalConversations += conversationsScanned || 0;
    totalMessages += messagesUpserted || 0;
    if (error) locationsFailed++;
  }

  logger.info(
    { locations: rows.length, totalConversations, totalMessages, locationsFailed, durationMs: Date.now() - startedAt.getTime() },
    'messagesSync: complete'
  );
  await recordSyncRun({
    jobName: 'messagesSync', objectType: OBJECT_TYPE,
    scope: 'all',
    status: locationsFailed === 0 ? 'success' : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt, finishedAt: new Date(),
    stats: { locations: rows.length, totalConversations, totalMessages, locationsFailed }
  });
  return { locations: rows.length, totalConversations, totalMessages };
}
