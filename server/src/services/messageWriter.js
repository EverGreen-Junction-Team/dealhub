// messageWriter.js — Layer 1 of the 3-layer message capture strategy.
//
//   Layer 1 (THIS FILE)  — InboundMessage / OutboundMessage webhooks →
//                          immediate write with sender, channel, email/call
//                          metadata + best-effort opportunity/stage linkage.
//
//   Layer 2 (existing)   — stageHistoryWriter fetches messages during opp
//                          stage transitions → UPSERT retro-fills opp/stage
//                          linkage on rows Layer 1 left NULL.
//
//   Layer 3 (messagesSync) — daily reconciliation sweep catches any dropped
//                            webhooks via /conversations/search.
//
// All three write via the same UPSERT with UNIQUE(location_id, message_id).
// Order doesn't matter — same message = same row.

import { rawQuery } from '../db.js';
import { cleanMessageBody } from './dataCleaner.js';
import { attributeMessage } from './attributionEngine.js';
import { ensureContactExists } from './contactStub.js';
import { ensureProviderKnown } from './conversationProvidersSync.js';
import { logger } from '../utils/logger.js';
import { fetchEmailAttachments } from './emailAttachments.js';
import { deriveSenderType } from './messageSource.js';

const CLEANING_VERSION = 'v1';

// Extract sender/channel/email/call fields from the webhook envelope.
// Handles both non-email shape (messageId + messageType) and email shape
// (emailMessageId + threadId + subject).
function pickMessageFields(event) {
  const isEmail = !!event.emailMessageId || !!event.threadId ||
                  (event.messageType || '').toLowerCase() === 'email';

  const messageId = event.messageId || event.emailMessageId || event.id;
  const channel = normaliseChannel(event.messageType);

  const direction = event.direction || null;
  const senderType = deriveSenderType(
    {
      workflowId: event.workflowId || null,
      campaignId: event.campaignId || null,
      bulkReqId: event.bulkReqId || null,
      isAutoReply: event.isAutoReply === true,
      isAiAutoReply: event.isAiAutoReply || null,
      source: event.source || null,
      userId: event.userId || null,
      conversationProviderId: event.conversationProviderId || null
    },
    direction
  );

  return {
    messageId,
    conversationId: event.conversationId || null,
    contactId: event.contactId || null,
    threadId: event.threadId || null,
    subject: event.subject || null,
    replyToMessageId: event.replyToMessageId || null,
    body: event.body || null,
    direction,
    channel,
    status: event.status || null,
    // is_call detection — audit v2 found only 3/14 call messages had this
    // set to true because 11 arrived with messageType='TYPE_CALL' which we
    // uppercased to 'TYPE_CALL' and then compared strictly against 'CALL'.
    // Accept both channel spellings plus the messageTypeString variant.
    isCall: (
      channel === 'CALL' || channel === 'VOICEMAIL' ||
      channel === 'TYPE_CALL' ||
      /(^|_)CALL($|_)/.test((event.messageTypeString || '').toUpperCase()) ||
      event.messageTypeString === 'TYPE_CALL'
    ),
    recordingUrl: event.recordingUrl || event.recording_url || null,
    // Sender
    senderUserId: event.userId || null,
    senderType,
    // Which conversation provider (Twilio / Mailgun / SMTP / custom) handled
    // this message. Resolved to a name via conversation_providers.
    conversationProviderId: event.conversationProviderId || null,
    // GHL's granular type. For custom marketplace providers (e.g. Message Hub
    // WhatsApp) messageType comes through as 'Custom', but messageTypeString
    // still tells us the underlying channel: TYPE_CUSTOM_SMS / TYPE_CUSTOM_EMAIL.
    // Used by maybeEnsureProvider to route to the right conversationChannels/*
    // endpoint.
    messageTypeString: event.messageTypeString || null,
    // Call metadata (non-email path)
    callDurationSeconds: typeof event.callDuration === 'number' ? event.callDuration : null,
    callStatus: event.callStatus || null,
    // Timestamp — GHL's dateAdded is authoritative
    dateAddedGhl: event.dateAdded ? new Date(event.dateAdded) : null,
    // Raw payload for future promotion of fields we don't need yet
    raw: event,
    // Webhook envelope ID for the ghl_raw → messages audit trail
    ingestEventId: event.webhookId || event.eventId || null,
    isEmail
  };
}

