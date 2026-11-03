// transcriber.js — our transcript of a call, the same way for every provider.
//
// Model: OpenAI audio transcription (whisper-1 by default), verbose_json so
// each segment carries start / end seconds. That is what makes gaps and
// silences measurable — it comes for free, it is not a phase-2 item.
//
// Speaker labels are the hard part, and there are two routes:
//
//   dual_channel  the recording is stereo with one party per channel. We
//                 split it, transcribe each side, and merge by time. Exact
//                 labels at no extra cost. Whether a provider records this
//                 way is the first thing to check with each new connector.
//   none          mono recording → one pass, no speaker on the segments.
//                 A diarizing model can be dropped in via TRANSCRIBE_MODEL
//                 later; the segment shape already has the `speaker` slot.
//
// Audio prep (ffmpeg): everything is transcoded to mono 16 kHz 32 kbps MP3
// first. That takes a 60-minute WAV from ~600 MB to ~14 MB, under the 25 MB
// upload cap, and costs nothing in accuracy for speech. Anything still over
// the cap is cut into 15-minute pieces and the timestamps re-offset.
//
// Without ffmpeg on the box: the original file is sent as-is if it fits,
// otherwise the step fails with a message that says to install ffmpeg.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { probe, hasFfmpeg } from './recordingStore.js';

const execFileP = promisify(execFile);
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const UPLOAD_CAP = 24 * 1024 * 1024;   // stay under OpenAI's 25 MB
const CHUNK_SECONDS = 900;

// ─── OpenAI call ─────────────────────────────────────────────────────────

async function transcribeFile(file, { apiKey, model, language, prompt }) {
  const buf = await fs.readFile(file);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok) {
    const err = new Error(`OpenAI transcription → HTTP ${resp.status}: ${json?.error?.message || text.slice(0, 200)}`);
    err.status = resp.status;
    // Bad key / bad request will not fix themselves on retry.
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) err.permanent = true;
    throw err;
  }
  const segments = Array.isArray(json?.segments)
    ? json.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })).filter((s) => s.text)
    : [{ start: 0, end: Number(json?.duration) || 0, text: String(json?.text || '').trim() }];
  return {
    text: String(json?.text || segments.map((s) => s.text).join(' ')).trim(),
    segments,
    language: json?.language || language || null,
    duration: Number(json?.duration) || null
  };
}

// ─── ffmpeg helpers ──────────────────────────────────────────────────────

async function toMonoMp3(input, output, extraArgs = []) {
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-i', input, ...extraArgs, '-ac', '1', '-ar', '16000', '-b:a', '32k', output]);
  return output;
}

async function splitStereo(input, dir) {
  const left = path.join(dir, 'left.mp3'); const right = path.join(dir, 'right.mp3');
  await execFileP('ffmpeg', [
    '-y', '-v', 'error', '-i', input,
    '-filter_complex', '[0:a]channelsplit=channel_layout=stereo[L][R]',
    '-map', '[L]', '-ac', '1', '-ar', '16000', '-b:a', '32k', left,
    '-map', '[R]', '-ac', '1', '-ar', '16000', '-b:a', '32k', right
  ]);
  return { left, right };
}

async function chunk(input, dir) {
  const pattern = path.join(dir, 'chunk_%03d.mp3');
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-i', input, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c', 'copy', pattern]);
  const files = (await fs.readdir(dir)).filter((f) => f.startsWith('chunk_')).sort().map((f) => path.join(dir, f));
  return files;
}

async function fileSize(f) { return (await fs.stat(f)).size; }

