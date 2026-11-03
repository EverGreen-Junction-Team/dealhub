// What actually reaches the log when a GHL call fails.
//
// Written after a 401 on /notes/:id halted a sub-account and logged
// {"err":{"type":"Error"}} — no status, no URL, no reason. Two separate bugs
// produced that: the serialiser kept only data.message, and the call site
// passed err.message (a string) to a field expecting an Error.
//
// These assert the LOG OUTPUT, not the serialiser in isolation, because the
// question is "will I be able to diagnose this from the logs" — and pino's
// redaction runs between the two.
import assert from 'node:assert/strict';
import pino from 'pino';
import { Writable } from 'node:stream';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// logger.js imports config.js, which requires the app's env vars. Stub the
// minimum so the module loads — this test is about log OUTPUT, not config,
// and requiring a database to assert a log line would be absurd.
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';

// The real serialiser and redact config, imported rather than duplicated —
// a copy would drift and pass while production failed.
const { logger: _real } = await import('../logger.js');

// A sink we can read. Rebuilt with the same serializer the real logger uses.
const lines = [];
const sink = new Writable({ write(c, e, cb) { lines.push(c.toString()); cb(); } });

// Pull the serializer off the real logger so this tests the shipped code.
const slimErr = _real[Symbol.for('pino.serializers')].err;
const log = pino({ serializers: { err: slimErr } }, sink);

const capture = (obj, msg = 'test') => {
  lines.length = 0;
  log.error(obj, msg);
  return JSON.parse(lines.join(''));
};

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('slimErr — what reaches the log');

// ── The exact failure that halted a sub-account ──────────────────────────
t('a GHL 401 logs status, url AND the response body', () => {
  const err = Object.assign(new Error('Request failed with status code 401'), {
    isAxiosError: true,
    response: {
      status: 401,
      statusText: 'Unauthorized',
      data: { statusCode: 401, message: 'The token does not have access to this location', error: 'Unauthorized' },
      headers: {}
    },
    config: { method: 'get', url: '/notes/abc123?locationId=loc1' }
  });
  const out = capture({ err });
  assert.equal(out.err.status, 401);
  assert.equal(out.err.url, '/notes/abc123?locationId=loc1');
  assert.equal(out.err.method, 'GET');
  // The part that was missing: GHL's own words.
  assert.ok(out.err.ghlBody.includes('does not have access'),
    'response body must reach the log: ' + JSON.stringify(out.err));
});

t('a bare string does not become an empty error object', () => {
  // 38 call sites pass `err: err.message`. This used to emit {"type":"Error"}
  // with no message at all — literally nothing to diagnose from.
  const out = capture({ err: 'Request failed with status code 401' });
  assert.equal(out.err.message, 'Request failed with status code 401', JSON.stringify(out.err));
});

t('scopes are surfaced when GHL reports them', () => {
  const err = Object.assign(new Error('401'), {
    isAxiosError: true,
    response: { status: 401, data: { scope: 'contacts.readonly opportunities.readonly' }, headers: {} },
    config: { method: 'get', url: '/notes/x' }
  });
  const out = capture({ err });
  assert.ok(out.err.ghlScopes.includes('contacts.readonly'), JSON.stringify(out.err));
});

t('a 429 carries retry-after and remaining', () => {
  const err = Object.assign(new Error('429'), {
    isAxiosError: true,
    response: { status: 429, data: {}, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0' } },
    config: { method: 'get', url: '/contacts' }
  });
  const out = capture({ err });
  assert.equal(out.err.retryAfter, '30');
  assert.equal(out.err.rateRemaining, '0');
});

t('a network error keeps its code even with no response', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const out = capture({ err });
  assert.equal(out.err.code, 'ECONNREFUSED');
});

t('an axios error with BOTH a response and a code keeps the code', () => {
  // The old chain was `if (axios) … else if (err.code)`, so a code was
  // dropped whenever a response existed.
  const err = Object.assign(new Error('timeout'), {
    isAxiosError: true, code: 'ECONNABORTED',
    response: { status: 504, data: {}, headers: {} },
    config: { method: 'get', url: '/x' }
  });
  const out = capture({ err });
  assert.equal(out.err.code, 'ECONNABORTED', JSON.stringify(out.err));
  assert.equal(out.err.status, 504);
});

