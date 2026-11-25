import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The calendar is ONE WHITE SURFACE.
//
// Five different backgrounds accumulated across the grid, each one
// reasonable when it went in: off-hours bands, a weekend wash, a tint on
// today, a shade on the neighbouring month's days, and a status fill on
// every card. Together they meant a card's background depended on which
// day and which hour it landed in, so the colour coding read differently
// in different parts of the same week.
//
// These tests exist because every one of those was added deliberately and
// would be added again. The grid structure comes from RULES — a hairline
// per day, a hairline per hour — and nothing else.

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
// Comments argue for things; only code paints them. An earlier test in
// this repo passed by matching prose about the code instead of the code.
const code = (f) => read(f).split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

const GRIDS = ['TimeGrid.jsx', 'ResourceBoard.jsx', 'MonthGrid.jsx']

test('no grid paints a sunken band', () => {
  for (const f of GRIDS) {
    assert.ok(!/surface-sunken/.test(code(f)), `${f} shades part of the grid`)
  }
})

test('no grid tints a whole day or column', () => {
  for (const f of GRIDS) {
    const src = code(f)
    // tint-gold survives on the Unassigned column: that is not a day, it
    // is a pile of work with nobody's name on it.
    const tints = (src.match(/var\(--tint-[a-z]+\)/g) || [])
      .filter((t) => !t.includes('gold') && !t.includes('pine'))
    assert.deepEqual(tints, [], `${f} still tints a surface: ${tints.join(', ')}`)
  }
})

test('every grid separates its columns with a rule', () => {
  // With no tints left, the dividers are the ONLY thing distinguishing one
  // day — or one rep — from the next. A view that lost them would render
  // as an undivided field and look like a loading state.
  for (const f of GRIDS) {
    assert.match(code(f), /border(Left|Right): '1px solid var\(--border-default\)'/,
      `${f} has no vertical divider`)
  }
})

test('the resource board divides the column BODY, not just its head', () => {
  // The head had a rule and the body did not, which was invisible while
  // each column had its own tint to end at.
  const src = code('ResourceBoard.jsx')
  const rules = (src.match(/border(Left|Right): '1px solid var\(--border-default\)'/g) || [])
  assert.ok(rules.length >= 2, 'only one divider on the board — the body is undivided')
})

test('the appointment card is white, and blocked time is not', () => {
  const src = code('AppointmentCard.jsx')
  assert.match(src, /background: isBlocked \? style\.tint : 'var\(--surface-card\)'/,
    'the card is tinted by status again')
  // Blocked keeps its hatch: it is the absence of availability, a surface
  // rather than an item, and must not read as a booking.
  assert.match(src, /repeating-linear-gradient/, 'blocked time lost its hatching')
})

test('the card carries exactly one colour, and it is the bar', () => {
  const src = code('AppointmentCard.jsx')
  // The heading must not be the status accent — seven statuses would mean
  // seven heading colours on a white card.
  assert.ok(!/color: style\.text/.test(src), 'the card heading is coloured by status again')
  assert.match(src, /borderLeftColor: isBlocked \? style\.bar : \(accent \|\| style\.bar\)/,
    'the one remaining colour channel is gone')
})

test('status still reads without hue', () => {
  // What the fill used to say now has to be said by something a reader
  // with any colour vision can see. These are the three that carry it.
  const src = code('AppointmentCard.jsx')
  assert.match(src, /textDecoration: cancelled \? 'line-through'/, 'cancelled lost its strike')
  assert.match(src, /'No-show'/, 'no-show lost its word')
  assert.match(src, /repeating-linear-gradient/, 'blocked lost its hatch')
})

test('the month chip colours a dot, not the whole chip', () => {
  const src = code('MonthGrid.jsx')
  assert.match(src, /borderRadius: '50%'/, 'the month chip has no dot')
  assert.match(src, /background: accent \|\| 'var\(--accent-teal\)'/, 'the dot is not the person')
})

test('today is still marked, just not as a tint', () => {
  // Removing the tint must not remove the mark. Both time views put
  // today's date in a filled disc, as Google does.
  for (const f of ['TimeGrid.jsx', 'MonthGrid.jsx']) {
    assert.match(code(f), /isToday \? 'var\(--brand-primary\)'/, `${f} no longer marks today`)
  }
})

test('the working day survives the loss of its shading', () => {
  // The off-hours bands did one useful thing in a 24-hour column. Two
  // cues replace them: the gutter sets working hours a step darker, and
  // half-hour rules are drawn inside working hours only.
  const src = code('TimeGrid.jsx')
  const uses = (src.match(/WORK_START_MIN/g) || []).length
  assert.ok(uses >= 2, 'nothing distinguishes the working day any more')
})
