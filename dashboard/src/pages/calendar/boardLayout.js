import {
  minutesFromMidnight, durationMinutes, dayKey, SNAP_MINUTES
} from '../../utils/calendarTime.js'

// The arithmetic behind the board, with no React in it.
//
// Separated from the component on purpose: this is the part that is easy to
// get subtly wrong and impossible to eyeball. A card one lane too far left,
// or a drop that lands fifteen minutes early, looks entirely plausible on
// screen — so it is tested directly instead (see __tests__/boardLayout).

// The visible day. Not 00:00–24:00: two thirds of that is empty for every
// sub-account here, and the hours people actually work get squeezed into a
// third of the screen as a result. A card outside this range is not hidden —
// see clampToWindow.
export const DAY_START_MIN = 7 * 60   // 07:00
export const DAY_END_MIN = 20 * 60    // 20:00
export const PIXELS_PER_MINUTE = 1.1  // ~72px an hour: a 30-minute booking is still readable

export function boardHeightPx() {
  return (DAY_END_MIN - DAY_START_MIN) * PIXELS_PER_MINUTE
}

/** The hour lines down the left-hand gutter. */
export function hourMarks() {
  const out = []
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 60) {
    out.push({
      minutes: m,
      label: `${String(Math.floor(m / 60)).padStart(2, '0')}:00`,
      top: (m - DAY_START_MIN) * PIXELS_PER_MINUTE
    })
  }
  return out
}

/**
 * Where a card sits vertically, in pixels.
 *
 * Clamped to the visible window rather than allowed to run off the top or
 * bottom. An appointment at 06:00 on a board that starts at 07:00 is still
 * REAL, and dropping it would be the worst thing this file could do — a
 * dispatcher would see a free morning that is not free. So it is pinned to
 * the edge and flagged, and the card says it starts earlier than the board
 * shows.
 */
export function clampToWindow(startMin, endMin) {
  const visibleStart = Math.max(startMin, DAY_START_MIN)
  const visibleEnd = Math.min(endMin, DAY_END_MIN)
  // Wholly outside the window in one direction or the other. Still drawn, as
  // a sliver at the edge it overflows towards, because "nothing here" is a
  // lie about somebody's day.
  const clippedBefore = startMin < DAY_START_MIN
  const clippedAfter = endMin > DAY_END_MIN
  const top = (visibleStart - DAY_START_MIN) * PIXELS_PER_MINUTE
  // A minimum height so a short or heavily clipped booking stays clickable.
  // 18px is about the smallest target a mouse can reliably grab.
  const height = Math.max((visibleEnd - visibleStart) * PIXELS_PER_MINUTE, 18)
  return { top, height, clippedBefore, clippedAfter }
}

/**
 * Side-by-side placement for appointments that overlap in one column.
 *
 * THE PROBLEM. Two bookings at the same time in the same person's column
 * would be drawn on top of each other — the later one hiding the earlier,
 * which is precisely the double-booking a dispatcher is looking for. The
 * clash has to be the most visible thing on the board, not the least.
 *
 * THE APPROACH. Greedy lane assignment over the appointments sorted by
 * start: each one takes the first lane whose previous occupant has already
 * finished. Lanes are then shared out across the column's width.
 *
 * Width is computed per OVERLAP GROUP, not per column. If a column has one
 * clash at 9am and nothing else all day, only the 9am pair is narrowed —
 * dividing the whole column by two because of one overlap would waste half
 * the board for the sake of ten minutes.
 *
 * @param {Array} items appointments, each with startsAt / endsAt
 * @param {string} zone the board's axis zone
 * @returns the same items with { lane, lanes } attached
 */
export function assignLanes(items, zone) {
  const sorted = [...items].sort((a, b) => {
    const am = minutesFromMidnight(a.startsAt, zone)
    const bm = minutesFromMidnight(b.startsAt, zone)
    if (am !== bm) return am - bm
    // Stable beyond the start time, so the board does not reshuffle itself
    // between renders when two things begin at once.
    return String(a.id).localeCompare(String(b.id))
  })

  const placed = []
  // The running set of appointments that overlap the one being placed.
  let group = []
  let groupEnd = -Infinity

  const flush = () => {
    // Everyone in a group shares the group's lane count, so a pair of
    // overlapping bookings is two half-width cards rather than one half and
    // one full.
    const lanes = group.reduce((max, p) => Math.max(max, p.lane + 1), 0)
    for (const p of group) p.lanes = lanes
    group = []
  }

  for (const item of sorted) {
    const startMin = minutesFromMidnight(item.startsAt, zone)
    const endMin = startMin + durationMinutes(item.startsAt, item.endsAt)

    // A gap: nothing currently open overlaps this one, so the previous group
    // is closed and this starts a new one.
    if (startMin >= groupEnd && group.length) flush()

    // First free lane — the first whose occupant has finished by now.
    const laneEnds = []
    for (const p of group) laneEnds[p.lane] = Math.max(laneEnds[p.lane] ?? -Infinity, p.endMin)
    let lane = 0
    while (laneEnds[lane] !== undefined && laneEnds[lane] > startMin) lane++

    const entry = { ...item, startMin, endMin, lane, lanes: 1 }
    group.push(entry)
    placed.push(entry)
    groupEnd = Math.max(groupEnd, endMin)
  }
  if (group.length) flush()

  return placed
}

