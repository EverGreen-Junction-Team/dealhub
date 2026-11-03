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
 * @param {string} noun  what the rep was editing — 'contact', 'deal', 'note'…
 * @returns {{ message: string, status: number, missing: boolean }}
 */
export function rejectionMessage(noun, detail) {
  const missing = looksMissing(detail);
  return {
    missing,
    status: missing ? 404 : 422,
    message: missing
      ? `That ${noun} no longer exists in your CRM — it may have been deleted`
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
