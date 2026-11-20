// The arithmetic the operations board is drawn from.
//
// WHY THIS IS TESTED AND THE COMPONENT IS NOT. Every bug in this file looks
// plausible on screen. A card one lane too far left, a drop that lands
// fifteen minutes early, an overlap drawn as a single card — none of them
// render as anything obviously broken, and all of them are wrong about
// somebody's working day. The geometry is therefore kept free of React so it
// can be checked directly, which is the only way these get caught.
//
// Two of them would be real operational failures rather than cosmetic ones:
//
//   * an overlap drawn as ONE card hides a double-booking, which is exactly
//     the thing a dispatcher opens this board to find;
//   * an appointment before the board's first hour vanishing would show a
//     free morning that is not free.
import assert from 'node:assert/strict'
import {
  assignLanes, clampToWindow, minutesForDrop, isRealMove, movePatch,
  groupIntoCells, cellKey, hourMarks,
  DAY_START_MIN, DAY_END_MIN, PIXELS_PER_MINUTE
} from '../boardLayout.js'
import {
  boardZone, isUsableZone, minutesFromMidnight, durationMinutes,
  isoForSlot, zoneNote, dayKey, FALLBACK_ZONE, DEFAULT_SLOT_MINUTES
} from '../../../utils/calendarTime.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }

// A fixed zone with a non-zero offset, so a test that accidentally works in
// UTC does not pass by coincidence. Madrid is UTC+1 in winter.
const ZONE = 'Europe/Madrid'
// 2026-11-17 is a Tuesday, safely inside standard time for both zones used.
const at = (hhmm) => `2026-11-17T${hhmm}:00+01:00`

const appt = (id, start, end, userId = 'u1') => ({
  id, startsAt: start, endsAt: end, assignedUserId: userId
})

console.log('timezone — the axis the whole board hangs off')

t('an unreadable zone falls back rather than throwing', () => {
  // The zone arrives from GHL as an unvalidated string. dayjs.tz throws a
  // RangeError on a bad one, and inside a render that takes down the entire
  // board rather than one card.
  assert.equal(isUsableZone('Europe/Madrid'), true)
  assert.equal(isUsableZone('Mars/Olympus_Mons'), false)
  assert.equal(isUsableZone(null), false)
  assert.equal(isUsableZone(''), false)
  assert.equal(boardZone('Mars/Olympus_Mons'), FALLBACK_ZONE)
  assert.equal(boardZone(null), FALLBACK_ZONE)
  assert.equal(boardZone('Europe/Madrid'), 'Europe/Madrid')
})

t('the fallback is UTC, not a plausible guess', () => {
  // Deliberate. Guessing Europe/London would be right in winter and an hour
  // out for eight months — silently. UTC is obviously not local, so a rep
  // seeing 13:00 for a 2pm survey notices.
  assert.equal(FALLBACK_ZONE, 'UTC')
})

t('a time is read in the board zone, not the machine zone', () => {
  // The assertion that actually pins the rule. 09:00+01:00 is 08:00 UTC; on
  // a Madrid board it must be 540 minutes (09:00), and on a UTC board 480.
  // If this file ever starts using the host clock, these diverge.
  assert.equal(minutesFromMidnight(at('09:00'), 'Europe/Madrid'), 9 * 60)
  assert.equal(minutesFromMidnight(at('09:00'), 'UTC'), 8 * 60)
})

t('the day an appointment falls on is the board zone day', () => {
  // 00:30+01:00 is still 23:30 the previous day in UTC. A board that
  // disagreed with itself about which day this is would draw it in the
  // wrong column entirely.
  assert.equal(dayKey('2026-11-17T00:30:00+01:00', 'Europe/Madrid'), '2026-11-17')
  assert.equal(dayKey('2026-11-17T00:30:00+01:00', 'UTC'), '2026-11-16')
})