// GHL sends messageType strings in many shapes: EMAIL / TYPE_EMAIL for the
// same channel, SMS / TYPE_SMS / CUSTOM_SMS / TYPE_CUSTOM_SMS, etc. Collapse
// to a canonical set so downstream filters treat variants as one channel.
// Every non-listed value falls through as its own uppercase label so we
// don't silently swallow new GHL types.
//
// Kept in sync with migration 048's CASE expression — if you add a variant
// here, add it to 048 too (or backfill will disagree with new writes).
export function normaliseChannel(t) {
  if (!t) return null;
  const u = String(t).toUpperCase();
  if (['EMAIL', 'TYPE_EMAIL'].includes(u)) return 'EMAIL';
  if (['SMS', 'TYPE_SMS', 'CUSTOM_SMS', 'TYPE_CUSTOM_SMS'].includes(u)) return 'SMS';
  if (['CALL', 'TYPE_CALL'].includes(u)) return 'CALL';
  if (['VOICEMAIL', 'TYPE_VOICEMAIL'].includes(u)) return 'VOICEMAIL';
  if (['WEBCHAT', 'TYPE_WEBCHAT', 'LIVE_CHAT', 'TYPE_LIVE_CHAT'].includes(u)) return 'WEBCHAT';
  if (['WHATSAPP', 'TYPE_WHATSAPP'].includes(u)) return 'WHATSAPP';
  if (['IMESSAGE', 'TYPE_IMESSAGE'].includes(u)) return 'IMESSAGE';
  if (['FB', 'TYPE_FACEBOOK', 'FACEBOOK', 'TYPE_FB'].includes(u)) return 'FACEBOOK';
  if (['IG', 'TYPE_INSTAGRAM', 'INSTAGRAM', 'TYPE_IG'].includes(u)) return 'INSTAGRAM';
  if (['FORM_SUBMISSION', 'TYPE_FORM_SUBMISSION'].includes(u)) return 'FORM';
  if (u.startsWith('TYPE_ACTIVITY_')) return 'ACTIVITY';
  if (u === 'CUSTOM') return 'CUSTOM';
  // A team-only comment on the conversation — see utils/channels.js.
  // "InternalComment" on the webhook, TYPE_INTERNAL_COMMENT on REST rows.
  if (u.replace(/[^A-Z]/g, '').includes('INTERNALCOMMENT') || u === 'INTERNAL') return 'INTERNAL';
  return u;
}

// Best-effort opportunity + stage linkage. Rule:
//   contact has EXACTLY 1 open opportunity  → link opp + its open stage row
//   contact has 0 or 2+ open opportunities  → leave both NULL
//                                             (Layer 2 stage-transition will
//                                              retro-fill next time)
async function lookupOpportunityLinkage(locationId, contactId) {
  if (!contactId) return { opportunityId: null, stageHistoryId: null };
  const { rows } = await rawQuery(
    `SELECT o.opportunity_id
       FROM opportunities o
      WHERE o.location_id = $1
        AND o.contact_id  = $2
        AND o.status = 'open'
        AND o.is_deleted = false
        AND o.deleted_at IS NULL`,
    [locationId, contactId]
  );
  if (rows.length !== 1) return { opportunityId: null, stageHistoryId: null };

  const opportunityId = rows[0].opportunity_id;
  const { rows: stageRows } = await rawQuery(
    `SELECT id FROM stage_history
      WHERE location_id = $1 AND opportunity_id = $2 AND current_stage = true
      LIMIT 1`,
    [locationId, opportunityId]
  );
  return { opportunityId, stageHistoryId: stageRows[0]?.id || null };
}

