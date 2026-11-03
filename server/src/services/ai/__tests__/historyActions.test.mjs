// A reopened Deal AI chat must show what it already did.
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// A rep asked for a task, confirmed it, and the card said "Create task
// confirmed". They switched tab and came back: the card was GONE, and the
// answer's own "Create task" button was offered again — ready to make a
// second, identical task.
//
// askHistory built each turn from the question and the answer text only. It
// never returned proposedActions, so the whole audit trail of what a chat had
// DONE disappeared on every reload. The portfolio history already returned
// them; the deal history was simply missing it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runLog = readFileSync(join(here, '../runLog.js'), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

function askHistoryBody() {
  const at = runLog.indexOf('export async function askHistory');
  assert.notEqual(at, -1, 'askHistory is gone');
  return runLog.slice(at, runLog.indexOf('export async function portfolioHistory'));
}

t('a reopened deal turn carries its actions', () => {
  const body = askHistoryBody();
  assert.match(body, /proposedActions: actionsByRun\.get\(row\.id\) \|\| \[\]/,
    'turns come back with no actions — confirmed work vanishes on reload');
});

t('the actions are read from ai_actions, keyed on the run', () => {
  const body = askHistoryBody();
  assert.match(body, /FROM ai_actions/, 'actions are not fetched');
  assert.match(body, /run_id = ANY\(\$2::uuid\[\]\)/, 'actions are not keyed to these runs');
  // Scoped, like every other read in this file.
  assert.match(body, /WHERE location_id = \$1/, 'the action read is not tenant-scoped');
});

t('the CURRENT status comes back, so a confirmed card reopens confirmed', () => {
  const body = askHistoryBody();
  assert.match(body, /status: row\.status/, 'status is not returned — every card reopens as pending');
});

t('an edited action reopens showing what was SENT', () => {
  // A rep who edited the draft before confirming must see what they sent,
  // not the model's first guess.
  const body = askHistoryBody();
  assert.match(body, /row\.edited_payload \|\| row\.proposed_payload/,
    'the edited payload is ignored — the card would show a superseded draft');
});

t('no actions is not an error', () => {
  // Most turns propose nothing. The query must be skipped rather than run
  // with an empty array, and the turn still gets a [].
  const body = askHistoryBody();
  assert.match(body, /if \(runIds\.length\)/, 'the action query runs even with no runs');
  assert.match(body, /\|\| \[\]/, 'a turn with no actions would get undefined');
});

t('the shape matches a live answer exactly', () => {
  // AskDeal renders a reopened turn through the same path as a fresh one, so
  // every key has to line up — a rename on either side silently empties the
  // card.
  const body = askHistoryBody();
  for (const key of ['actionId:', 'actionType:', 'proposed:', 'status:']) {
    assert.ok(body.includes(key), `history omits ${key} — the card cannot render`);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