t('a slot is sent with its offset', () => {
  // GHL interprets an offset-less string against the calendar's own zone,
  // which is usually — but not always — the one the rep was looking at.
  // Sending the offset removes the ambiguity entirely.
  const { startTime, endTime } = isoForSlot('2026-11-17', 10 * 60, 60, ZONE)
  assert.match(startTime, /^2026-11-17T10:00:00[+-]\d{2}:\d{2}$/)
  assert.match(endTime, /^2026-11-17T11:00:00[+-]\d{2}:\d{2}$/)
  // And it round-trips to the same instant the board was showing.
  assert.equal(minutesFromMidnight(startTime, ZONE), 600)
})

t('a zero-length appointment still gets a height', () => {
  // Not hypothetical: GHL's own documented example payload has endTime equal
  // to startTime. A card with no height cannot be seen or grabbed.
  assert.equal(durationMinutes(at('09:00'), at('09:00')), DEFAULT_SLOT_MINUTES)
  assert.equal(durationMinutes(at('09:00'), null), DEFAULT_SLOT_MINUTES)
  assert.equal(durationMinutes(at('09:00'), at('10:30')), 90)
})

t('a differing calendar zone is flagged, a matching one is silent', () => {
  assert.equal(zoneNote('Europe/Madrid', 'Europe/Madrid'), null)
  assert.equal(zoneNote(null, 'Europe/Madrid'), null)
  assert.equal(zoneNote('Europe/London', 'Europe/Madrid'), 'Europe/London')
  // An unusable zone is not a note — it is nothing we can say anything about.
  assert.equal(zoneNote('Nowhere/Nothing', 'Europe/Madrid'), null)
})

console.log('overlaps — the clash has to be the visible thing')

t('two overlapping bookings are drawn side by side', () => {
  const placed = assignLanes([
    appt('a', at('09:00'), at('10:00')),
    appt('b', at('09:30'), at('10:30'))
  ], ZONE)
  const a = placed.find((p) => p.id === 'a')
  const b = placed.find((p) => p.id === 'b')
  assert.equal(a.lane, 0)
  assert.equal(b.lane, 1)
  // Both must know the group is two wide, or one renders full width over the
  // other and the double-booking disappears.
  assert.equal(a.lanes, 2)
  assert.equal(b.lanes, 2)
})

t('bookings that merely touch do not overlap', () => {
  // 09:00–10:00 and 10:00–11:00 are back to back, not a clash. Treating them
  // as one would halve the width of every tidy day.
  const placed = assignLanes([
    appt('a', at('09:00'), at('10:00')),
    appt('b', at('10:00'), at('11:00'))
  ], ZONE)
  assert.deepEqual(placed.map((p) => p.lane), [0, 0])
  assert.deepEqual(placed.map((p) => p.lanes), [1, 1])
})

t('one clash does not narrow the rest of the day', () => {
  // Width is per overlap GROUP, not per column. Dividing the whole column by
  // two because of one 9am clash wastes half the board all day.
  const placed = assignLanes([
    appt('a', at('09:00'), at('10:00')),
    appt('b', at('09:30'), at('10:30')),
    appt('c', at('15:00'), at('16:00'))
  ], ZONE)
  assert.equal(placed.find((p) => p.id === 'c').lanes, 1)
  assert.equal(placed.find((p) => p.id === 'a').lanes, 2)
})

t('three at once get three lanes', () => {
  const placed = assignLanes([
    appt('a', at('09:00'), at('11:00')),
    appt('b', at('09:15'), at('10:00')),
    appt('c', at('09:30'), at('10:15'))
  ], ZONE)
  assert.deepEqual(placed.map((p) => p.lane).sort(), [0, 1, 2])
  for (const p of placed) assert.equal(p.lanes, 3)
})

t('a freed lane is reused', () => {
  // b ends before c starts, so c takes b's lane rather than opening a third
  // and making every card a third as wide.
  const placed = assignLanes([
    appt('a', at('09:00'), at('12:00')),
    appt('b', at('09:00'), at('10:00')),
    appt('c', at('10:00'), at('11:00'))
  ], ZONE)
  assert.equal(placed.find((p) => p.id === 'c').lane, 1)
  assert.equal(placed.find((p) => p.id === 'c').lanes, 2)
})

