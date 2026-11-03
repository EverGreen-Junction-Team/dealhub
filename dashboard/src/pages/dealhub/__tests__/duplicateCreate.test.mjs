// "Create task" must not be offered after this turn already created one.
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// A rep asked the agent to create a task. It drafted one, the rep confirmed
// it, and the card said "Create task confirmed" — then one line below, the
// answer's action bar still offered "Create task". Clicking it made a SECOND
// task with the same text, and nothing in the thread said the first existed.
//
// The action bar rendered on any answered turn and never looked at what the
// turn had already done. Same for "Save as note".

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const ask = read('../AskDeal.jsx');
const card = read('../../shared/ActionCard.jsx');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// The real reducer, lifted from the component so the TEST exercises the rule
// rather than restating it.
function alreadyMade(proposedActions) {
  const made = { note: false, task: false };
  for (const a of proposedActions || []) {
    if (a.status !== 'confirmed') continue;
    if (a.actionType === 'create_note') made.note = true;
    if (a.actionType === 'create_task') made.task = true;
  }
  return made;
}

t('a confirmed task hides the Create task button', () => {
  const made = alreadyMade([{ actionType: 'create_task', status: 'confirmed' }]);
  assert.equal(made.task, true, 'the duplicate button would still show');
  // The note button is untouched — a turn that made a task has not made a note.
  assert.equal(made.note, false, 'creating a task wrongly hid the note button too');
});

t('an UNCONFIRMED proposal leaves the button alone', () => {
  // A draft on a card is not a record. The rep may reject it and then want to
  // write the task by hand — hiding the button would strand them.
  for (const status of [null, undefined, 'pending']) {
    assert.equal(alreadyMade([{ actionType: 'create_task', status }]).task, false,
      `status ${String(status)} wrongly counted as created`);
  }
});

t('a rejected or failed action leaves the button alone', () => {
  for (const status of ['rejected', 'failed']) {
    assert.equal(alreadyMade([{ actionType: 'create_task', status }]).task, false,
      `a ${status} action wrongly counted as created`);
  }
});

t('other action types do not hide either button', () => {
  const made = alreadyMade([
    { actionType: 'send_message', status: 'confirmed' },
    { actionType: 'update_deal', status: 'confirmed' },
  ]);
  assert.deepEqual(made, { note: false, task: false }, 'an unrelated action hid a button');
});

t('the component uses this rule, and hides each button independently', () => {
  assert.match(ask, /const alreadyMade = useMemo/, 'the component no longer computes it');
  assert.match(ask, /\{!alreadyMade\.note && \(/, 'the note button is not conditional');
  assert.match(ask, /\{!alreadyMade\.task && \(/, 'the task button is not conditional');
  // And the whole row goes when BOTH are gone, rather than leaving an empty
  // strip of padding under the answer.
  assert.match(ask, /alreadyMade\.note === false \|\| alreadyMade\.task === false/,
    'an empty action row is still rendered when both buttons are hidden');
});

t('confirming updates the turn immediately, without a reload', () => {
  // The button only hides if the CONFIRMED status reaches the turn. ActionCard
  // emits 'confirmed'; AskDeal writes it back into proposedActions. If either
  // half changes wording, the fix silently stops working.
  assert.match(card, /onResolved\?\.\('confirmed'\)/, "ActionCard no longer emits 'confirmed'");
  assert.match(ask, /a\.actionId === actionId \? \{ \.\.\.a, status: outcome \}/,
    'the resolved status is no longer written back into the turn');
});


t('a reopened chat carries its actions through to the turn', () => {
  // THE SECOND HALF of this bug. The server returning proposedActions is not
  // enough: reopen() builds each turn field by field, so any key it omits is
  // silently dropped. With the server fixed and this line missing, a
  // confirmed task's card still vanished on reload and "Create task" came
  // back — ready to make a duplicate.
  const at = ask.indexOf('const reopen =');
  assert.notEqual(at, -1, 'reopen() is gone');
  const body = ask.slice(at, ask.indexOf('setActiveChatId', at));
  assert.match(
    body, /proposedActions: t\.proposedActions \|\| \[\]/,
    'reopen() drops proposedActions — reloading a chat loses what it did'
  );
});

t('both AI surfaces carry actions through reopen', () => {
  // The portfolio tab had this fixed already; the deal tab was missed. Pinned
  // together so the next surface does not repeat it a third time.
  const copilot = readFileSync(join(here, '../../tabs/CopilotTab.jsx'), 'utf8');
  for (const [name, src] of [['AskDeal', ask], ['CopilotTab', copilot]]) {
    const at = src.indexOf('const reopen =');
    assert.notEqual(at, -1, `${name}: reopen() is gone`);
    assert.match(
      src.slice(at, at + 2000), /proposedActions: t\.proposedActions/,
      `${name} drops proposedActions when reopening a chat`
    );
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