// UPSERT sink. Called by webhook handlers, backfill, and messagesSync.
// Dedup key: (location_id, message_id) — enforced by the existing unique
// index on messages. Body / raw / message_channel are IMMUTABLE — never
// overwritten once first written. Delivery status, sender name, sync
// timestamps DO get refreshed.
export async function upsertMessage(locationId, f, {
  fromBackfill = false,
  syncRunId = null
} = {}) {
  if (!f.messageId) {
    logger.warn({ locationId }, 'messageWriter: missing message_id — dropping');
    return null;
  }
  if (!f.contactId) {
    logger.warn({ locationId, messageId: f.messageId }, 'messageWriter: missing contact_id — dropping');
    return null;
  }

  const cleaned = cleanMessageBody(f.body, f.channel);
  const messageTimestamp = f.dateAddedGhl || new Date();

  // FK safety: ensure the parent contact row exists before writing the
  // message. contactsSync (daily cron) will enrich the stub with all the
  // promoted fields on the next run.
  await ensureContactExists(locationId, f.contactId);

  // Best-effort opp/stage linkage. NULL on 0 or 2+ open opps.
  const { opportunityId, stageHistoryId } = await lookupOpportunityLinkage(locationId, f.contactId);

  const { rows } = await rawQuery(
    `INSERT INTO messages (
       location_id, contact_id, opportunity_id, stage_history_id,
       message_id, conversation_id, thread_id, subject, reply_to_message_id,
       message_timestamp,
       message_body, message_body_raw, cleaning_version,
       message_direction, message_channel, message_status,
       sender_user_id, sender_type,
       is_call, call_duration_seconds,
       ingest_event_id, sync_run_id, last_synced_at,
       from_backfill, raw_message,
       conversation_provider_id, recording_url
     ) VALUES (
       $1,$2,$3,$4,
       $5,$6,$7,$8,$9,
       $10,
       $11,$12,$13,
       $14,$15,$16,
       $17,$18,
       $19,$20,
       $21,$22, now(),
       $23,$24,
       $25,$26
     )
     ON CONFLICT (location_id, message_id) WHERE message_id IS NOT NULL DO UPDATE SET
       -- Retroactive linkage. Only fill NULL slots — never overwrite an
       -- existing opp/stage that Layer 2 already set.
       opportunity_id   = COALESCE(messages.opportunity_id, EXCLUDED.opportunity_id),
       stage_history_id = COALESCE(messages.stage_history_id, EXCLUDED.stage_history_id),
       -- Delivery/sender info can change (status transitions delivered→read,
       -- outbound sender name gets resolved).
       message_status   = COALESCE(EXCLUDED.message_status, messages.message_status),
       sender_user_id   = COALESCE(EXCLUDED.sender_user_id, messages.sender_user_id),
       sender_type      = COALESCE(EXCLUDED.sender_type,    messages.sender_type),
       -- Email chain fields fill in when the reconciliation sweep sees them
       thread_id        = COALESCE(messages.thread_id, EXCLUDED.thread_id),
       subject          = COALESCE(messages.subject,   EXCLUDED.subject),
       reply_to_message_id = COALESCE(messages.reply_to_message_id, EXCLUDED.reply_to_message_id),
       -- Call metadata may arrive later (recording after call completes)
       call_duration_seconds = COALESCE(messages.call_duration_seconds, EXCLUDED.call_duration_seconds),
       -- Sync bookkeeping
       last_synced_at   = now(),
       sync_run_id      = COALESCE(EXCLUDED.sync_run_id, messages.sync_run_id),
       raw_message      = COALESCE(messages.raw_message, EXCLUDED.raw_message),
       -- Fill provider id if we didn't have it before, but don't clobber
       -- one we already resolved (older webhook shapes sometimes omit it).
       conversation_provider_id = COALESCE(messages.conversation_provider_id, EXCLUDED.conversation_provider_id),
       -- Same for recording_url — fill NULL only.
       recording_url = COALESCE(messages.recording_url, EXCLUDED.recording_url)
     RETURNING id`,
    [
      locationId, f.contactId, opportunityId, stageHistoryId,
      f.messageId, f.conversationId, f.threadId, f.subject, f.replyToMessageId,
      messageTimestamp,
      cleaned, f.body, CLEANING_VERSION,
      f.direction, f.channel, f.status,
      f.senderUserId, f.senderType,
      f.isCall, f.callDurationSeconds,
      f.ingestEventId, syncRunId,
      fromBackfill, f.raw,
      f.conversationProviderId, f.recordingUrl
    ]
  );

  // Stage 2 attribution — runs on every write. Best-effort; never blocks
  // the message row from being stored. Writes to message_opportunity_map
  // and materialises opportunity_id/stage_history_id on the message row
  // when a mapping decision is 'mapped'.
  //
  // Detect source of write: fromBackfill → 'backfill', syncRunId → 'sync',
  // else assume live webhook.
  const detectedVia = fromBackfill ? 'backfill' : (syncRunId ? 'sync' : 'live');
  attributeMessage({
    locationId,
    messageId: f.messageId,
    contactId: f.contactId,
    messageTimestamp,
    detectedVia
  }).catch((err) => {
    logger.warn({ err, locationId, messageId: f.messageId }, 'attributionEngine: dispatch failed (non-fatal)');
  });

  return rows[0]?.id || null;
}

// Look up sender_name via users table when we have a sender_user_id.
// Best-effort — runs OUTSIDE the UPSERT so a users-table miss doesn't
// block message write.
async function resolveSenderName(locationId, messageDbId, userId) {
  if (!messageDbId || !userId) return;
  try {
    const { rows } = await rawQuery(
      `SELECT name FROM users WHERE location_id = $1 AND user_id = $2 LIMIT 1`,
      [locationId, userId]
    );
    const name = rows[0]?.name;
    if (name) {
      await rawQuery(
        `UPDATE messages SET sender_name = $2 WHERE id = $1 AND sender_name IS NULL`,
        [messageDbId, name]
      );
    }
  } catch (err) {
    logger.warn({ err, locationId, userId }, 'messageWriter: sender name resolve failed (non-fatal)');
  }
}

