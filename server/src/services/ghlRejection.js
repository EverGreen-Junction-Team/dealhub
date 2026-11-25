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

// Does this read as "that is not an id I recognise"?
//
// A DIFFERENT FAILURE FROM BOTH OF THE OTHERS, and it was being shown as the
// generic "check the values and try again" — which sent a rep hunting
// through a form whose fields were all perfectly valid.
//
// GHL answers `{"message":"The task id is invalid.","statusCode":400}` when
// the id does not even have the shape of one of its ids. It is not a
// validation error about the rep's input and it is not a deleted record: it
// means the id WE hold for that row is not one the CRM can act on, so no
// amount of retrying or correcting fields will ever work. The record has to
// be dealt with in the CRM, and somebody should find out how we came to
// store that id.
export function looksUnknownId(detail) {
  return /\bid\b[^.]{0,30}\b(is\s+)?(invalid|not\s+valid|malformed)\b/i.test(detail || '')
    || /invalid\s+(\w+\s+)?id\b/i.test(detail || '');
}

/**
 * Is GHL's own text safe to put in front of a rep?
 *
 * ── WHY THIS REPLACES "NEVER SHOW IT" ────────────────────────────────
 *
 * The old rule was absolute, and the reason given was a real one:
 *
 *   "Contact not found for id:88qfhZVULZ41Bl7BipOA"
 *
 * A sales rep shown a raw record id has been told nothing. But the rule
 * threw out the good messages with the bad, and the result was a banner
 * reading "check the values and try again" over a form whose values were
 * all fine — because what GHL had actually said was something like "The
 * slot is not available" or "endTime must be after startTime". Those are
 * the whole answer, and we were deleting them.
 *
 * So the test is not "did GHL write it" but "does it name anything the rep
 * should not see, or cannot act on". Anything carrying an id, a UUID, an
 * email, a URL, a field path or a stack is suppressed; a plain sentence
 * about what was wrong is shown.
 *
 * Deliberately strict. A false negative costs one generic banner, the one
 * we would have shown anyway. A false positive puts a database id, or
 * somebody else's email address, on a screen the whole team reads.
 */
export function safeDetail(detail) {
  const d = (detail || '').trim();
  if (!d) return null;
  // Long enough to be a dump rather than a sentence.
  if (d.length > 160) return null;
  // GHL ids are 20+ chars of mixed case with no spaces. Also catches
  // Mongo-style ids, JWTs and anything else opaque.
  if (/[A-Za-z0-9_-]{18,}/.test(d)) return null;
  // UUIDs, which are shorter than the run above but just as meaningless.
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(d)) return null;
  // Somebody's personal data. Never ours to broadcast, whatever it explains.
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(d)) return null;
  if (/https?:\/\//i.test(d)) return null;
  // A field path or an object dump is developer output, not a sentence.
  if (/[{}[\]]|\w+\.\w+\.\w+/.test(d)) return null;
  return d;
}

/**
 * Round a detail off into a sentence.
 *
 * GHL is inconsistent about capitals and full stops, and a banner that
 * sometimes ends in one and sometimes does not looks like a bug.
 */
function asSentence(d) {
  const t = d.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  // Leave a camelCase first word alone. GHL names the offending field in
  // its own casing — "endTime must be after startTime" — and capitalising
  // it to "EndTime" turns the one useful token in the sentence into
  // something that does not match anything in the API or the UI.
  const first = t.split(' ')[0] || '';
  if (/[A-Z]/.test(first.slice(1))) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
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
  // The id itself is not one the CRM recognises. Retrying cannot help and
  // there are no values to correct, so say so rather than implying either.
  if (looksUnknownId(detail)) {
    return {
      missing: false,
      status: 422,
      // Written to match what the app DOES about it: ghlTaskWrite clears
      // the local row on this exact signal, so by the time a rep reads
      // this, the record has already left their list. Telling them to go
      // and deal with it in the CRM would be sending them after something
      // that is no longer theirs to deal with.
      message: `That ${noun} no longer exists in your CRM — it has been `
        + `removed from your list`
    };
  }
  // GHL'S OWN REASON, WHEN IT IS ONE A REP CAN USE. This is the common
  // case for an appointment — "that slot is not available", "outside the
  // calendar's working hours" — and it is the entire answer. Replacing it
  // with "check the values" sent people looking through a form for a
  // problem that was never in the form.
  const safe = safeDetail(detail);
  if (safe) {
    return {
      missing,
      status: 422,
      message: `Your CRM would not ${action === 'delete' ? 'delete' : 'accept'} that `
        + `${noun}: ${asSentence(safe)}`
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

/**
 * Is this refusal one that `ignoreFreeSlotValidation` would get past?
 *
 * ── WHY THIS IS STRING MATCHING, AND WHY THAT IS NOT A SHORTCUT ──────
 *
 * GHL returns no error code for this. A 400 carrying "The slot you have
 * selected is no longer available" and a 400 carrying "contactId must be a
 * string" are the same status with the same shape, and only the prose tells
 * them apart. So the choice is not between matching prose and something
 * better — it is between matching prose HERE, once, in a pure function with
 * tests, or matching it in the dashboard where nobody would ever see it
 * again.
 *
 * ── WHY IT MATTERS THAT THIS IS CONSERVATIVE ─────────────────────────
 *
 * The answer decides whether a rep is offered a "Book it anyway" button.
 * Offering it on a refusal the override cannot fix means the second attempt
 * fails identically, which teaches people the button is decorative. Not
 * offering it on a slot clash just leaves them where they are today. So an
 * unrecognised refusal answers false, and a phrase is added here only once
 * it has actually been seen.
 *
 * Verified against the v3 docs (25 Nov 2026): ignoreFreeSlotValidation is
 * documented as "If true the time slot validation would be avoided for any
 * appointment creation (even the ignoreDateRange)" — so it covers both a
 * taken slot and a time outside the calendar's own hours and notice period.
 * It does NOT cover a malformed field, a missing contact or a bad calendar,
 * and none of those are matched below.
 */
const OVERRIDABLE = [
  // Seen in production, 25 Nov 2026, booking onto a taken slot.
  'no longer available',
  'slot is not available',
  'slot not available',
  // The calendar's own hours and its minimum scheduling notice. Both are
  // availability rules, and both are what the override exists for.
  'outside the working hours',
  'outside working hours',
  'minimum scheduling notice'
];

export function isSlotUnavailable(detail) {
  if (!detail || typeof detail !== 'string') return false;
  const d = detail.toLowerCase();
  return OVERRIDABLE.some((phrase) => d.includes(phrase));
}