/**
 * Group a window's appointments into the board's cells.
 *
 * A cell is one (day, person) pair — one column of one day. Returned as a
 * Map keyed `day|userId` so the component can look up a column without
 * filtering the whole list for every cell it draws.
 *
 * UNASSIGNED IS A REAL COLUMN, not a filtered-out state. An appointment with
 * nobody on it is the one most likely to be missed, so it gets a column of
 * its own at the end rather than being invisible until someone thinks to
 * look for it.
 */
export const UNASSIGNED = '__unassigned__'

export function groupIntoCells(appointments, zone) {
  const cells = new Map()
  for (const a of appointments) {
    if (!a.startsAt) continue
    const key = `${dayKey(a.startsAt, zone)}|${a.assignedUserId || UNASSIGNED}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(a)
  }
  for (const [key, items] of cells) cells.set(key, assignLanes(items, zone))
  return cells
}

export function cellKey(day, userId) {
  return `${day}|${userId || UNASSIGNED}`
}

/**
 * Where a drop landed, as minutes from midnight.
 *
 * SNAPPED, because a dispatcher dragging a card is expressing "about ten
 * o'clock", not 09:58. An unsnapped board produces appointment times like
 * 14:07 that nobody chose and everybody then has to tidy up.
 *
 * `grabOffsetPx` is where within the card the pointer took hold. Without it
 * the card jumps so its TOP is under the cursor, which means grabbing a
 * booking by its middle silently moves it half an hour earlier — the single
 * most common way a drag-to-reschedule feels broken.
 */
export function minutesForDrop(offsetYPx, grabOffsetPx = 0) {
  const raw = DAY_START_MIN + (offsetYPx - grabOffsetPx) / PIXELS_PER_MINUTE
  const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES
  // Never before the board's own start: a card cannot be dropped into a time
  // the grid does not show, because the rep could not have meant it.
  return Math.max(DAY_START_MIN, Math.min(snapped, DAY_END_MIN - SNAP_MINUTES))
}

/**
 * Is this move actually a change?
 *
 * Guards the write. A click that the browser reports as a one-pixel drag, or
 * a card dropped back where it came from, must not become a PUT to GHL — on
 * a board that is a lot of pointless writes, and each one risks a customer
 * notification if that is ever switched on.
 */
export function isRealMove(appointment, { day, minutes, userId }, zone) {
  const sameDay = dayKey(appointment.startsAt, zone) === day
  const sameTime = minutesFromMidnight(appointment.startsAt, zone) === minutes
  const samePerson = (appointment.assignedUserId || UNASSIGNED) === (userId || UNASSIGNED)
  return !(sameDay && sameTime && samePerson)
}

/**
 * The patch a move sends — only the fields that actually changed.
 *
 * A reassignment must not rewrite the times, and a reschedule must not
 * restate the owner. Sending the unchanged rest is how a stale copy held in
 * the browser overwrites an edit somebody else made thirty seconds ago.
 */
export function movePatch(appointment, target, zone, isoForSlot) {
  const patch = {}
  const movedInTime =
    dayKey(appointment.startsAt, zone) !== target.day ||
    minutesFromMidnight(appointment.startsAt, zone) !== target.minutes
  if (movedInTime) {
    const mins = durationMinutes(appointment.startsAt, appointment.endsAt)
    Object.assign(patch, isoForSlot(target.day, target.minutes, mins, zone))
  }
  if ((appointment.assignedUserId || null) !== (target.userId || null)) {
    patch.assignedUserId = target.userId || null
  }
  return patch
}

// ── TIME VIEWS: grouped by DAY, with nobody in the key ────────────────
//
// The resource board's cells are (day, person) — one column per person,
// repeated per day. A day or week view is the other shape: one column per
// DAY, holding everyone's appointments together.
//
// Same lane packing underneath, which matters more here than on the board.
// A week column carries every rep's bookings at once, so overlaps are the
// normal case rather than the exception — four people out at 10am is four
// cards abreast, not a stack with three hidden.
export function groupByDay(appointments, zone) {
  const cells = new Map()
  for (const a of appointments) {
    if (!a.startsAt) continue
    const key = dayKey(a.startsAt, zone)
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(a)
  }
  for (const [key, items] of cells) cells.set(key, assignLanes(items, zone))
  return cells
}

// A month's worth of weeks, as rows of seven 'YYYY-MM-DD' keys.
//
// Always whole weeks, so the grid is rectangular: the first row reaches back
// into the previous month and the last reaches into the next. Those days are
// real and may hold appointments — a survey on the 1st is visible from
// October's grid, which is what anybody looking at a month boundary wants.
export function monthWeeks(anyDayInMonth, weekStartsOn = 1) {
  const first = anyDayInMonth.startOf('month')
  const last = anyDayInMonth.endOf('month')
  // dayjs: 0 = Sunday. Shift so the configured first day of the week lands
  // at index 0, then walk back to it.
  const lead = (first.day() - weekStartsOn + 7) % 7
  let cursor = first.subtract(lead, 'day')

  const weeks = []
  // Six rows at most — the longest any month can span — and we stop as soon
  // as the month is behind us, so most months draw five.
  for (let w = 0; w < 6; w++) {
    const row = []
    for (let d = 0; d < 7; d++) {
      row.push(cursor.format('YYYY-MM-DD'))
      cursor = cursor.add(1, 'day')
    }
    weeks.push(row)
    if (cursor.isAfter(last, 'day')) break
  }
  return weeks
}
