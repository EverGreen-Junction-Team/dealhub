// A task the CRM has never heard of.
//
// WHAT HAPPENED. A rep tried to edit "5th follow up" and got "check the
// values and try again". Nothing was wrong with the values. GHL had
// answered `400 {"message":"The task id is invalid."}` — on a task whose id
// was a perfectly well-formed 20-character GHL id that had arrived on GHL's
// own webhook.
//
// The cause was upstream: "5th follow up" is a workflow step, one contact
// already had two of them four days apart, and a workflow that deletes and
// recreates its tasks leaves our rows pointing at ids GHL has discarded.
//
// Two separate failures followed from that, and both are pinned here:
//
//   1. the rep was told to correct fields that were all valid, on a form
//      where no correction could ever have worked;
//   2. the phantom row stayed in the list, so EVERY action on it — edit,
//      complete, delete — failed the same way, for ever, with nothing the
//      rep could do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';

const { rejectionMessage, looksUnknownId, looksMissing } =
  await import('../ghlRejection.js');

const here = dirname(fileURLToPath(import.meta.url));
const write = readFileSync(join(here, '..', 'ghlTaskWrite.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// GHL's actual words, from the production log.
const GHL_INVALID = 'The task id is invalid.';

console.log('telling the three failures apart');

t("GHL's own wording is recognised", () => {
  assert.equal(looksUnknownId(GHL_INVALID), true);
  // Not a deletion: saying so would send the rep looking in the CRM bin for
  // something that may still be there under another contact.
  assert.equal(looksMissing(GHL_INVALID), false);
});

t('a genuine validation error is NOT mistaken for an unknown id', () => {
  // The important negative. If this drifted, real "fix your input" errors
  // would start telling reps the record does not exist, and they would stop
  // trusting the message that actually matters.
  for (const detail of [
    'title must be a string',
    'dueDate must be a valid ISO 8601 date string',
    'assignedTo must be a user in this location'
  ]) {
    assert.equal(looksUnknownId(detail), false, detail);
  }
});

t('a missing record still reads as missing', () => {
  assert.equal(looksMissing('Task not found'), true);
  assert.equal(looksUnknownId('Task not found'), false);
});

t('each failure gets its own message', () => {
  const unknown = rejectionMessage('task', GHL_INVALID).message;
  const invalidInput = rejectionMessage('task', 'title must be a string').message;
  const gone = rejectionMessage('task', 'Task not found').message;

  // Matches what the app DOES: the row is cleared on this signal, so the
  // message says it has gone rather than sending the rep to the CRM after
  // something that is no longer there.
  assert.match(unknown, /removed from your list/i);
  // The specific regression: no "check the values" on an error that has
  // nothing to do with the values.
  assert.ok(!/check the values/i.test(unknown));
  assert.match(invalidInput, /check the values/i);
  assert.match(gone, /no longer exists/i);

  assert.notEqual(unknown, invalidInput);
  assert.notEqual(unknown, gone);
});

t('a refused DELETE does not talk about values either', () => {
  const m = rejectionMessage('task', 'Bad Request', { action: 'delete' }).message;
  assert.ok(!/check the values/i.test(m));
  assert.match(m, /would not delete/i);
});

console.log('the phantom row clears itself');

t('every write path clears a task the CRM disowns', () => {
  // Edit, complete AND delete. Fixing only the one the bug was reported
  // against would leave the other two failing identically on the same row.
  const calls = write.match(/await forgetUnknownTask\(install, taskId, err\)/g) || [];
  assert.equal(calls.length, 3, 'update, complete and delete must all clear it');
});

t('it only fires on this signal, not on any rejection', () => {
  // A guard that fired on every 400 would soft-delete tasks over ordinary
  // validation errors — the rep mistypes a date and the task vanishes.
  const fn = write.slice(write.indexOf('async function forgetUnknownTask'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /status !== 400 && status !== 422/);
  assert.match(body, /looksUnknownId\(detail\)/);
  assert.match(body, /if \(!looksUnknownId\(detail\)\) return/);
});

t('it soft-deletes, so the nightly sync can undo it', () => {
  // The one case this gets wrong is a task MOVED to another contact, which
  // also answers "invalid" because the write is contact-scoped. A soft
  // delete is recoverable: tasksSync's upsert clears deleted_at on anything
  // GHL returns, so it reappears within a day. A hard delete would not.
  const fn = write.slice(write.indexOf('async function forgetUnknownTask'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /SET status = 'deleted', deleted_at = now\(\)/);
  assert.ok(!/DELETE\s+FROM\s+tasks/i.test(body), 'must not hard-delete');
  // And it must not touch a row that is already gone, or it would keep
  // re-stamping deleted_at and make "when did this disappear" unanswerable.
  assert.match(body, /AND deleted_at IS NULL/);
});

t('it never throws over the error it is reporting', () => {
  // This runs while a different error is already on its way to the rep.
  // Throwing here would replace a message they can act on with a database
  // one they cannot.
  const fn = write.slice(write.indexOf('async function forgetUnknownTask'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /try \{/);
  assert.match(body, /catch \(dbErr\)/);
});

console.log(`\n${n} passed, 0 failed`);
