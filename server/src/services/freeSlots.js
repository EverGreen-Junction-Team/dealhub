// Reading GHL's free-slots answer.
//
// GET /calendars/{id}/free-slots (verified against the v3 docs, 25 Nov 2026):
// startDate/endDate are epoch MILLISECONDS, endDate exclusive, at most 31
// days apart; the body is "keyed by date (YYYY-MM-DD)" with a `slots` array
// of ISO 8601 times under each, and "dates with no free slots are left out".
// The docs show no full example body, so this reads it tolerantly: any
// date-shaped key whose value carries a `slots` array, ignoring anything
// else (traceId, etc.).
//
// Why the booking card wants this at all: on the live board GHL refused a
// visibly EMPTY slot with "the slot you have selected is no longer
// available" — the calendar's own hours and interval, invisible from our
// grid. Asking first lets the card say so BEFORE Save, and offer the times
// GHL will actually accept.

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** All free slot times in the answer, as ISO strings, sorted. */
export function pickSlots(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(data)) {
    if (!DATE_KEY.test(key)) continue;
    const slots = value && Array.isArray(value.slots) ? value.slots : [];
    for (const s of slots) if (typeof s === 'string' && !Number.isNaN(Date.parse(s))) out.push(s);
  }
  return out.sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** Validate and convert the window the card asks about. */
export function slotWindow(from, to) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // The docs cap a call at 31 days; the card only ever asks about one.
  if (end - start > 31 * 24 * 3600 * 1000) return null;
  return { startDate: start, endDate: end };
}
