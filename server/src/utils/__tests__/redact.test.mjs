// Does the widened redact config actually mask a token passed as a FIELD?
// pino's redact syntax is fussy — a wrong path is silently ignored, which is
// exactly how the original header-only config let this through.
import pino from 'pino';
import { Writable } from 'node:stream';

const lines = [];
const sink = new Writable({ write(c, e, cb) { lines.push(c.toString()); cb(); } });

const logger = pino({
  redact: {
    paths: [
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.request.headers.Authorization',
      'err.request._header',
      '*.headers.Authorization',
      '*.headers.authorization',
      // Top-level too: '*.headers.x' requires a wrapper level, so a log call
      // passing { headers } directly was NOT matched. Caught by the test in
      // utils/__tests__/redact.test.mjs.
      'headers.Authorization',
      'headers.authorization',
      'accessToken', 'refreshToken', 'access_token', 'refresh_token',
      '*.accessToken', '*.refreshToken', '*.access_token', '*.refresh_token',
      'tokens', 'install.access_token', 'install.refresh_token'
    ],
    censor: '[REDACTED]'
  }
}, sink);

const SECRET = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.LIVE_TOKEN';

const cases = [
  ['top-level tokens object (the actual bug)', { tokens: { accessToken: SECRET, refreshToken: SECRET } }],
  ['top-level accessToken',                    { accessToken: SECRET }],
  ['top-level snake_case',                     { access_token: SECRET }],
  ['nested under install',                     { install: { access_token: SECRET, refresh_token: SECRET } }],
  ['nested one level',                         { row: { accessToken: SECRET } }],
  ['auth header',                              { headers: { authorization: `Bearer ${SECRET}` } }]
];

let pass = 0, fail = 0;
for (const [name, obj] of cases) {
  lines.length = 0;
  logger.info(obj, 'test');
  const out = lines.join('');
  if (out.includes(SECRET)) { fail++; console.log('FAIL', name, '->', out.trim().slice(0, 140)); }
  else { pass++; console.log('ok  ', name); }
}

// And a case that SHOULD still appear — proving the redaction is targeted and
// not just blanking everything.
lines.length = 0;
logger.info({ locationId: 'fJNuIdxGgchGpJ9OoBbk' }, 'test');
const kept = lines.join('').includes('fJNuIdxGgchGpJ9OoBbk');
kept ? (pass++, console.log('ok   non-secret fields survive'))
     : (fail++, console.log('FAIL non-secret fields survive'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
