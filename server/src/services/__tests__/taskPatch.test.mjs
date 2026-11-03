// Tests for taskPatch.js — the mapper between our task fields and GHL's
// create/update task endpoints.
//
// Dependency-free, like the module under test: run with `node taskPatch.test.mjs`.

import { buildTaskPatch, toGhlDueDate, TaskWriteError } from '../taskPatch.js';

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, `got  ${g}\n        want ${w}`);
}

function throwsWith(name, fn, { field = undefined, match = undefined } = {}) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${name}\n        expected a throw, got none`);
  } catch (err) {
    if (!(err instanceof TaskWriteError)) {
      failed++;
      console.log(`FAIL  ${name}\n        threw ${err.name}, not TaskWriteError`);
      return;
    }
    if (field !== undefined && err.field !== field) {
      failed++;
      console.log(`FAIL  ${name}\n        field was ${err.field}, expected ${field}`);
      return;
    }
    if (match && !err.message.toLowerCase().includes(match.toLowerCase())) {
      failed++;
      console.log(`FAIL  ${name}\n        message "${err.message}" lacks "${match}"`);
      return;
    }
    passed++;
    console.log(`  ok  ${name}`);
  }
}

console.log('\n--- create: required fields ---');

eq('minimal create',
  buildTaskPatch({ title: 'Call back', dueDate: '2026-09-01T11:00:00Z' }, { create: true }).patch,
  { title: 'Call back', dueDate: '2026-09-01T11:00:00.000Z', completed: false });

ok('completed defaults to false on create',
  buildTaskPatch({ title: 'x', dueDate: '2026-09-01' }, { create: true }).patch.completed === false);

ok('an explicit completed:true on create survives',
  buildTaskPatch(
    { title: 'x', dueDate: '2026-09-01', completed: true }, { create: true }
  ).patch.completed === true);

throwsWith('create without a title',
  () => buildTaskPatch({ dueDate: '2026-09-01' }, { create: true }),
  { field: 'title', match: 'needs a title' });

throwsWith('create with an empty title',
  () => buildTaskPatch({ title: '   ', dueDate: '2026-09-01' }, { create: true }),
  { field: 'title' });

throwsWith('create without a due date',
  () => buildTaskPatch({ title: 'x' }, { create: true }),
  { field: 'dueDate', match: 'needs a due date' });

console.log('\n--- update: partial bodies ---');

eq('completed only — the commonest edit',
  buildTaskPatch({ completed: true }).patch, { completed: true });

eq('title only', buildTaskPatch({ title: 'Renamed' }).patch, { title: 'Renamed' });

eq('title is trimmed', buildTaskPatch({ title: '  spaced  ' }).patch, { title: 'spaced' });

eq('body can be cleared with an empty string',
  buildTaskPatch({ body: '' }).patch, { body: '' });

eq('assignedTo can be cleared with null',
  buildTaskPatch({ assignedTo: null }).patch, { assignedTo: null });

eq('assignedTo empty string also clears',
  buildTaskPatch({ assignedTo: '' }).patch, { assignedTo: null });

eq('undefined means "not changing" and is skipped',
  buildTaskPatch({ title: 'keep', body: undefined }).patch, { title: 'keep' });

throwsWith('update with nothing to change',
  () => buildTaskPatch({}), { match: 'nothing to update' });

throwsWith('update clearing the title is rejected',
  () => buildTaskPatch({ title: '' }),
  { field: 'title', match: 'needs a title' });

console.log('\n--- unknown fields are dropped, not passed through ---');

// An unknown key makes GHL reject the WHOLE request, so a typo must not travel
// with the valid fields.
eq('unknown keys dropped from the patch',
  buildTaskPatch({ title: 'x', status: 'open', id: 'abc', dealId: 'd1' }).patch,
  { title: 'x' });

eq('...and reported so the caller can log them',
  buildTaskPatch({ title: 'x', status: 'open', dealId: 'd1' }).dropped.sort(),
  ['dealId', 'status']);

// The UI's own field names for things GHL calls something else. These would be
// silent data loss if they ever reached the patch unmapped.
eq('our `dueAt` is NOT mistaken for dueDate',
  buildTaskPatch({ title: 'x', dueAt: '2026-09-01' }).dropped, ['dueAt']);

eq('our `owner` is NOT mistaken for assignedTo',
  buildTaskPatch({ title: 'x', owner: 'u1' }).dropped, ['owner']);

console.log('\n--- dueDate normalisation ---');

eq('ISO with Z passes through as ISO',
  toGhlDueDate('2026-09-01T11:00:00Z'), '2026-09-01T11:00:00.000Z');

eq('ISO with an offset is converted to UTC',
  toGhlDueDate('2026-09-01T11:00:00+01:00'), '2026-09-01T10:00:00.000Z');

// The date picker sends YYYY-MM-DD. End of day, not midnight: a task due
// "1 September" must not read as overdue at 00:01 that morning.
eq('a bare date becomes end of that day UTC',
  toGhlDueDate('2026-09-01'), '2026-09-01T23:59:59.000Z');

eq('a Date object is accepted',
  toGhlDueDate(new Date('2026-09-01T11:00:00Z')), '2026-09-01T11:00:00.000Z');

eq('null clears the due date', toGhlDueDate(null), null);
eq('empty string clears the due date', toGhlDueDate(''), null);

throwsWith('nonsense text is rejected',
  () => toGhlDueDate('next tuesday'), { field: 'dueDate' });

// JS silently rolls 31 February over to 3 March. A task saved a fortnight from
// the date the rep typed is worse than a rejection.
throwsWith('an impossible date does not silently roll over',
  () => toGhlDueDate('2026-02-31'), { field: 'dueDate' });

throwsWith('a number is not a date',
  () => toGhlDueDate(1756728000000), { field: 'dueDate' });

console.log('\n--- type validation ---');

throwsWith('completed must be boolean, not "true"',
  () => buildTaskPatch({ completed: 'true' }), { field: 'completed' });

throwsWith('completed must be boolean, not 1',
  () => buildTaskPatch({ completed: 1 }), { field: 'completed' });

throwsWith('title must be text',
  () => buildTaskPatch({ title: 42 }), { field: 'title' });

throwsWith('assignedTo must be a string id',
  () => buildTaskPatch({ assignedTo: { id: 'u1' } }), { field: 'assignedTo' });

throwsWith('a non-object body is rejected',
  () => buildTaskPatch('title=x'), { match: 'nothing to save' });

throwsWith('an array is not a field set',
  () => buildTaskPatch(['title']), { match: 'nothing to save' });

console.log('\n--- length limits ---');

throwsWith('an over-long title is rejected, not truncated',
  () => buildTaskPatch({ title: 'a'.repeat(1501) }), { field: 'title' });

ok('a title at the limit is accepted',
  buildTaskPatch({ title: 'a'.repeat(1500) }).patch.title.length === 1500);

// Boundary tested from BOTH sides. The old test used 5001 against a 5000
// limit; when the limit moved to 2000 it still passed while no longer testing
// the boundary at all — a limit change could have gone unnoticed.
ok('a body at the limit is accepted',
  buildTaskPatch({ body: 'a'.repeat(2000) }).patch.body.length === 2000);

throwsWith('a body one over the limit is rejected',
  () => buildTaskPatch({ body: 'a'.repeat(2001) }), { field: 'body' });

console.log('\n--- full round trip ---');

eq('every writable field at once',
  buildTaskPatch({
    title: 'Chase the quote',
    body: '<p>Second follow-up</p>',
    dueDate: '2026-09-15T09:30:00Z',
    completed: false,
    assignedTo: 'hxHGVRb1YJUscrCB8eXK'
  }, { create: true }).patch,
  {
    title: 'Chase the quote',
    body: '<p>Second follow-up</p>',
    dueDate: '2026-09-15T09:30:00.000Z',
    completed: false,
    assignedTo: 'hxHGVRb1YJUscrCB8eXK'
  });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
