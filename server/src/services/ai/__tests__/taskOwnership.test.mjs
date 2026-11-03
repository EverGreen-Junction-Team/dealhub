// Who owns a task the AI created, and who is recorded as making it.
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// A task created through Deal AI arrived with assigned_to = NULL. The Tasks
// tab filters on exactly that column (routes/tasks.js: `t.assigned_to = $n`),
// so the task existed, was visible in "all tasks", and matched no rep filter
// — the rep who asked for it could not find it under their own name.
//
// Three gaps in a row, each of which alone was enough:
//   1. propose_create_task's schema had no assignedTo, so the model could
//      not express an owner even in principle.
//   2. create_task sent only title/body/dueDate to GHL.
//   3. confirmAction RECEIVED confirmedBy and never passed it to runWrite.
//
// The fix threads the confirming rep through to the write. These tests pin
// the two ends that are cheap to get wrong again.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTaskPatch } from '../../taskPatch.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const executor = read('../actionExecutor.js');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('the confirming rep is passed to the write, not dropped at the door', () => {
  assert.match(
    executor, /runWrite\(install, action\.action_type, payload, confirmedBy\)/,
    'confirmAction still drops confirmedBy before runWrite'
  );
  assert.match(
    executor, /async function runWrite\(install, actionType, payload, confirmedBy/,
    'runWrite does not accept the confirming user'
  );
});

t('an AI-created task is owned by whoever confirmed it', () => {
  const block = executor.slice(executor.indexOf("case 'create_task'"));
  const call = block.slice(0, block.indexOf('recordPendingDealLink'));
  assert.match(call, /assignedTo:/, 'create_task sends no assignee at all');
  assert.match(
    call, /confirmedBy/,
    'create_task does not fall back to the confirming rep — tasks land unowned'
  );
});

t('no assignee is OMITTED, never sent as an explicit null', () => {
  // buildTaskPatch skips undefined but forwards null to GHL as "clear this
  // field". With no user known there is nothing to say about the owner, and
  // saying "set it to nobody" is a different statement. The manual route
  // omits the key; the AI route must behave identically.
  const { patch: absent } = buildTaskPatch(
    { title: 'T', dueDate: '2026-10-10', completed: false, assignedTo: undefined },
    { create: true }
  );
  assert.equal('assignedTo' in absent, false, 'an unknown owner leaked as a field to GHL');

  const { patch: present } = buildTaskPatch(
    { title: 'T', dueDate: '2026-10-10', completed: false, assignedTo: 'userBrad' },
    { create: true }
  );
  assert.equal(present.assignedTo, 'userBrad', 'a known owner was not sent');
});

t('an AI note carries its author, like a hand-written one', () => {
  const block = executor.slice(executor.indexOf("case 'create_note'"));
  const call = block.slice(0, block.indexOf('recordPendingDealLink'));
  assert.match(call, /userId:/, 'create_note sends no author');
  assert.match(call, /confirmedBy/, 'create_note does not fall back to the confirming rep');
});

t('provenance is parked for the webhook, which owns the INSERT', () => {
  // Our row does not exist at create time, so created_by cannot be written
  // directly — it rides pending_deal_links and taskWriter applies it.
  // Read each recordPendingDealLink CALL, not the first mention of the
  // constant — that is the import line, which names the entity and proves
  // nothing about whether the intent is ever parked.
  const calls = [...executor.matchAll(/recordPendingDealLink\(([\s\S]{0,200}?)\)/g)]
    .map((m) => m[1]);
  assert.ok(calls.length >= 2, `expected a park for task and note, found ${calls.length}`);

  for (const entity of ['ENTITY_TASK', 'ENTITY_NOTE']) {
    const call = calls.find((c) => c.includes(entity));
    assert.ok(call, `${entity} intent is never parked`);
    assert.match(call, /'ai'/, `${entity} is parked without marking it AI-made`);
    assert.match(call, /confirmedBy/, `${entity} is parked without the confirming rep`);
  }
});

t('created_by is write-once: a later webhook cannot blank it', () => {
  const writer = read('../../taskWriter.js');
  assert.match(
    writer, /created_by\s*=\s*COALESCE\(tasks\.created_by, EXCLUDED\.created_by\)/,
    'created_by is overwritable — a later TaskUpdate carrying nothing would erase the author'
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