// Public entry points

// Resolve the message's conversation provider id → name row in
// conversation_providers if we don't already have it. Fire-and-forget so
// webhook response time is untouched. Channel-type derivation must map onto
// the GHL endpoint's enum (SMS or Email).
//
// Custom marketplace providers (e.g. Message Hub WhatsApp, Postmark) send
// messageType='Custom' with messageTypeString='TYPE_CUSTOM_SMS' /
// 'TYPE_CUSTOM_EMAIL'. Route on messageTypeString first, then fall back to
// the normalised channel. Other channels (CALL, FB, IG, WA) have no
// conversation-channels endpoint so we skip.
function deriveApiChannel(f) {
  const ts = (f.messageTypeString || '').toUpperCase();
  if (ts.includes('SMS'))   return 'SMS';
  if (ts.includes('EMAIL')) return 'Email';
  if (f.channel === 'SMS')  return 'SMS';
  if (f.isEmail || f.channel === 'EMAIL') return 'Email';
  return null;
}

function maybeEnsureProvider(install, f) {
  if (!f.conversationProviderId) return;
  const apiChannel = deriveApiChannel(f);
  if (!apiChannel) return;
  ensureProviderKnown(install, f.conversationProviderId, apiChannel).catch((err) => {
    logger.warn({ err, locationId: install.location_id, providerId: f.conversationProviderId }, 'ensureProviderKnown: dispatch failed (non-fatal)');
  });
}

// Email attachments, fetched and merged into the stored payload.
//
// WHY THIS IS A SEPARATE STEP AND NOT PART OF pickMessageFields. The webhook
// payload does not contain the attachment list at all — an outbound email
// webhook always sends `attachments: null`, because GHL stores email uploads
// on a `files` field and only its GET path remaps files → attachments. So the
// data has to come from a second API call; there is nothing in `event` to pick.
//
// Same shape as noteWriter, which calls GET /contacts/:cid/notes/:id for the
// identical reason.
//
// AWAITED, not fire-and-forget. The attachments have to be in `raw` before
// upsertMessage writes it, and raw_message is written with
// COALESCE(messages.raw_message, EXCLUDED.raw_message) — it is never
// overwritten once set, so a later backfill of the same row would be ignored.
// One extra GHL call per email, at ingest only.
//
// Failure is not fatal: fetchEmailAttachments returns [] rather than throwing,
// because GHL does not redeliver after our 200 and a thrown error here would
// lose the message permanently.
async function attachEmailFiles(install, f, event) {
  // emailMessageId comes straight off the webhook rather than from f.
  //
  // f.messageId is the result of `messageId || emailMessageId || id`, which
  // for email lands on the email id anyway — but relying on that would break
  // silently the day GHL starts sending a real messageId, because the value
  // would then be a MESSAGE id and the email endpoint would reject it.
  // Reading the field we actually mean keeps that honest.
  const emailMessageId = event?.emailMessageId || null;
  if (!f.isEmail || !emailMessageId) return f;

  const attachments = await fetchEmailAttachments(install, emailMessageId, {
    locationId: install.location_id
  });
  if (attachments.length === 0) return f;

  // Merged into `raw` so routes read it exactly where they read note and SMS
  // attachments — extractAttachments(raw_message) already looks at
  // `attachments`. No migration, and the AI/analyst layer sees them too.
  return { ...f, raw: { ...(f.raw || {}), attachments } };
}

export async function handleInboundMessage(install, event) {
  const locationId = install.location_id;
  const f = await attachEmailFiles(install, pickMessageFields(event), event);
  const dbId = await upsertMessage(locationId, f);
  maybeEnsureProvider(install, f);
  logger.info(
    { locationId, messageId: f.messageId, channel: f.channel, contactId: f.contactId, providerId: f.conversationProviderId },
    'messageWriter: inbound message stored'
  );
  return dbId;
}

export async function handleOutboundMessage(install, event) {
  const locationId = install.location_id;
  const f = await attachEmailFiles(install, pickMessageFields(event), event);
  const dbId = await upsertMessage(locationId, f);
  maybeEnsureProvider(install, f);
  if (dbId && f.senderUserId) {
    // Fire-and-forget — don't block webhook response on user lookup.
    resolveSenderName(locationId, dbId, f.senderUserId).catch(() => {});
  }
  logger.info(
    { locationId, messageId: f.messageId, channel: f.channel, contactId: f.contactId, userId: f.senderUserId, providerId: f.conversationProviderId },
    'messageWriter: outbound message stored'
  );
  return dbId;
}
