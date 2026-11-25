import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

// The one place the operations calendar decides what time it is.
//
// ── THE RULE ─────────────────────────────────────────────────────────
//
//   The board has ONE time axis, and that axis is the SUB-ACCOUNT's
//   timezone. Never the browser's.
//
// Everything else follows from that. An appointment is stored as an exact
// instant, so placing it on the board is a conversion, not a guess — but
// which zone to convert INTO is a decision, and making it here rather than
// at each call site is the whole point of this file. A calendar that is an
// hour out in one view and right in another is a bug nobody can reproduce
// from a screenshot.
//
// ── WHY NOT THE BROWSER ──────────────────────────────────────────────
//
// It is the obvious default and it is wrong. An office manager checking a
// rep's week does not want the day redrawn around their own clock, and a
// laptop still on last week's holiday time would shift every booking by two
// hours with nothing on screen to say so. The question a board answers is
// "what is this person's Tuesday", which is a fact about where the WORK is,
// not where the viewer is.
//
// ── WHY NOT PER-APPOINTMENT ──────────────────────────────────────────
//
// Each appointment carries its own calendar's zone, and a sub-account can
// have calendars in more than one. It is tempting to draw each card in its
// own zone — and it would be meaningless: a column of times that are not on
// the same scale is not a column. 9am above 10am would not imply one comes
// before the other.
//
// So the axis is one zone and every appointment is converted onto it. The
// card's own zone is still worth showing when it DIFFERS, because that is a
// real thing to know about a booking — see zoneNote below — but it never
// moves the card.

dayjs.extend(utc)
dayjs.extend(timezone)

// The last resort, and deliberately a visible one.
//
// If the sub-account's zone could not be read (the `locations.readonly`
// scope, usually) the board still has to draw. UTC is the honest fallback:
// it is obviously not Manchester, so a rep seeing 14:00 for a 2pm survey in
// summer notices something is off. Guessing Europe/London instead would be
// right most of the year and silently an hour out for eight months of it,
// which is the worse failure.
export const FALLBACK_ZONE = 'UTC'

/**
 * Is this a zone the browser actually understands?
 *
 * The zone comes from GHL as a string and nothing validates it there. An
 * unrecognised one makes dayjs.tz throw a RangeError, which — inside a
 * render — takes the whole board down rather than one card. Checked once
 * here so the caller gets a usable zone or the fallback, never an exception.
 */
export function isUsableZone(zone) {
  if (!zone || typeof zone !== 'string') return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The board's axis zone. Call this once per render and pass it down.
 */
export function boardZone(locationTimezone) {
  return isUsableZone(locationTimezone) ? locationTimezone : FALLBACK_ZONE
}

/** An instant, read in the board's zone. */
export function inZone(iso, zone) {
  return dayjs(iso).tz(isUsableZone(zone) ? zone : FALLBACK_ZONE)
}

/**
 * Minutes from midnight, in the board's zone.
 *
 * This is the number the grid is built on: a card's top edge and its height
 * both come from here, so if this is wrong the whole board is wrong in a way
 * that still looks plausible.
 */
export function minutesFromMidnight(iso, zone) {
  const d = inZone(iso, zone)
  return d.hour() * 60 + d.minute()
}

/** The calendar day an instant falls on, in the board's zone. 'YYYY-MM-DD'. */
export function dayKey(iso, zone) {
  return inZone(iso, zone).format('YYYY-MM-DD')
}

/** '09:30'. 24-hour, because a day grid has no room for am/pm. */
export function clockTime(iso, zone) {
  return inZone(iso, zone).format('HH:mm')
}

/** 'Tue 18 Nov' — the column-group heading on a week board. */
export function dayLabel(iso, zone) {
  return inZone(iso, zone).format('ddd D MMM')
}

/**
 * The note a card shows when its calendar sits in a different zone from the
 * board.
 *
 * Returns null when they agree, which is the overwhelming majority — so this
 * is an exception marker, not a label. When it does fire it matters: a
 * survey booked on a calendar in another zone is a real source of confusion
 * for whoever has to ring the customer about it, and the card saying
 * "booked 14:00 Europe/Madrid" is the difference between a question and a
 * missed appointment.
 */
export function zoneNote(appointmentZone, zone) {
  if (!appointmentZone || !isUsableZone(appointmentZone)) return null
  if (appointmentZone === zone) return null
  return appointmentZone
}

/**
 * Build the ISO strings a reschedule sends to GHL.
 *
 * WITH THE OFFSET, ALWAYS. GHL's appointment endpoints accept ISO 8601 and
 * interpret a string with no offset against the calendar's own zone — which
 * is usually, but not always, the one the rep was looking at. Sending the
 * offset removes the ambiguity entirely: the instant is the instant, and
 * neither end has to agree about zones for the move to land where the rep
 * dropped it.
 *
 * @param {string} day   'YYYY-MM-DD' in the board's zone
 * @param {number} mins  minutes from midnight in the board's zone
 * @param {number} durationMins
 * @param {string} zone  the board's zone
 */
export function isoForSlot(day, mins, durationMins, zone) {
  const z = isUsableZone(zone) ? zone : FALLBACK_ZONE
  const start = dayjs.tz(day, z).add(mins, 'minute')
  return {
    startTime: start.format(),
    endTime: start.add(durationMins, 'minute').format()
  }
}

// What an appointment with no usable end is drawn as, and the granularity a
// drag snaps to. 30 minutes because that is what the calendars in this
// account are set up in; it is one constant rather than a scattering of 30s
// so changing it is a one-line decision.
export const DEFAULT_SLOT_MINUTES = 30
export const SNAP_MINUTES = 15

// Declared ABOVE its first use on purpose. durationMinutes below only reads
// it when CALLED, by which time it is initialised — so this was never a
// runtime problem — but it is the same shape as one that is, and static
// analysis cannot tell the two apart. Moving it costs nothing and keeps
// no-use-before-define strict enough to catch the next real one.

/** How long an appointment runs, in minutes. */
export function durationMinutes(startsAt, endsAt) {
  if (!startsAt) return DEFAULT_SLOT_MINUTES
  if (!endsAt) return DEFAULT_SLOT_MINUTES
  const mins = dayjs(endsAt).diff(dayjs(startsAt), 'minute')
  // GHL's own example payload has endTime equal to startTime, so a
  // zero-length appointment is not hypothetical. A card with no height
  // cannot be seen or grabbed, so it gets the default instead — the board is
  // still telling the truth about WHEN it starts, which is what a zero-length
  // booking actually means.
  return mins > 0 ? mins : DEFAULT_SLOT_MINUTES
}

/**
 * Minutes from midnight RIGHT NOW, in the board's zone.
 *
 * Used for the now-line. In the board's zone rather than the browser's for
 * the same reason everything else here is: a dispatcher in another timezone
 * asking "where are we in this rep's day" means the rep's day.
 */
export function minutesNow(zone) {
  const d = dayjs().tz(isUsableZone(zone) ? zone : FALLBACK_ZONE)
  return d.hour() * 60 + d.minute()
}

/** Today's date key in the board's zone — 'YYYY-MM-DD'. */
export function dayKeyNow(zone) {
  return dayjs().tz(isUsableZone(zone) ? zone : FALLBACK_ZONE).format('YYYY-MM-DD')
}