t('ordering is stable when two start at the same minute', () => {
  // Otherwise the board reshuffles itself between renders and a card moves
  // under the cursor mid-drag.
  const once = assignLanes([
    appt('zzz', at('09:00'), at('10:00')),
    appt('aaa', at('09:00'), at('10:00'))
  ], ZONE)
  const again = assignLanes([
    appt('aaa', at('09:00'), at('10:00')),
    appt('zzz', at('09:00'), at('10:00'))
  ], ZONE)
  assert.deepEqual(
    once.map((p) => [p.id, p.lane]),
    again.map((p) => [p.id, p.lane])
  )
})

console.log('the visible window — nothing may be silently dropped')

t('an appointment before the first hour is pinned and flagged', () => {
  // THE IMPORTANT ONE. A 06:00 start on a board that opens at 07:00 must not
  // vanish: a dispatcher would read the morning as free.
  const geo = clampToWindow(6 * 60, 8 * 60)
  assert.equal(geo.top, 0)
  assert.equal(geo.clippedBefore, true)
  assert.ok(geo.height > 0)
})

t('an appointment running past the last hour is flagged, not truncated away', () => {
  const geo = clampToWindow(19 * 60, 22 * 60)
  assert.equal(geo.clippedAfter, true)
  assert.ok(geo.height > 0)
  assert.ok(geo.top + geo.height <= (DAY_END_MIN - DAY_START_MIN) * PIXELS_PER_MINUTE + 1)
})

t('a very short booking keeps a grabbable height', () => {
  const geo = clampToWindow(9 * 60, 9 * 60 + 5)
  assert.ok(geo.height >= 18, 'a 5-minute card has to stay clickable')
})

t('an ordinary booking sits where the arithmetic says', () => {
  const geo = clampToWindow(9 * 60, 10 * 60)
  assert.equal(geo.top, (9 * 60 - DAY_START_MIN) * PIXELS_PER_MINUTE)
  assert.equal(geo.height, 60 * PIXELS_PER_MINUTE)
  assert.equal(geo.clippedBefore, false)
  assert.equal(geo.clippedAfter, false)
})

t('the gutter marks every hour of the window, inclusive', () => {
  const marks = hourMarks()
  assert.equal(marks[0].minutes, DAY_START_MIN)
  assert.equal(marks.at(-1).minutes, DAY_END_MIN)
  assert.equal(marks[0].label, '07:00')
  assert.equal(marks[0].top, 0)
})

console.log('drops — where the rep meant, not where the pixel was')

t('a drop snaps to the quarter hour', () => {
  // A dispatcher dragging a card means "about ten", not 09:58. An unsnapped
  // board produces times nobody chose and everyone then tidies up.
  const mins = minutesForDrop((10 * 60 - DAY_START_MIN) * PIXELS_PER_MINUTE + 3)
  assert.equal(mins % 15, 0)
  assert.equal(mins, 600)
})

t('where the card was grabbed is honoured', () => {
  // Without this, grabbing a booking by its middle silently moves it half an
  // hour earlier — the single most common way drag-to-reschedule feels broken.
  const y = (11 * 60 - DAY_START_MIN) * PIXELS_PER_MINUTE
  const grabbedAtTop = minutesForDrop(y, 0)
  const grabbedMidCard = minutesForDrop(y + 30 * PIXELS_PER_MINUTE, 30 * PIXELS_PER_MINUTE)
  assert.equal(grabbedAtTop, grabbedMidCard)
})

t('a drop above the board cannot land before it opens', () => {
  assert.equal(minutesForDrop(-500), DAY_START_MIN)
})

t('a drop below the board stays inside it', () => {
  assert.ok(minutesForDrop(99999) < DAY_END_MIN)
})

console.log('writes — only what changed, and only when something did')

t('a card put back where it came from is not a move', () => {
  // Guards the write. A click the browser reports as a one-pixel drag must
  // not become a PUT to GHL — and each pointless write is a chance to email
  // a customer if notifications are ever switched on.
  const a = appt('a', at('09:00'), at('10:00'), 'u1')
  assert.equal(
    isRealMove(a, { day: '2026-11-17', minutes: 540, userId: 'u1' }, ZONE),
    false
  )
})

