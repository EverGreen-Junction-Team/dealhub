// ghlRejection.js — one way to turn a GHL 400/422 into something a rep can read.
//
// GHL's own message used to be pasted straight into the banner, on the
// reasoning that it names the offending field where a message we invent would
// not. That holds for a validation error ("phone must be a valid number").
// It does not hold for everything else:
//
//   "Contact not found for id:88qfhZVULZ41Bl7BipOA"
//
// A sales rep shown a raw record id has been told nothing they can act on,
// and the whole team sees these banners. So the rule is: the diagnostic goes
// to the LOG, the rep gets a sentence.
//
// The one thing worth distinguishing is "not found" — the record is gone from
// the CRM, which is a different situation from a bad value and needs a
// different next step (reload, not fix-the-field). Everything else collapses
// into one honest sentence.
//
// `detail` is attached to the error for the route layer, which may log it; it
// is NEVER part of `message`.

import { logger } from '../utils/logger.js';

// The text GHL sent, from whichever shape it used.
export function ghlDetail(body) {
  return body?.message
    || body?.error
    || (Array.isArray(body?.errors) ? body.errors.join('; ') : null)
    || null;
}

// Does this read as "the record is gone"?
export function looksMissing(detail) {
  return /not\s*found|does\s*not\s*exist|no\s*such/i.test(detail || '');
}

/**
 * Build the user-facing message for a rejected write.
 *
 * ── WHY `action` EXISTS ──────────────────────────────────────────────
 *
 * The one message used to be "check the values and try again", whatever had
 * been attempted. On an edit that is sound advice. On a DELETE it is
 * nonsense — there are no values to check — and it was being shown in a
 * confirm dialog whose only remaining button said "Delete task", so the rep
 * was told to correct fields they could not see on a form that did not
 * exist. Pressing the button again produced the same refusal.
 *
 * We still never show GHL's own text (see logRejection): it names a field
 * for a validation error but a bare record id for a missing one, and the
 * whole sales team reads these. So the copy cannot say WHY. What it can do
 * is stop giving advice that does not apply, and point somewhere that can
 * actually resolve it.
 *
 * @param {string} noun     what the rep was working on — 'task', 'deal'…
 * @param {string} detail   GHL's own message, used only to detect "missing"
 * @param {object} [opts]
 * @param {string} [opts.action]  'change' (default) or 'delete'
 * @returns {{ message: string, status: number, missing: boolean }}
 */
export function rejectionMessage(noun, detail, { action = 'change' } = {}) {
  const missing = looksMissing(detail);
  if (missing) {
    return {
      missing,
      status: 404,
      message: `That ${noun} no longer exists in your CRM — it may have been deleted`
    };
  }
  return {
    missing,
    status: 422,
    message: action === 'delete'
      // No "check the values": there are none. The CRM is where a refusal
      // like this can be seen and acted on, so that is where it points.
      ? `Your CRM would not delete that ${noun} — it may need to be removed in the CRM itself`
      : 'Your CRM would not accept that change — check the values and try again'
  };
}

/**
 * Log the rejection with everything we know. Called before throwing, so the
 * diagnostic survives even though the rep never sees it.
 */
export function logRejection(where, { status, id, detail, body }) {
  logger.warn({ status, id, detail, body }, `${where}: rejected by the CRM`);
}
