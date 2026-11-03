// Tests for businessesSync — the delete-reconciliation guard.
//
// Run: node src/services/__tests__/businessesSync.test.mjs
//
// Why this has a test at all: businesses have no webhooks, so the daily sync is
// the only thing that writes them, and its delete pass is a bulk UPDATE driven
// by whatever GHL happened to return. Two inputs turn that into a page-wipe:
//
//   • an empty list — NOT (id = ANY('{}')) matches EVERY row
//   • a truncated list — deactivates everything past the page cap
//
// Both are silent: the sync reports success, and the Businesses page is simply
// empty the next morning. Neither is visible in a code read, which is exactly
// why they're pinned here.

import { shouldReconcileDeletes } from '../businessesReconcile.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── The normal case ──────────────────────────────────────────────────
t('reconciles a complete non-empty list',
  shouldReconcileDeletes({ seenCount: 12, truncated: false }).reconcile === true);

t('a single business is still a valid list',
  shouldReconcileDeletes({ seenCount: 1, truncated: false }).reconcile === true);

// ── The page-wipe cases ──────────────────────────────────────────────
t('refuses to reconcile an empty list',
  shouldReconcileDeletes({ seenCount: 0, truncated: false }).reconcile === false);

t('refuses to reconcile a truncated list',
  shouldReconcileDeletes({ seenCount: 20000, truncated: true }).reconcile === false);

t('empty AND truncated is still refused',
  shouldReconcileDeletes({ seenCount: 0, truncated: true }).reconcile === false);

// ── The reason is what reaches the logs, so it has to be specific ────
t('empty list gives a reason naming the risk',
  /zero businesses/.test(shouldReconcileDeletes({ seenCount: 0, truncated: false }).reason));

t('truncated list gives a distinct reason',
  /truncated/.test(shouldReconcileDeletes({ seenCount: 5, truncated: true }).reason));

t('the safe path carries no reason',
  shouldReconcileDeletes({ seenCount: 3, truncated: false }).reason === null);

// ── Regression: truncated must win even with a plausible count ───────
// A full 200-page walk returns 20k ids — a count alone looks perfectly healthy.
// Only the truncated flag reveals the list is partial.
t('a large count does not override the truncated flag',
  shouldReconcileDeletes({ seenCount: 20000, truncated: true }).reconcile === false);

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
