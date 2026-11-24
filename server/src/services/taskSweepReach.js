// taskSweepReach.js — how much of a location the per-contact sweep saw, and
// which contacts it may delete against.
//
// Dependency-free (no db, no config, no logger) so the rule can be tested
// without a database or a full env — the same reason businessesReconcile.js
// is its own file. Importing tasksSync for these two functions pulls in the
// connection pool and fails on a missing DATABASE_URL.
//
// ── WHY THESE TWO QUESTIONS ARE SEPARATE ─────────────────────────────
//
//   REACH   how much of the location did we see?   reported; acted on by
//                                                  nobody
//   SAFETY  which rows may we delete against?      the covered list
//
// Conflating them cost ten nights of reconciliation. A single failed contact
// out of up to 1500 set a `truncated` flag that abandoned the delete pass
// for the entire location — when the covered list had already made that
// contact's tasks untouchable, so the flag bought nothing and cost
// everything.

// A ceiling on calls per run, so a location with a large contact base cannot
// turn the nightly job into an hours-long crawl. Reaching it is safe: a
// contact past the cap is not in the covered list, so it is not in the
// delete scope either.
export const MAX_CONTACTS_PER_RUN = 1500;

// Task counts that might be a page rather than a total.
//
// GET /contacts/{id}/tasks takes no limit or skip parameter and is not
// documented as paged, so in principle it returns everything. "In principle"
// is not good enough to delete rows on: if it silently caps at a page, every
// task past the cap looks deleted. A contact that comes back with EXACTLY a
// round page-sized number is indistinguishable from a capped one, so its
// tasks are still written and it is simply left out of the delete scope. The
// cost is a stale row on one unusual contact; the cost of being wrong the
// other way is losing their task list.
const SUSPICIOUS_COUNTS = new Set([20, 25, 50, 100]);

/**
 * Might this contact's task list be one page of several?
 *
 * Exported so the rule is pinned by a test rather than only by this comment.
 * It is deliberately conservative in one direction only: a false positive
 * leaves one contact's stale rows in place for a night, a false negative
 * deletes real tasks.
 */
export function looksCapped(count) {
  return SUSPICIOUS_COUNTS.has(count);
}

/**
 * Which contacts this sweep may delete against, and whether to say it was
 * partial.
 *
 * THE RULE THE TEN EMPTY NIGHTS CAME DOWN TO: reach and safety are separate
 * questions. `truncated` answers "should the delete pass be abandoned
 * entirely", and on this path the answer is always no — safety comes from
 * the covered list, not from refusing to act. A sweep that reached 3 of 1500
 * contacts may still delete against those 3.
 */
export function fallbackReach({ contactIds, excluded }) {
  const skip = excluded instanceof Set ? excluded : new Set(excluded || []);
  return {
    contactIds: contactIds.filter((id) => !skip.has(id)),
    truncated: false,
    attempted: contactIds.length,
    covered: contactIds.length - skip.size,
    cappedAtLimit: contactIds.length >= MAX_CONTACTS_PER_RUN
  };
}
