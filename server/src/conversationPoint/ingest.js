// ingest.js — a provider event becomes a stored call and queued work.
//
//   webhook route → recordEvent (verbatim) → parseEvent → upsertCall →
//   enqueue('match') [+ 'download' when the call is complete]
//
// The route answers 200 as soon as the event is stored. Everything slow
// (contact lookup, audio download, Whisper) happens in the worker, so a
// provider's delivery timeout never sees our processing time — and a crash
// mid-way loses nothing, because the event row is already on disk.

import { getProvider } from './providers/index.js';
import { getProviderConfig } from './providerConfig.js';
import { recordEvent, markEvent, upsertCall, enqueue } from './callStore.js';
import { logger } from '../utils/logger.js';

/**
 * Handle one verified-or-flagged webhook payload.
 * Returns { eventId, duplicate, callId, kind }.
 */
export async function ingestWebhook({ provider: providerName, locationId, payload, headers, signatureOk }) {
  const provider = getProvider(providerName);
  const cfg = await getProviderConfig(locationId, providerName);
  const parsed = provider.parseEvent(payload, headers, { defaultCountry: cfg.settings.defaultCountry });

  const { id: eventId, duplicate } = await recordEvent({
    provider: providerName, locationId,
    providerEventId: parsed.providerEventId, topic: parsed.topic,
    providerCallId: parsed.providerCallId, payload, headers, signatureOk
  });
  if (duplicate) return { eventId: null, duplicate: true, callId: null, kind: parsed.kind };

  if (parsed.kind === 'ignore' || !parsed.call) {
    await markEvent(eventId, 'ignored');
    return { eventId, duplicate: false, callId: null, kind: parsed.kind };
  }

  try {
    const callId = await ingestCall(locationId, parsed.call, { final: parsed.kind === 'call_completed' });
    await markEvent(eventId, 'processed');
    return { eventId, duplicate: false, callId, kind: parsed.kind };
  } catch (err) {
    await markEvent(eventId, 'failed', err.message);
    throw err;
  }
}

/**
 * Store a normalised call and queue its pipeline. Used by the webhook path
 * and by backfill scripts alike. `final` = the call has ended and the
 * recording (if any) is available → download + transcribe are queued.
 */
export async function ingestCall(locationId, call, { final = false } = {}) {
  const row = await upsertCall(locationId, call, { final });
  await enqueue(row.id, locationId, 'match', { force: true });
  if (final) {
    await enqueue(row.id, locationId, 'download', { force: row.recording_status === 'pending' });
  }
  logger.info(
    { locationId, callId: row.id, provider: call.provider, providerCallId: call.providerCallId,
      direction: row.direction, result: row.result, final, inserted: row.inserted },
    'conversationPoint: call ingested'
  );
  return row.id;
}
