// businessesReconcile.js — the delete-reconciliation decision.
//
// Deliberately dependency-free (no db, no config, no logger) so it can be
// unit-tested without a database or a full env. The two unsafe cases it guards
// are both silent page-wipes; see the test file for why each is pinned.

/**
 * Whether this run's list is safe to reconcile deletes against.
 *
 * Exported for tests — the two unsafe cases both blank the page, and neither
 * is visible in a code read:
 *
 *   • truncated — a partial list would deactivate businesses that are fine.
 *   • empty — NOT (id = ANY('{}')) matches EVERY row, so one bad response
 *     ({} instead of {businesses:[…]}, or a renamed response key) deactivates
 *     the entire location. A location genuinely having zero businesses is
 *     indistinguishable from that here, so we decline to act on it: a stale
 *     row costs far less than an empty page.
 */
export function shouldReconcileDeletes({ seenCount, truncated }) {
  if (truncated) return { reconcile: false, reason: 'list truncated at page cap' };
  if (seenCount === 0) {
    return { reconcile: false, reason: 'GHL returned zero businesses — refusing to deactivate all' };
  }
  return { reconcile: true, reason: null };
}
