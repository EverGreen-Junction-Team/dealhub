// Showing GHL's own reason — services/ghlRejection.js.
//
// Run: node --test src/services/__tests__/rejectionDetail.test.mjs
//
// ── WHY THE RULE CHANGED ─────────────────────────────────────────────
//
// It used to be absolute: never show GHL's text, on the strength of one
// real example —
//
//   "Contact not found for id:88qfhZVULZ41Bl7BipOA"
//
// which tells a salesperson nothing and puts a database id on a screen
// the whole team reads. Sound reasoning, too broad a rule. It threw out
// the good messages with the bad, and what a rep actually got was
//
//   "Your CRM would not accept that change — check the values and try again"
//
// over a form whose values were all correct, because what GHL had said
// was "The slot is not available". That is the entire answer and we were
// deleting it.
//
// So the question is no longer "did GHL write it" but "does it name
// anything the rep should not see, or cannot act on".
//
// ── WHICH WAY TO BE WRONG ────────────────────────────────────────────
//
// Deliberately strict. A false negative costs one generic banner — the
// one that would have been shown anyway. A false positive puts a record
// id, or somebody else's email address, in front of the whole sales
// team. Every test below that asserts null is protecting that side.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';
process.env.SESSION_JWT_SECRET ||= 'unused';
const { safeDetail, rejectionMessage, isSlotUnavailable, translateKnown } = await import('../ghlRejection.js');

// ── What a rep should see ─────────────────────────────────────────────

test('a plain reason is shown', () => {
  // The case that started this: an appointment dragged onto a slot the
  // calendar will not take.
  assert.equal(safeDetail('The slot is not available'), 'The slot is not available');
  assert.equal(
    safeDetail('Appointment is outside the working hours of this calendar'),
    'Appointment is outside the working hours of this calendar'
  );
});

test('a validation message naming a field is shown', () => {
  assert.equal(safeDetail('phone must be a valid number'), 'phone must be a valid number');
  assert.equal(safeDetail('endTime must be after startTime'), 'endTime must be after startTime');
});

test('it reaches the rep as a sentence', () => {
  assert.equal(
    rejectionMessage('appointment', 'the slot is not available').message,
    'Your CRM would not accept that appointment: The slot is not available'
  );
});

test('a camelCase field keeps its casing', () => {
  // "EndTime" matches nothing in the API or the UI, and the field name is
  // the one genuinely useful token in the sentence.
  assert.match(
    rejectionMessage('appointment', 'endTime must be after startTime').message,
    /endTime must be after startTime$/
  );
});

test('a trailing full stop is not doubled', () => {
  assert.doesNotMatch(rejectionMessage('deal', 'Value is too large.').message, /\.\.|\.$/);
});

// ── What a rep must NOT see ───────────────────────────────────────────

test('anything carrying a record id is suppressed', () => {
  // The original example, and the whole reason for the old blanket rule.
  assert.equal(safeDetail('Contact not found for id:88qfhZVULZ41Bl7BipOA'), null);
  assert.equal(safeDetail('No calendar with id BqTwX8QFwXzpegMve9EQ'), null);
});

test('a UUID is suppressed', () => {
  // Shorter than the id run above, and just as meaningless to a rep.
  assert.equal(
    safeDetail('Unknown record 3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    null
  );
});

test("somebody's email address is never broadcast", () => {
  // Not ours to put on a shared screen, whatever it explains.
  assert.equal(safeDetail('Duplicate contact for sam@example.com'), null);
});

test('a URL is suppressed', () => {
  assert.equal(safeDetail('See https://api.example.com/docs for details'), null);
});

test('developer output is suppressed', () => {
  // Object dumps and dotted field paths are not sentences.
  assert.equal(safeDetail('{"errors":["bad"]}'), null);
  assert.equal(safeDetail('body.appointment.startTime is required'), null);
});

test('a dump too long to be a sentence is suppressed', () => {
  assert.equal(safeDetail('x '.repeat(120)), null);
});

test('nothing at all falls back to the generic sentence', () => {
  assert.equal(safeDetail(''), null);
  assert.equal(safeDetail(null), null);
  assert.equal(safeDetail(undefined), null);
  assert.match(
    rejectionMessage('deal', null).message,
    /check the values and try again/
  );
});

// ── The earlier branches still win ────────────────────────────────────

test('"not found" still reads as gone, not as a reason to retry', () => {
  // Checked BEFORE the detail is shown: the next step is a reload, not a
  // corrected field, and that distinction is worth more than the wording.
  assert.match(
    rejectionMessage('task', 'Task not found').message,
    /no longer exists in your CRM/
  );
});

test('an unrecognised id still gets its own message', () => {
  // "The task id is invalid." would pass the safety test — no id in the
  // text — but it must not be shown as a reason to check the values. The
  // app has already removed the row by the time this is read.
  assert.match(
    rejectionMessage('task', 'The task id is invalid.').message,
    /removed from your list/
  );
});

test('a refused delete still does not say "check the values"', () => {
  // There are no values on a confirm dialog to check.
  const m = rejectionMessage('task', null, { action: 'delete' }).message;
  assert.match(m, /removed in the CRM itself/);
  assert.doesNotMatch(m, /check the values/);
});

test('a refused delete WITH a reason gives the reason', () => {
  assert.equal(
    rejectionMessage('task', 'This task is locked').message
      !== rejectionMessage('task', 'This task is locked', { action: 'delete' }).message,
    true,
    'the verb should follow the action'
  );
  assert.match(
    rejectionMessage('task', 'This task is locked', { action: 'delete' }).message,
    /would not delete that task: This task is locked/
  );
});


// ── Which refusals the override can get past ─────────────────────────
//
// Decides whether the booking card offers "Book it anyway". A false
// positive is the expensive mistake: the retry fails identically and the
// button learns to be ignored.

test('a taken slot is overridable — the production message', () => {
  assert.equal(isSlotUnavailable('The slot you have selected is no longer available'), true);
  assert.equal(isSlotUnavailable('This slot is not available'), true);
});

test('the calendar\'s own hours and notice period are overridable', () => {
  assert.equal(isSlotUnavailable('The slot is outside the working hours'), true);
  assert.equal(isSlotUnavailable('Booking violates minimum scheduling notice'), true);
});

test('validation failures are NOT overridable', () => {
  for (const d of [
    'contactId must be a string',
    'Calendar not found',
    'Contact not found for id:88qfhZVULZ41Bl7BipOA',
    'startTime must be a valid ISO 8601 date string'
  ]) {
    assert.equal(isSlotUnavailable(d), false, d);
  }
});

test('nothing is overridable by default', () => {
  for (const d of ['', null, undefined, 42, {}]) {
    assert.equal(isSlotUnavailable(d), false, String(d));
  }
});

test('the calendar-team refusal is said in plain words', () => {
  const m = rejectionMessage('appointment', 'The user id not part of calendar team');
  assert.match(m.message, /isn't on this calendar's team/);
  assert.equal(translateKnown('something else entirely'), null);
});
