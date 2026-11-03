// A bodyless POST must send NO body — not the string "null".
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// runSync passed `null` as axios's body argument. axios serialises that to
// the literal four characters `null`, Content-Type stays application/json,
// and body-parser rejects it before the route is ever reached:
//
//   SyntaxError: Unexpected token 'n', "null" is not valid JSON
//   POST /api/control/sync/businesses 500
//
// The 500 came from the error handler, not from the sync — which is what
// made it look like the sync itself had failed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const control = readFileSync(join(here, '../control.js'), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('runSync sends no request body', () => {
  const at = control.indexOf('runSync:');
  assert.notEqual(at, -1, 'runSync is gone');
  const call = control.slice(at, control.indexOf('),', at));
  assert.ok(
    !/,\s*null\s*,/.test(call),
    'runSync passes null as the body — axios sends the string "null" and ' +
    'body-parser rejects it with a 500 before the route runs'
  );
});

t('every bodyless POST in this file avoids null', () => {
  // The same mistake is available on any POST that takes options but no
  // payload, so this pins the file rather than the one call.
  const offenders = control
    .split('\n')
    .filter((l) => /apiClient\.post\(/.test(l) && /,\s*null\s*,/.test(l));
  assert.deepEqual(offenders, [], `null body on: ${offenders.join(' | ')}`);
});

t('runSync keeps its own longer timeout', () => {
  // These page through a catalogue against GHL and outrun the client's 60s
  // default on a large account.
  const at = control.indexOf('runSync:');
  const call = control.slice(at, control.indexOf('),', at));
  assert.match(call, /timeout:/, 'runSync uses the 60s default — a big catalogue would abort');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
