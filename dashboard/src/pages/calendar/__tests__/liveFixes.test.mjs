import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Fixes from walking the live board on 25 Nov 2026.

// ── A click at 14:20 booked 12:15 ────────────────────────────────────
// clientY - rect.top is in ZOOMED pixels; the grid's minutes are in layout
// pixels. Off by exactly the app zoom (735/860 = 0.85), and the drop path
// had the same maths — so drags rescheduled appointments in the CRM.

function withZoom(zoom, fn) {
  const saved = { document: globalThis.document, gcs: globalThis.getComputedStyle }
  globalThis.document = { documentElement: {} }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => String(zoom) })
  try { return fn() } finally {
    globalThis.document = saved.document
    globalThis.getComputedStyle = saved.gcs
  }
}

const { offsetY, appZoom } = await import('../pointer.js')
const { minutesForDrop, PIXELS_PER_MINUTE } = await import('../boardLayout.js')

test('offsetY undoes the zoom', () => {
  withZoom(0.85, () => {
    // An element whose top is at 100 (visual px); a pointer 85 visual px
    // below it is 100 LAYOUT px below it.
    const el = { getBoundingClientRect: () => ({ top: 100 }) }
    assert.equal(offsetY({ clientY: 185 }, el), 100)
  })
})

test('the live repro: a click at 14:20 lands at 14:15–14:30, not 12:15', () => {
  withZoom(0.85, () => {
    const meant = 14 * 60 + 20
    const visualOffset = meant * PIXELS_PER_MINUTE * 0.85
    const el = { getBoundingClientRect: () => ({ top: 0 }) }
    const got = minutesForDrop(offsetY({ clientY: visualOffset }, el))
    assert.ok(Math.abs(got - meant) <= 15, `got ${got} min, meant ${meant}`)
    // And the bug, for the record: without the division it was 2h early.
    const buggy = minutesForDrop(visualOffset)
    assert.ok(meant - buggy > 100, 'the test no longer reproduces the original fault')
  })
})

test('zoom 1, unset and garbage all mean no correction', () => {
  for (const z of [1, '', 'nonsense', 0, -2]) {
    withZoom(z, () => assert.equal(appZoom(), z === 1 ? 1 : 1))
  }
})

test('nothing on the board computes an offset from clientY by hand', () => {
  for (const f of ['TimeGrid.jsx', 'ResourceBoard.jsx', 'AppointmentCard.jsx']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.ok(!/clientY - rect\.top/.test(src), `${f} converts a pointer without the zoom`)
  }
})

// ── Rail names ────────────────────────────────────────────────────────

