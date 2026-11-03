// The browser's patience for an ANSWER, and what it says when it runs out.
//
// Two separate bugs, one symptom. A rep asking a question on a long thread
// saw "That took too long — check your connection and try again." on a
// perfectly good connection, and a retry usually worked.
//
//   1. apiClient's global 60s applied to the ask endpoints too. The server
//      runs a tool loop (up to 6 sequential Claude calls, each with its own
//      120s budget), so it can legitimately take longer than a minute. The
//      browser abandoned work the server had ALREADY FINISHED and written —
//      which is why retrying "fixed" it.
//   2. That abort arrives as ECONNABORTED, but both AI surfaces only matched
//      the server's own 'TIMEOUT' code, so the message fell through to
//      apiClient's generic copy and blamed the network.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const ai = read('../ai.js');
const client = read('../client.js');

t('the two ask endpoints get their own, longer timeout', () => {
  // Each call is read from its URL to the end of its argument list, NOT by
  // line: the deal ask spans seven lines, so a single-line match misses the
  // options object entirely and fails on correct code.
  const callBody = (marker) => {
    const at = ai.indexOf(marker);
    assert.notEqual(at, -1, `${marker} not found`);
    const end = ai.indexOf('),', at);
    assert.notEqual(end, -1, `${marker}: could not find end of call`);
    return ai.slice(at, end);
  };

  assert.match(
    callBody('/api/ai/deals/'), /timeout: ASK_TIMEOUT_MS/,
    'deal ask still uses the global timeout'
  );
  assert.match(
    callBody("'/api/ai/portfolio/ask'"), /timeout: ASK_TIMEOUT_MS/,
    'portfolio ask still uses the global timeout'
  );
});

t('the ask budget is longer than the global one, and bounded', () => {
  const declared = ai.match(/ASK_TIMEOUT_MS\s*=\s*([\d_]+)/);
  assert.ok(declared, 'ASK_TIMEOUT_MS not declared');
  const askMs = Number(declared[1].replace(/_/g, ''));
  const globalMs = Number(client.match(/timeout:\s*(\d+)/)[1]);

  assert.ok(askMs > globalMs, `ask budget ${askMs} must exceed the global ${globalMs}`);
  assert.ok(askMs <= 300_000, `ask budget ${askMs} is too long to leave a rep waiting`);
});

t('a browser-side abort reads as a slow model, not a bad connection', () => {
  for (const rel of ['../../pages/dealhub/AskDeal.jsx', '../../pages/tabs/CopilotTab.jsx']) {
    const src = read(rel);
    const branch = src.split('\n').find((l) => l.includes("code === 'TIMEOUT'"));
    assert.ok(branch, `${rel}: no TIMEOUT branch`);
    assert.match(branch, /ECONNABORTED/, `${rel}: client-side abort not treated as a timeout`);
  }
});

t('apiClient still blames the connection only when nothing came back', () => {
  assert.match(client, /ECONNABORTED/);
  assert.match(client, /That took too long/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