/** Transcribe one mono file, chunking if it is still too big. Offsets kept. */
async function transcribeMono(file, opts) {
  if ((await fileSize(file)) <= UPLOAD_CAP) return transcribeFile(file, opts);
  if (!opts.ffmpeg) throw Object.assign(new Error('recording is over 24 MB and ffmpeg is not installed, cannot chunk it'), { permanent: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-chunks-'));
  try {
    const parts = await chunk(file, dir);
    let offset = 0; const segments = []; const texts = []; let language = null;
    for (const p of parts) {
      const r = await transcribeFile(p, opts);
      for (const s of r.segments) segments.push({ ...s, start: s.start + offset, end: s.end + offset });
      texts.push(r.text);
      language = language || r.language;
      const d = (await probe(p)).durationSeconds;
      offset += d || r.duration || CHUNK_SECONDS;
    }
    return { text: texts.join(' ').trim(), segments, language, duration: offset };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── silence / talk stats ────────────────────────────────────────────────

export function silenceStats(segments, { gapThreshold = 2 } = {}) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  let gaps = 0; let silence = 0; let longest = 0; let prevEnd = null;
  const talkBySpeaker = {};
  for (const s of sorted) {
    if (prevEnd !== null) {
      const gap = s.start - prevEnd;
      if (gap >= gapThreshold) { gaps++; silence += gap; longest = Math.max(longest, gap); }
    }
    prevEnd = Math.max(prevEnd ?? 0, s.end);
    const who = s.speaker || 'unknown';
    talkBySpeaker[who] = (talkBySpeaker[who] || 0) + Math.max(0, s.end - s.start);
  }
  const totalTalk = Object.values(talkBySpeaker).reduce((a, b) => a + b, 0);
  const ratio = {};
  for (const [k, v] of Object.entries(talkBySpeaker)) ratio[k] = totalTalk ? Number((v / totalTalk).toFixed(3)) : 0;
  return {
    gaps,
    silence_seconds: Number(silence.toFixed(1)),
    longest_gap_seconds: Number(longest.toFixed(1)),
    talk_seconds_by_speaker: Object.fromEntries(Object.entries(talkBySpeaker).map(([k, v]) => [k, Number(v.toFixed(1))])),
    talk_ratio: ratio,
    gap_threshold_seconds: gapThreshold
  };
}

// ─── entry point ─────────────────────────────────────────────────────────

/**
 * Transcribe a call from a local audio file.
 *
 * @param {string} file          local path to the recording
 * @param {object} opts
 * @param {'left'|'right'|null} opts.repChannel  which stereo channel is the rep
 * @param {string} opts.direction call direction, to label a mono call's
 *                 single speaker? No — mono gets no labels; direction is only
 *                 used to name the dual-channel sides when repChannel is unset.
 */
export async function transcribeCall(file, { repChannel = null, prompt = null } = {}) {
  const { openaiApiKey: apiKey, transcribeModel: model, transcribeLanguage: language } = config.conversationPoint;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set — transcription will retry once it is configured');

  const ffmpeg = await hasFfmpeg();
  const info = await probe(file);
  const opts = { apiKey, model, language, prompt, ffmpeg };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-tx-'));

  try {
    // Dual-channel → exact speaker labels.
    if (ffmpeg && info.channels === 2) {
      const { left, right } = await splitStereo(file, work);
      const [L, R] = await Promise.all([transcribeMono(left, opts), transcribeMono(right, opts)]);
      const leftLabel = repChannel === 'left' ? 'rep' : (repChannel === 'right' ? 'customer' : 'speaker_1');
      const rightLabel = repChannel === 'right' ? 'rep' : (repChannel === 'left' ? 'customer' : 'speaker_2');
      const segments = [
        ...L.segments.map((s) => ({ ...s, speaker: leftLabel })),
        ...R.segments.map((s) => ({ ...s, speaker: rightLabel }))
      ].sort((a, b) => a.start - b.start || a.end - b.end);
      const text = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');
      const duration = info.durationSeconds || Math.max(L.duration || 0, R.duration || 0) || null;
      return {
        text, segments, language: L.language || R.language || language, model,
        speakerMethod: 'dual_channel', duration,
        silenceStats: silenceStats(segments),
        channels: 2
      };
    }

    // Mono (or no ffmpeg): one pass.
    let input = file;
    if (ffmpeg) input = await toMonoMp3(file, path.join(work, 'mono.mp3'));
    else if ((await fileSize(file)) > UPLOAD_CAP) {
      throw Object.assign(new Error('recording is over 24 MB and ffmpeg is not installed — install ffmpeg on the server'), { permanent: true });
    }
    const r = await transcribeMono(input, opts);
    const segments = r.segments.map((s) => ({ ...s, speaker: null }));
    return {
      text: r.text, segments, language: r.language, model,
      speakerMethod: 'none', duration: info.durationSeconds || r.duration || null,
      silenceStats: silenceStats(segments),
      channels: info.channels
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    if (!ffmpeg) logger.warn('transcriber: ffmpeg not found — stereo split, compression and chunking are disabled');
  }
}