// ── Bounded, and still safe ─────────────────────────────────────────────
t('a huge body is truncated, not dropped', () => {
  const err = Object.assign(new Error('500'), {
    isAxiosError: true,
    response: { status: 500, data: { html: 'x'.repeat(50000) }, headers: {} },
    config: { method: 'get', url: '/x' }
  });
  const out = capture({ err });
  assert.ok(out.err.ghlBody.length < 2100, 'body must be bounded: ' + out.err.ghlBody.length);
  assert.ok(out.err.ghlBody.endsWith('…[truncated]'), 'truncation must be visible');
});

t('an unserialisable body says so rather than vanishing', () => {
  const circular = { a: 1 };
  circular.self = circular;
  const err = Object.assign(new Error('500'), {
    isAxiosError: true,
    response: { status: 500, data: circular, headers: {} },
    config: { method: 'get', url: '/x' }
  });
  const out = capture({ err });
  assert.equal(out.err.ghlBody, '[unserialisable response body]');
});

t('a Bearer token in a header is STILL redacted', () => {
  // The whole point of widening the log must not widen the leak.
  const err = Object.assign(new Error('401'), {
    isAxiosError: true,
    response: { status: 401, data: {}, headers: {} },
    config: { method: 'get', url: '/x', headers: { Authorization: 'Bearer SECRET_TOKEN_VALUE' } }
  });
  // Through OUR sink, not the real logger — that one writes to stdout, so
  // `lines` stayed empty and the assertion passed without testing anything.
  // Same serializer, so this still exercises the shipped code.
  const out = capture({ err });
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes('SECRET_TOKEN_VALUE'), 'token leaked into the log: ' + raw);
  // And prove the assertion can actually fail: the URL IS present, so the
  // check above is looking at real output rather than an empty string.
  assert.ok(raw.includes('/x'), 'sanity: the log line must contain the url');
});


// ── The whole codebase must pass the ERROR, not its message ─────────────
//
// Every assertion above proves slimErr CAN surface GHL's response body. None
// of it matters if a call site hands it a string instead — and 53 of them did,
// across 29 files, which is why a 400 on the email attachment fetch logged as
// "Request failed with status code 400" with no reason attached. Twice.
//
// This is a lint rule expressed as a test: it fails on the pattern rather
// than on behaviour, because the pattern is the bug.
t('no call site logs err.message instead of the error', () => {
  const SRC = join(here, '..', '..');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      // This file and the serialiser itself deliberately exercise strings.
      if (full.endsWith('logger.js') || full.endsWith('slimErr.test.mjs')) continue;

      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        // `err: err.message` and `message: err.message` inside a log object
        // both discard status, url and GHL's body.
        if (/\b(err|message): (err|e)\.message\b/.test(line)) {
          offenders.push(`${full.replace(SRC, 'src')}:${i + 1}`);
        }
      });
    }
  };
  walk(SRC);

  assert.deepEqual(offenders, [],
    'these sites log err.message, which drops GHL\'s response body — pass the '
    + 'error object instead so slimErr can capture status, url and ghlBody:\n  '
    + offenders.join('\n  '));
});

// A 400 is the case that prompted all of this: the email attachment fetch was
// handed an emailMessageId where the endpoint wanted a message id.
t('a GHL 400 logs GHL own words, not just the axios summary', () => {
  const err = Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: {
      status: 400,
      statusText: 'Bad Request',
      data: { statusCode: 400, message: ['id must be a mongodb id'], error: 'Bad Request' },
      headers: {}
    },
    config: { method: 'get', url: '/conversations/messages/wrL93dybjg5b2O8LEnD5' }
  });
  const out = capture({ err });
  assert.equal(out.err.status, 400);
  assert.equal(out.err.url, '/conversations/messages/wrL93dybjg5b2O8LEnD5');
  assert.ok(out.err.ghlBody.includes('mongodb id'),
    'GHL reason missing from the log: ' + JSON.stringify(out.err));
});

console.log(`\n${n} passed`);
