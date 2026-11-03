// Tests that a rep never sees a provider's raw error payload.
//
// Run: node src/services/ai/__tests__/aiErrorMessage.test.mjs
//
// The production bug (2026-09-25): an exhausted credit balance surfaced as
// the literal string
//   400 {"type":"error","error":{"type":"invalid_request_error", ...}}
// because routes/ai.js sent `error: err.message` — the Anthropic SDK's own
// message — and api/client.js trusts the server's `error` field as
// rep-facing copy. The classifier was already correct by then; the leak was
// in what got sent alongside the code.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', '..', 'routes', 'ai.js'), 'utf8');

// Source-parsed rather than imported: routes/ai.js builds an Express router
// and opens a DB pool at module load.
const start = src.indexOf('const AI_ERROR_MESSAGE = {');
assert.notEqual(start, -1, 'AI_ERROR_MESSAGE is gone from routes/ai.js');
const fnStart = src.indexOf('function aiErrorMessage(');
const fnEnd = src.indexOf('\n}', fnStart) + 2;
const aiErrorMessage = new Function(
  `${src.slice(start, src.indexOf('};', start) + 2)}\n${src.slice(fnStart, fnEnd)}; return aiErrorMessage;`
)();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('no_credit says the account needs topping up', () => {
  const m = aiErrorMessage('no_credit');
  assert.match(m, /run out of credit/i);
  assert.match(m, /retrying will not help/i);
});

t('every state returns human copy, never JSON', () => {
  for (const s of ['no_credit', 'timeout', 'rate_limited', 'malformed', 'api_error']) {
    const m = aiErrorMessage(s);
    assert.ok(!m.includes('{'), `${s} leaked a JSON brace`);
    assert.ok(!/^\d{3}\s/.test(m), `${s} leaked an HTTP status prefix`);
    assert.ok(m.length > 20, `${s} message is too terse to act on`);
  }
});

t('an unknown state still gets usable copy', () => {
  const m = aiErrorMessage('something_new');
  assert.ok(m.length > 20);
  assert.ok(!m.includes('{'));
});

t('the two AI routes no longer send err.message', () => {
  // The exact leak: `error: err.message` inside an aiStatus branch.
  const dealBranch = src.slice(src.indexOf("'ai: ask failed'"), src.indexOf("'ai: ask failed'") + 400);
  assert.ok(!dealBranch.includes('error: err.message'), 'Deal AI still leaks err.message');

  const portBranch = src.slice(
    src.indexOf("'ai: portfolio ask failed'"),
    src.indexOf("'ai: portfolio ask failed'") + 400
  );
  assert.ok(!portBranch.includes('error: err.message'), 'Insights AI still leaks err.message');
});

console.log(`\n${n} passed, 0 failed`);