t('a change of time, day or person all count as moves', () => {
  const a = appt('a', at('09:00'), at('10:00'), 'u1')
  assert.equal(isRealMove(a, { day: '2026-11-17', minutes: 600, userId: 'u1' }, ZONE), true)
  assert.equal(isRealMove(a, { day: '2026-11-18', minutes: 540, userId: 'u1' }, ZONE), true)
  assert.equal(isRealMove(a, { day: '2026-11-17', minutes: 540, userId: 'u2' }, ZONE), true)
})

t('a reassignment does not restate the times', () => {
  // Sending the unchanged rest is how a stale copy held in this browser
  // overwrites an edit somebody else made thirty seconds ago.
  const a = appt('a', at('09:00'), at('10:00'), 'u1')
  const patch = movePatch(
    a, { day: '2026-11-17', minutes: 540, userId: 'u2' }, ZONE, isoForSlot
  )
  assert.deepEqual(Object.keys(patch), ['assignedUserId'])
  assert.equal(patch.assignedUserId, 'u2')
})

t('a reschedule does not restate the owner', () => {
  const a = appt('a', at('09:00'), at('10:00'), 'u1')
  const patch = movePatch(
    a, { day: '2026-11-17', minutes: 600, userId: 'u1' }, ZONE, isoForSlot
  )
  assert.deepEqual(Object.keys(patch).sort(), ['endTime', 'startTime'])
  assert.ok(!('assignedUserId' in patch))
})

t('a reschedule keeps the appointment the same length', () => {
  // A 90-minute survey dragged to the morning is still 90 minutes. Resizing
  // it to the default would quietly shorten somebody's job.
  const a = appt('a', at('09:00'), at('10:30'), 'u1')
  const patch = movePatch(
    a, { day: '2026-11-17', minutes: 14 * 60, userId: 'u1' }, ZONE, isoForSlot
  )
  assert.equal(minutesFromMidnight(patch.startTime, ZONE), 14 * 60)
  assert.equal(minutesFromMidnight(patch.endTime, ZONE), 15 * 60 + 30)
})

t('dragging onto the unassigned column clears the owner', () => {
  const a = appt('a', at('09:00'), at('10:00'), 'u1')
  const patch = movePatch(
    a, { day: '2026-11-17', minutes: 540, userId: null }, ZONE, isoForSlot
  )
  assert.equal(patch.assignedUserId, null)
})

console.log('cells — one column of one day')

t('appointments land in their own person-and-day cell', () => {
  const cells = groupIntoCells([
    appt('a', at('09:00'), at('10:00'), 'u1'),
    appt('b', at('09:00'), at('10:00'), 'u2'),
    appt('c', '2026-11-18T09:00:00+01:00', '2026-11-18T10:00:00+01:00', 'u1')
  ], ZONE)
  assert.equal(cells.get(cellKey('2026-11-17', 'u1')).length, 1)
  assert.equal(cells.get(cellKey('2026-11-17', 'u2')).length, 1)
  assert.equal(cells.get(cellKey('2026-11-18', 'u1')).length, 1)
})

t('an unowned appointment gets its own column, not the bin', () => {
  // The one most likely to be missed, so it has to be visible — and being a
  // column means it can be dragged OUT of, which is how it stops being
  // unassigned.
  const cells = groupIntoCells([appt('a', at('09:00'), at('10:00'), null)], ZONE)
  assert.equal(cells.get(cellKey('2026-11-17', null)).length, 1)
})

t('an appointment with no start is skipped rather than crashing the board', () => {
  const cells = groupIntoCells([
    { id: 'x', startsAt: null, endsAt: null, assignedUserId: 'u1' },
    appt('a', at('09:00'), at('10:00'), 'u1')
  ], ZONE)
  assert.equal(cells.get(cellKey('2026-11-17', 'u1')).length, 1)
})

console.log(`\n${n} passed, 0 failed`)
