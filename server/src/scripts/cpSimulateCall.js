// cpSimulateCall.js — push one fake call through the whole pipeline without
// a phone provider. For checking storage, Whisper, matching and the API
// before Allo access lands.
//
//   npm run cp:simulate -- --location <locationId> --file ./some-call.mp3 \
//       [--from +447700900123] [--to +441onal...] [--direction inbound] [--run]
//
//   --file   a local audio file: stored directly as the recording
//   --url    instead of --file: a public audio URL, fetched by the download step
//   --run    drain the queue right here (otherwise the server's worker does it)
//
// Rows are real: a call with provider 'allo' and provider_call_id
// 'sim-<timestamp>'. Delete it afterwards with
//   DELETE FROM calls WHERE provider_call_id LIKE 'sim-%';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';
import { ingestCall } from '../conversationPoint/ingest.js';
import { storeRecording } from '../conversationPoint/recordingStore.js';
import { updateCall, enqueue } from '../conversationPoint/callStore.js';
import { tick } from '../conversationPoint/worker.js';

function arg(name, dflt = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const locationId = arg('location');
  if (!locationId) throw new Error('--location <locationId> is required');
  const file = arg('file'); const url = arg('url');
  const direction = arg('direction', 'inbound');
  const from = arg('from', '+447700900123'); const to = arg('to', '+442071234567');
  const now = new Date();
  const id = `sim-${now.getTime()}`;

  const call = {
    provider: 'allo', providerCallId: id, direction, result: 'answered',
    fromNumber: from, toNumber: to, fromE164: from, toE164: to,
    customerNumber: direction === 'inbound' ? from : to,
    ourNumber: direction === 'inbound' ? to : from,
    extension: arg('extension'), providerUserId: arg('user'), providerUserEmail: arg('email'), providerUserName: null,
    startedAt: new Date(now.getTime() - 5 * 60000), answeredAt: new Date(now.getTime() - 5 * 60000 + 4000),
    endedAt: now, durationSeconds: 300, talkSeconds: 296,
    recordingUrl: url || null,
    raw: { simulated: true, file: file || null, url: url || null }
  };

  const callId = await ingestCall(locationId, call, { final: true });
  console.log(`call ${callId} ingested (${id})`);

  if (file) {
    const buffer = await fs.readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const contentType = ext === 'wav' ? 'audio/wav' : (ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg');
    const stored = await storeRecording({ locationId, callId, buffer, contentType, sourceUrl: file });
    await updateCall(callId, {
      recording_status: 'stored', recording_storage: stored.storage, recording_key: stored.key,
      recording_bytes: stored.bytes, recording_content_type: stored.contentType
    });
    // Skip download (nothing to fetch) and go straight to transcribe.
    await pool.query(`UPDATE call_jobs SET status = 'skipped', finished_at = now() WHERE call_id = $1 AND step = 'download'`, [callId]);
    await enqueue(callId, locationId, 'transcribe', { force: true });
    console.log(`recording stored at ${stored.storage}:${stored.key} (${stored.bytes} bytes)`);
  }

  if (flag('run')) {
    let total = 0; let n;
    do { n = await tick(10); total += n; } while (n > 0);
    const { rows } = await pool.query(
      `SELECT c.match_status, c.contact_id, c.user_id, c.opportunity_id, c.recording_status, c.transcript_status, c.ghl_sync_status,
              t.speaker_method, t.model, t.silence_stats, left(t.text, 300) AS text, t.error
         FROM calls c LEFT JOIN call_transcripts t ON t.call_id = c.id WHERE c.id = $1`, [callId]);
    console.log(`ran ${total} steps`);
    console.log(JSON.stringify(rows[0], null, 2));
    const jobs = await pool.query(`SELECT step, status, attempts, last_error FROM call_jobs WHERE call_id = $1 ORDER BY id`, [callId]);
    console.table(jobs.rows);
  } else {
    console.log('queued — the server worker will pick it up (or re-run with --run).');
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