test('personal calendars are labelled by their owner', async () => {
  const src = readFileSync(new URL('../CalendarSidebar.jsx', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('const PERSONAL'), src.indexOf('function Row'))
  // Evaluate just the pure helper.
  const mod = await import('data:text/javascript,' + encodeURIComponent(fn.replace('export function', 'export function')))
  assert.deepEqual(mod.calendarLabel("Charlie Stoyle's Personal Calendar"), { label: 'Charlie Stoyle', tag: 'Personal' })
  assert.deepEqual(mod.calendarLabel('jaladanki srinivas’s Personal Calendar'), { label: 'jaladanki srinivas', tag: 'Personal' })
  assert.deepEqual(mod.calendarLabel('Schedule an Appointment'), { label: 'Schedule an Appointment', tag: null })
  assert.equal(mod.calendarLabel(null).label, 'Untitled calendar')
})

// ── Layout: nothing grows the page ───────────────────────────────────

const tab = readFileSync(new URL('../../tabs/CalendarTab.jsx', import.meta.url), 'utf8')

test('the rail and the people board are bounded to the window', () => {
  assert.match(tab, /maxHeight=\{`calc\(100vh \/ var\(--app-zoom\) - \$\{Math\.round\(stickyTop\) \+ 12\}px\)`\}/)
  assert.match(tab, /maxHeight=\{`calc\(100vh \/ var\(--app-zoom\) - \$\{Math\.round\(stickyTop\) \+ 20\}px\)`\}/)
})

test('the toolbar right group can wrap, so Book is never pushed off', () => {
  assert.match(tab, /flex: '1 1 auto', minWidth: 0,/)
})

test('a one-day span is titled as a date, not a range to itself', () => {
  assert.match(tab, /if \(view === 'day' \|\| span\.days === 1\) return span\.from\.format\('ddd D MMMM YYYY'\)/)
})

test('the mini-month does not band a whole month', () => {
  const mm = readFileSync(new URL('../MiniMonth.jsx', import.meta.url), 'utf8')
  assert.match(mm, /if \(!span \|\| span\.days > 7\) return out/)
})

test('the people board opens near now, and its labels sit below their lines', () => {
  const rb = readFileSync(new URL('../ResourceBoard.jsx', import.meta.url), 'utf8')
  assert.match(rb, /Math\.max\(nowMin - 60, DAY_START_MIN\)/)
  assert.match(rb, /top: m\.top \+ 3/)
  assert.ok(!/top: m\.top - 7/.test(rb), 'labels straddle their lines again')
})

// ── Second pass on the live board ────────────────────────────────────

test('the tab column can shrink, so a wide board cannot widen the page', () => {
  // Shell is a grid with an `auto` column; without this a 12-rep board
  // widened the page and pushed Book off the frame.
  assert.match(tab, /gridTemplateColumns: 'minmax\(0, 1fr\)'/)
})

test('the rail counts its padding inside its bound', () => {
  const rail = readFileSync(new URL('../CalendarSidebar.jsx', import.meta.url), 'utf8')
  assert.match(rail, /boxSizing: 'border-box',\s*\n\s*overflowX: 'hidden'/)
})

test('no "no timezone set" warning while the first load is in flight', () => {
  assert.match(tab, /\(view === 'month' \|\| \(!loading && data\.timezone == null\)\)/)
  assert.match(tab, /\{!loading && data\.timezone == null \? ' — this sub-account has no timezone set' : ''\}/)
})

test('"Busy only" says so when it falls back to everyone', () => {
  const rb = readFileSync(new URL('../ResourceBoard.jsx', import.meta.url), 'utf8')
  assert.match(rb, /const fellBack = hideEmpty && resources\.length > 0/)
  assert.match(rb, /showing everyone\./)
})

test('the month fills the window', () => {
  assert.match(tab, /height=\{`calc\(100vh \/ var\(--app-zoom\) - \$\{Math\.round\(stickyTop\) \+ 20\}px\)`\}/)
  const mg = readFileSync(new URL('../MonthGrid.jsx', import.meta.url), 'utf8')
  assert.match(mg, /flex: height \? '1 0 auto' : undefined/)
})

// ── The six-day slab ──────────────────────────────────────────────────

test('a days-long appointment is a bar across its days, not a slab', async () => {
  const { isLong, longSpan } = await import('../boardLayout.js')
  const week = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']
  const live = { startsAt: '2026-11-24T10:30:00Z', endsAt: '2026-11-30T11:00:00Z' }
  assert.equal(isLong(live), true)
  assert.deepEqual(longSpan(live, week, 'Europe/London'), { from: 1, to: 6, clippedStart: false, clippedEnd: true })
  assert.equal(isLong({ startsAt: '2026-11-24T23:00:00Z', endsAt: '2026-11-25T01:00:00Z' }), false, 'overnight is still timed')
  assert.equal(longSpan({ startsAt: '2026-12-02T09:00:00Z', endsAt: '2026-12-04T09:00:00Z' }, week, 'UTC'), null)
  const grid = readFileSync(new URL('../TimeGrid.jsx', import.meta.url), 'utf8')
  // The time columns get timed bookings plus each long one's half-hour
  // START MARKER — never the long appointment itself, which is the slab.
  const call = grid.slice(grid.indexOf('groupByDay(['), grid.indexOf('], zone)', grid.indexOf('groupByDay([')))
  assert.match(call, /\.\.\.timed,/)
  assert.match(call, /\.\.\.long\.map\(longStartPiece\)/)
  assert.match(call, /longEndPiece\(a, zone\)/)
  assert.ok(!/\.\.\.long[,\s\]]/.test(call), 'long appointments drawn as timed cards again')
})

test('the detail card says how long in words, and which day it ends', () => {
  const src = readFileSync(new URL('../AppointmentDetail.jsx', import.meta.url), 'utf8')
  assert.match(src, /humanDuration\(mins\)/)
  assert.match(src, /const multiDay = end && !end\.isSame\(start, 'day'\)/)
})

// ── Multi-day bookings on every view ──────────────────────────────────

