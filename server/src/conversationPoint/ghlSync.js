// ghlSync.js — mirror a stored call into GHL as a Call message, and hand our
// transcript to the GHL-keyed tables the Deal Hub already reads.
//
// GHL contract (Conversations API, Version 2021-04-15):
//   POST /conversations/messages/inbound   or   /outbound
//   { type: 'Call', conversationProviderId, locationId, contactId, userId,
//     altId, date, call: { to, from, status }, attachments: [recordingUrl] }
//   → { conversationId, messageId }
//
// conversationProviderId must be a Call-type provider registered on the
// marketplace app (GHL_CALL_PROVIDER_ID). Without it this step is SKIPPED,
// not failed — the call is still stored, matched and transcribed in our DB,
// which is the part that matters for analytics.
//
// altId = '<provider>:<provider call id>' makes the POST idempotent on GHL's
// side; a retry after a timeout does not create a second message.
//
// After the POST, the transcript is written to call_transcriptions under the
// new message_id. The timeline route joins that table by message_id, so the
// transcript shows on the call row as soon as GHL's own webhook writes the
// messages row (seconds later) — no change to the timeline query.

import { config } from '../config.js';
import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import { signRecordingUrl } from './recordingStore.js';
import { logger } from '../utils/logger.js';

const CALL_STATUS = {
  answered: 'completed', missed: 'no-answer', voicemail: 'voicemail',
  busy: 'busy', failed: 'failed', unknown: 'completed'
};

export async function syncCallToGhl(call, transcript) {
  const providerId = config.conversationPoint.ghlCallProviderId;
  if (!providerId) return { status: 'skipped', reason: 'GHL_CALL_PROVIDER_ID not set' };
  if (!call.contact_id) return { status: 'skipped', reason: 'no contact matched — GHL needs a contactId' };
  if (call.direction !== 'inbound' && call.direction !== 'outbound') {
    return { status: 'skipped', reason: `direction ${call.direction} has no GHL endpoint` };
  }

  const install = await getActiveInstall(call.location_id);
  if (!install) return { status: 'skipped', reason: 'no active GHL install for this location' };

  const body = {
    type: 'Call',
    conversationProviderId: providerId,
    locationId: call.location_id,
    contactId: call.contact_id,
    altId: `${call.provider}:${call.provider_call_id}`,
    date: (call.started_at ? new Date(call.started_at) : new Date()).toISOString(),
    call: {
      to: call.to_e164 || call.to_number || '',
      from: call.from_e164 || call.from_number || '',
      status: CALL_STATUS[call.result] || 'completed'
    }
  };
  if (call.user_id) body.userId = call.user_id;
  if (call.recording_status === 'stored') body.attachments = [signRecordingUrl(call.location_id, call.id)];

  const resp = await ghlRequest(install, {
    method: 'POST',
    url: `/conversations/messages/${call.direction}`,
    data: body,
    headers: { Version: '2021-04-15' },
    scopeOptional: true
  });
  const messageId = resp.data?.messageId || resp.data?.id || null;
  const conversationId = resp.data?.conversationId || null;
  if (!messageId) {
    logger.warn({ callId: call.id, data: resp.data }, 'ghlSync: no messageId in response');
  }

  if (messageId && transcript?.text) {
    await rawQuery(
      `INSERT INTO call_transcriptions
         (location_id, message_id, transcript_text, segments, language, provider,
          duration_seconds, fetched_at, fetch_status, http_status, last_error)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now(), 'ok', 200, NULL)
       ON CONFLICT (location_id, message_id) DO UPDATE SET
         transcript_text  = EXCLUDED.transcript_text,
         segments         = EXCLUDED.segments,
         language         = EXCLUDED.language,
         provider         = EXCLUDED.provider,
         duration_seconds = EXCLUDED.duration_seconds,
         fetched_at       = now(),
         fetch_status     = 'ok',
         last_error       = NULL`,
      [call.location_id, messageId, transcript.text, JSON.stringify(transcript.segments || []),
       transcript.language || null, `conversation_point:${transcript.model || 'whisper'}`,
       transcript.duration_seconds ?? null]
    );
  }

  return { status: 'synced', messageId, conversationId };
}
