// tasksSync's fallback path — reach versus safety.
//
// Run: node --test src/services/__tests__/taskSweepReach.test.mjs
//
// ── WHAT WENT WRONG, SO IT CANNOT GO WRONG THE SAME WAY ──────────────
//
// tasksSync reported `deleted: 0` for ten consecutive nights while the table
// filled with tasks GHL refuses to act on.
//
// The cause was one expression. The per-contact fallback set
// `truncated: failed > 0 || contactIds.length >= MAX_CONTACTS_PER_RUN`, and
// `truncated` abandons the delete pass FOR THE WHOLE LOCATION. That path
// makes up to 1500 HTTP calls, 60ms apart, to an endpoint that rate-limits
// per location — so one transient failure anywhere in the sequence threw
// away the reconciliation for the other 1499 contacts. It never got a clean
// run.
//
// The flag was redundant as well as expensive: the delete is already
// confined to the covered contacts, and a contact we failed to reach is
// filtered out of that list, so its tasks are outside the UPDATE's WHERE
// clause and cannot be touched whatever the flag says.
//
// Two separate questions, and conflating them is what cost ten nights:
//
//   REACH   how much of the location did we see?      (reported)
//   SAFETY  which rows may we delete against?         (the covered list)
//
// Every test below pins one or the other.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackReach, looksCapped } from '../taskSweepReach.js';

// ── SAFETY ────────────────────────────────────────────────────────────

test('a contact we could not reach is not in the delete scope', () => {
  // The whole safety argument rests on this one line. If an unreachable
  // contact ever enters the covered list, its tasks are deleted on the
  // strength of a response that never arrived.
  const r = fallbackReach({ contactIds: ['a', 'b', 'c'], excluded: ['b'] });
  assert.deepEqual(r.contactIds, ['a', 'c']);
});

test('excluding every contact leaves an empty scope, not a wide one', () => {
  // reconcileDeletes refuses an empty scope. An empty array must NOT be
  // read as "no restriction" anywhere along the way.
  const r = fallbackReach({ contactIds: ['a', 'b'], excluded: ['a', 'b'] });
  assert.deepEqual(r.contactIds, []);
});

test('a Set and an array of exclusions behave identically', () => {
  const asSet = fallbackReach({ contactIds: ['a', 'b'], excluded: new Set(['a']) });
  const asArr = fallbackReach({ contactIds: ['a', 'b'], excluded: ['a'] });
  assert.deepEqual(asSet.contactIds, asArr.contactIds);
});

test('no exclusions covers everything', () => {
  const r = fallbackReach({ contactIds: ['a', 'b'], excluded: [] });
  assert.deepEqual(r.contactIds, ['a', 'b']);
});

// ── REACH ─────────────────────────────────────────────────────────────

test('failures no longer abandon the delete pass', () => {
  // THE REGRESSION TEST. If this ever goes back to true, the sweep stops
  // deleting anything on any night where one contact hiccups — and it will
  // report success while doing it.
  const r = fallbackReach({ contactIds: ['a', 'b', 'c'], excluded: ['b', 'c'] });
  assert.equal(r.truncated, false);
  assert.deepEqual(r.contactIds, ['a'], 'and it still deletes against what it reached');
});

test('a partial sweep still says it was partial', () => {
  // Not blocking the pass is not the same as pretending it was complete.
  const r = fallbackReach({ contactIds: ['a', 'b', 'c', 'd'], excluded: ['c', 'd'] });
  assert.equal(r.attempted, 4);
  assert.equal(r.covered, 2);
});

test('a run under the contact cap does not claim to be capped', () => {
  const r = fallbackReach({ contactIds: ['a'], excluded: [] });
  assert.equal(r.cappedAtLimit, false);
});

test('a run at the contact cap says so', () => {
  // Safe — contacts past the cap were never in the list, so they are never
  // in the delete scope — but worth reporting, because it means the
  // location has outgrown one run.
  const many = Array.from({ length: 1500 }, (_, i) => `c${i}`);
  const r = fallbackReach({ contactIds: many, excluded: [] });
  assert.equal(r.cappedAtLimit, true);
  assert.equal(r.truncated, false, 'the cap is reported, not acted on');
});

// ── The page-boundary guard ───────────────────────────────────────────

test('a task count on a page boundary is treated as possibly incomplete', () => {
  // GET /contacts/:id/tasks takes no limit or skip, so in principle it
  // returns everything. "In principle" is not enough to delete rows on: a
  // contact with exactly 20 is indistinguishable from one showing page one
  // of several, so it is left out of the delete scope.
  for (const n of [20, 25, 50, 100]) {
    assert.equal(looksCapped(n), true, `${n} should be treated as suspicious`);
  }
});

test('an ordinary task count is trusted', () => {
  for (const n of [0, 1, 7, 19, 21, 22, 99, 101]) {
    assert.equal(looksCapped(n), false, `${n} should be trusted`);
  }
});

test('22 tasks on one contact is trusted', () => {
  // The real case that started this: 22 "5th follow up" rows on one contact.
  // It must not be mistaken for a page boundary, or the one contact whose
  // tasks are actually wrong is the one contact never reconciled.
  assert.equal(looksCapped(22), false);
});
