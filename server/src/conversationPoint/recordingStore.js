// recordingStore.js — our own copy of every recording.
//
// The provider's recording URL is not ours: it may be signed, may expire,
// and the provider may delete it after N days. The download step fetches the
// audio once and keeps it here. Two backends:
//
//   local     RECORDINGS_DIR/<locationId>/<callId>.<ext> on this box
//   supabase  Supabase Storage, private bucket, served through our proxy
//
// Both are read through the same signed-link media route (routes/media.js
// → /api/media/recording), so the dashboard never learns where the bytes
// live. Signing mirrors attachmentProxy: HMAC over (location, call, expiry).

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const execFileP = promisify(execFile);
const cp = () => config.conversationPoint;

const EXT_BY_TYPE = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/flac': 'flac'
};

export function extensionFor(contentType, url = '') {
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_TYPE[t]) return EXT_BY_TYPE[t];
  const m = /\.(mp3|wav|ogg|opus|webm|m4a|aac|flac)(\?|$)/i.exec(String(url));
  return m ? m[1].toLowerCase() : 'mp3';
}

function recordingsRoot() {
  return path.resolve(process.cwd(), cp().recordingsDir);
}

// ─── write ───────────────────────────────────────────────────────────────

export async function storeRecording({ locationId, callId, buffer, contentType, sourceUrl }) {
  const ext = extensionFor(contentType, sourceUrl);
  const key = `${locationId}/${callId}.${ext}`;
  const backend = cp().storage === 'supabase' ? 'supabase' : 'local';

  if (backend === 'supabase') {
    const { url, serviceKey, bucket } = cp().supabase;
    if (!url || !serviceKey) throw Object.assign(new Error('RECORDING_STORAGE=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set'), { permanent: true });
    const resp = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/${bucket}/${key}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: buffer
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Supabase Storage upload → HTTP ${resp.status} ${text.slice(0, 200)}`);
    }
  } else {
    const full = path.join(recordingsRoot(), key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
  }

  return { storage: backend, key, bytes: buffer.length, contentType: contentType || null };
}

// ─── read ────────────────────────────────────────────────────────────────

/**
 * A local file path for the recording — the transcriber and ffmpeg need a
 * file. For local storage that is the file itself; for Supabase it is a
 * download into a temp dir the caller removes with `cleanup()`.
 */
export async function materialise(call) {
  if (!call.recording_key) throw new Error('call has no stored recording');
  if (call.recording_storage === 'supabase') {
    const { url, serviceKey, bucket } = cp().supabase;
    const resp = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/${bucket}/${call.recording_key}`, {
      headers: { Authorization: `Bearer ${serviceKey}` }
    });
    if (!resp.ok) throw new Error(`Supabase Storage download → HTTP ${resp.status}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-rec-'));
    const file = path.join(dir, path.basename(call.recording_key));
    await fs.writeFile(file, Buffer.from(await resp.arrayBuffer()));
    return { path: file, cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) };
  }
  const file = path.join(recordingsRoot(), call.recording_key);
  await fs.access(file);
  return { path: file, cleanup: async () => {} };
}

/** Stream for the media route. Returns { stream, contentType, bytes } or null. */
export async function openRecordingStream(call) {
  if (!call.recording_key) return null;
  if (call.recording_storage === 'supabase') {
    const { url, serviceKey, bucket } = cp().supabase;
    const resp = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/${bucket}/${call.recording_key}`, {
      headers: { Authorization: `Bearer ${serviceKey}` }
    });
    if (!resp.ok) return null;
    return {
      stream: resp.body,
      web: true,
      contentType: resp.headers.get('content-type') || call.recording_content_type || 'audio/mpeg',
      bytes: Number(resp.headers.get('content-length')) || call.recording_bytes || null
    };
  }
  const file = path.join(recordingsRoot(), call.recording_key);
  try { await fs.access(file); } catch { return null; }
  return {
    stream: createReadStream(file),
    web: false,
    contentType: call.recording_content_type || 'audio/mpeg',
    bytes: call.recording_bytes || null
  };
}

// ─── probe / ffmpeg ──────────────────────────────────────────────────────

export async function hasFfmpeg() {
  try { await execFileP('ffmpeg', ['-version']); return true; } catch { return false; }
}

/** { channels, durationSeconds, codec } via ffprobe; nulls if unavailable. */
export async function probe(file) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels,codec_name:format=duration',
      '-of', 'json', file
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    const dur = Number(j.format?.duration);
    return {
      channels: Number(s.channels) || null,
      codec: s.codec_name || null,
      durationSeconds: Number.isFinite(dur) ? dur : null
    };
  } catch (err) {
    logger.debug({ err: err.message }, 'recordingStore: ffprobe unavailable or failed');
    return { channels: null, codec: null, durationSeconds: null };
  }
}

// ─── signed links ────────────────────────────────────────────────────────

const TTL_SECONDS = 60 * 60 * 24;
const secret = () => config.session?.jwtSecret || config.ghl?.clientSecret || '';
const sign = (loc, callId, exp) =>
  crypto.createHmac('sha256', secret()).update(`recording\n${loc}\n${callId}\n${exp}`).digest('base64url');

export function signRecordingUrl(locationId, callId, { download = false } = {}) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const q = new URLSearchParams({ loc: locationId, call: callId, exp: String(exp), sig: sign(locationId, callId, exp) });
  if (download) q.set('dl', '1');
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/media/recording?${q.toString()}`;
}

export function verifyRecordingQuery(q) {
  const { loc, call, exp, sig } = q || {};
  if (!loc || !call || !exp || !sig) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const expected = sign(String(loc), String(call), String(exp));
  const a = Buffer.from(String(sig)); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { locationId: String(loc), callId: String(call) };
}
