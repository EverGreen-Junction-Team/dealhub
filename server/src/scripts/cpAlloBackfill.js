// cpAlloBackfill.js — pull historical calls from Allo's API into calls.
//
//   npm run cp:allo:backfill -- --location <locationId> [--since 2026-10-01] [--until 2026-10-28] [--dry]
//
// Every call found is ingested as FINAL (match + download + transcribe
// queued), so a large backfill means a large Whisper bill: ~$0.006 per
// minute of audio. --dry prints what would be ingested and writes nothing.
//
// Allo's conversations response shape is not fully documented. This walks
// the list, finds anything that looks like a call (has an id and a
// from/to or type), and runs it through the same normaliser the webhook
// uses. Adjust `extractCalls` once a real response has been seen.

import { pool } from '../db.js';
import { getProvider } from '../conversationPoint/providers/index.js';
import { getProviderConfig } from '../conversationPoint/providerConfig.js';
import { ingestCall } from '../conversationPoint/ingest.js';

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(`--${name}`); }

function looksLikeCall(o) {
  if (!o || typeof o !== 'object') return false;
  const kind = String(o.kind || o.item_type || o.channel || o.type || '').toUpperCase();
  if (/SMS|MESSAGE|NOTE|EMAIL/.test(kind) && !/CALL/.test(kind)) return false;
  return !!(o.id || o.call_id) && !!(o.from_number || o.from || o.to || o.to_number || /CALL|INBOUND|OUTBOUND/.test(kind));
}

function extractCalls(payload, out = []) {
  if (Array.isArray(payload)) { for (const p of payload) extractCalls(p, out); return out; }
  if (!payload || typeof payload !== 'object') return out;
  if (looksLikeCall(payload)) { out.push(payload); return out; }
  for (const k of ['items', 'calls', 'data', 'results', 'conversations', 'messages']) {
    if (Array.isArray(payload[k])) extractCalls(payload[k], out);
  }
  return out;
}

async function main() {
  const locationId = arg('location');
  if (!locationId) throw new Error('--location <locationId> is required');
  const since = arg('since'); const until = arg('until'); const dry = flag('dry');
  const provider = getProvider('allo');
  const cfg = await getProviderConfig(locationId, 'allo');
  const api = provider.api(cfg);

  const query = {};
  if (since) { query.since = since; query.from = since; query.start_date = since; }
  if (until) { query.until = until; query.to = until; query.end_date = until; }
  const raw = await api.listConversations(query);
  const items = extractCalls(raw);
  console.log(`Allo returned ${Array.isArray(raw) ? raw.length : 1} records → ${items.length} look like calls`);

  const sinceMs = since ? Date.parse(since) : null; const untilMs = until ? Date.parse(until) + 86400000 : null;
  let n = 0; let skipped = 0;
  for (const item of items) {
    const call = provider.normaliseCall(item, { defaultCountry: cfg.settings.defaultCountry });
    if (!call) { skipped++; continue; }
    const t = call.startedAt ? call.startedAt.getTime() : null;
    if (t && ((sinceMs && t < sinceMs) || (untilMs && t > untilMs))) { skipped++; continue; }
    if (dry) {
      console.log(`${call.providerCallId}  ${call.direction}/${call.result}  ${call.fromE164 || call.fromNumber} → ${call.toE164 || call.toNumber}  ${call.startedAt?.toISOString() || ''}  rec=${call.recordingUrl ? 'yes' : 'no'}`);
    } else {
      await ingestCall(locationId, call, { final: true });
    }
    n++;
  }
  console.log(`${dry ? 'Would ingest' : 'Ingested'} ${n} calls, skipped ${skipped}.`);
}

main()
  .catch((err) => { console.error(err.message, err.body || ''); process.exitCode = 1; })
  .finally(() => pool.end());