test('the start marker is half an hour at the real start, and carries the whole', async () => {
  const { longStartPiece } = await import('../boardLayout.js')
  const live = { id: 'L', startsAt: '2026-11-24T10:30:00Z', endsAt: '2026-11-30T11:00:00Z' }
  const p = longStartPiece(live)
  assert.equal(p.startsAt, live.startsAt)
  assert.equal(p.endsAt, '2026-11-24T11:00:00.000Z')
  assert.equal(p.id, 'L', 'menu and deal must act on the real appointment')
  assert.equal(p._whole, live)
})

test('a marker can never be dragged, and acts on the whole appointment', () => {
  const card = readFileSync(new URL('../AppointmentCard.jsx', import.meta.url), 'utf8')
  assert.match(card, /const draggable = !isBlocked && !busy && !isPiece/,
    'a dropped marker would re-time the real booking to 30 minutes')
  assert.ok(!/onSetStatus\(a, /.test(card), 'status menu acts on the piece, not the appointment')
  assert.match(card, /AppointmentDetail appointment=\{whole\}/)
})

test('the people board shows a long booking on every day it covers', () => {
  const rb = readFileSync(new URL('../ResourceBoard.jsx', import.meta.url), 'utf8')
  assert.match(rb, /const longByCell = useMemo/)
  assert.match(rb, /const booked = items\.filter\(\(i\) => !i\._whole\)\.length \+ longs\.length/,
    'counted twice on its first day, or not at all after it')
  assert.match(rb, /height: headH/)
})

test('the month lists a long booking on every day it covers', () => {
  const mg = readFileSync(new URL('../MonthGrid.jsx', import.meta.url), 'utf8')
  assert.match(mg, /for \(const a of appointments\.filter\(isLong\)\)/)
})

test('"Busy only" means busy on the days shown, not anywhere in the fetch', () => {
  const rb = readFileSync(new URL('../ResourceBoard.jsx', import.meta.url), 'utf8')
  assert.match(rb, /const onScreen = useMemo/)
  assert.match(rb, /onScreen\.map\(\(a\) => a\.assignedUserId\)/)
  assert.ok(!/appointments\.map\(\(a\) => a\.assignedUserId\)/.test(rb), 'busy is computed from the whole range again')
})

test('a long booking does not restart each morning in the month', async () => {
  const b = await import('../boardLayout.js')
  const t = await import('../../../utils/calendarTime.js')
  const Z = 'Europe/London', clock = (iso) => t.clockTime(iso, Z)
  const tue = { startsAt: '2026-11-24T10:30:00Z', endsAt: '2026-11-30T11:00:00Z' }
  assert.equal(b.longDayLabel(tue, '2026-11-24', Z, clock), '10:30')
  assert.equal(b.longDayLabel(tue, '2026-11-26', Z, clock), 'All day')
  assert.equal(b.longDayLabel(tue, '2026-11-30', Z, clock), 'until 11:00')
  const allday = { startsAt: '2026-10-26T00:00:00Z', endsAt: '2026-10-31T23:59:00Z' }
  for (const d of ['2026-10-26', '2026-10-28', '2026-10-31']) assert.equal(b.longDayLabel(allday, d, Z, clock), 'All day')
})

// ── The ‹ › arrows never moved the calendar ──────────────────────────

test('setFromDay accepts the updater form that step() uses', async () => {
  // Reproduce the setter exactly as written in CalendarTab, against a
  // fake useTabState setter, and drive it the way step(1) does.
  const dayjs = (await import('dayjs')).default
  const body = tab.slice(tab.indexOf('(d) => setFromDayKey('), tab.indexOf('[setFromDayKey]'))
  assert.match(body, /typeof d === 'function' \? d\(dayjs\(prevKey\)\.startOf\('day'\)\) : d/,
    'the updater form is not handled — the arrows throw again')
  let stored = '2026-11-20'
  const setFromDayKey = (fn) => { stored = typeof fn === 'function' ? fn(stored) : fn }
  const setFromDay = (d) => setFromDayKey((prevKey) => {
    const next = typeof d === 'function' ? d(dayjs(prevKey).startOf('day')) : d
    return dayjs(next).startOf('day').format('YYYY-MM-DD')
  })
  setFromDay((d) => d.add(1, 'day'));   assert.equal(stored, '2026-11-21')
  setFromDay((d) => d.add(7, 'day'));   assert.equal(stored, '2026-11-28')
  setFromDay((d) => d.add(1, 'month')); assert.equal(stored, '2026-12-28')
  setFromDay(dayjs('2026-11-25'));      assert.equal(stored, '2026-11-25', 'a plain date still works')
})

test('an empty board explains which filter emptied it', () => {
  for (const why of ['Nobody is ticked under People.', 'No calendars are ticked.', 'No blocked time in this period.']) {
    assert.ok(tab.includes(why), `missing: ${why}`)
  }
  assert.match(tab, /if \(loading \|\| error \|\| !hasBoard \|\| visible\.length > 0\) return null/)
})

test('Book never defaults to a day in the past', () => {
  assert.match(tab, /const day = first\.isAfter\(today\) \? first : today/)
})

test('the customer picker list carries the token scope, and flags empty records', () => {
  const cp = readFileSync(new URL('../../shared/ContactPicker.jsx', import.meta.url), 'utf8')
  assert.match(cp, /popupClassName="pp-menu pp-portal"/, 'picker list renders outside the token scope again')
  assert.match(cp, /No email, phone or business on file/)
})

test('the strip bar keeps the name when it is one column wide', () => {
  const grid = readFileSync(new URL('../TimeGrid.jsx', import.meta.url), 'utf8')
  assert.match(grid, /flex: '0 1 auto', minWidth: 40/)
  assert.match(grid, /flex: '0 100 auto', minWidth: 0/)
})

test('the hover card stands aside while the card menu is open', () => {
  const card = readFileSync(new URL('../AppointmentCard.jsx', import.meta.url), 'utf8')
  assert.match(card, /open=\{menuOpen \? false : undefined\}/)
  assert.match(card, /onOpenChange=\{setMenuOpen\}/)
})

test('a note typed here can be read back here', () => {
  const w = readFileSync(new URL('../../../../../server/src/services/appointmentWriter.js', import.meta.url), 'utf8')
  const sy = readFileSync(new URL('../../../../../server/src/services/appointmentsSync.js', import.meta.url), 'utf8')
  assert.match(w, /notes: a\.notes \|\| a\.description \|\| null/, 'webhook drops the description we write')
  assert.match(sy, /e\.notes \|\| e\.description \|\| null/, 'sync drops the description we write')
  const d = readFileSync(new URL('../AppointmentDetail.jsx', import.meta.url), 'utf8')
  assert.match(d, /\{a\.notes && a\.notes\.trim\(\) && \(/, 'the hover card does not show the note')
})

test('the booking card re-fits when it grows', () => {
  const b = readFileSync(new URL('../BookAppointment.jsx', import.meta.url), 'utf8')
  assert.match(b, /new ResizeObserver\(fit\)/)
  assert.ok(!/settled\.current === key/.test(b), 'measured once on open again')
})

test('a long booking ends visibly on its last day, at its end time', async () => {
  const { longEndPiece } = await import('../boardLayout.js')
  const live = { id: 'L', startsAt: '2026-11-24T10:30:00Z', endsAt: '2026-11-30T11:00:00Z' }
  const p = longEndPiece(live, 'Europe/London')
  assert.equal(p.startsAt, '2026-11-30T10:30:00.000Z')
  assert.equal(p.endsAt, live.endsAt)
  assert.equal(p._edge, 'end')
  assert.equal(p._whole, live)
  assert.equal(longEndPiece({ startsAt: '2026-10-26T00:00:00Z', endsAt: '2026-10-31T23:59:00Z' }, 'Europe/London'), null)
  const card = readFileSync(new URL('../AppointmentCard.jsx', import.meta.url), 'utf8')
  assert.match(card, /a\._edge === 'end' \? `until \$\{clockTime\(whole\.endsAt, zone\)\}`/)
})

test('the booking card checks availability before Save, without blocking it', () => {
  const b = readFileSync(new URL('../BookAppointment.jsx', import.meta.url), 'utf8')
  assert.match(b, /appointmentsAPI\.freeSlots\(\{/)
  assert.match(b, /const isOpen = avail\.slots\.some\(\(s\) => Date\.parse\(s\) === chosenStartMs\)/)
  assert.match(b, /onClick=\{\(\) => pickSlot\(s\)\}/, 'no way to pick an accepted time')
  // A failed check must never stop a booking.
  assert.match(b, /\.catch\(\(\) => \{ if \(!cancelled\) setAvail\(\{ status: 'error', slots: \[\] \}\) \}\)/)
})
