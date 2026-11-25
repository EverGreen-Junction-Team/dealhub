import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zoneAbbrev, boardZone, FALLBACK_ZONE } from '../calendarTime.js'

// The label at the head of the hour gutter.
//
// These assert against the real Intl database, which is the point: the
// label is only worth anything if it tracks DST, and a hand-rolled table
// of abbreviations is exactly what this function exists not to be.

const WINTER = '2026-11-25T12:00:00Z'
const SUMMER = '2026-07-15T12:00:00Z'

test('names the zone, not the viewer', () => {
  assert.equal(zoneAbbrev('Europe/London', WINTER), 'GMT')
  assert.equal(zoneAbbrev('UTC', WINTER), 'UTC')
})

test('follows DST for the day being drawn', () => {
  // The whole reason the caller passes a date. Same zone, two answers.
  assert.equal(zoneAbbrev('Europe/London', WINTER), 'GMT')
  assert.equal(zoneAbbrev('Europe/London', SUMMER), 'BST')
  assert.notEqual(
    zoneAbbrev('America/New_York', WINTER),
    zoneAbbrev('America/New_York', SUMMER)
  )
})

test('a half-hour offset still gets a label', () => {
  // India has no abbreviation in CLDR; it must not come back blank.
  const s = zoneAbbrev('Asia/Kolkata', WINTER)
  assert.match(s, /5:30/)
})

test('never returns empty, whatever it is handed', () => {
  for (const z of [null, undefined, '', 'Not/AZone', 42, {}]) {
    const s = zoneAbbrev(z, WINTER)
    assert.equal(typeof s, 'string')
    assert.ok(s.length > 0, `empty label for ${JSON.stringify(z)}`)
  }
})

test('an unusable zone falls back the same way the board does', () => {
  // The label must agree with the axis the grid is drawn on, or it is
  // worse than no label at all.
  assert.equal(zoneAbbrev('Not/AZone', WINTER), zoneAbbrev(FALLBACK_ZONE, WINTER))
  assert.equal(boardZone('Not/AZone'), FALLBACK_ZONE)
})

test('a malformed date does not throw', () => {
  assert.doesNotThrow(() => zoneAbbrev('Europe/London', 'nonsense'))
  assert.ok(zoneAbbrev('Europe/London', 'nonsense').length > 0)
})

test('it is short enough for the gutter', () => {
  // GUTTER_W is 56px; anything past ~10 characters ellipsises and stops
  // being a label. Checked for the zones this install actually uses.
  for (const z of ['Europe/London', 'America/New_York', 'Asia/Kolkata', 'UTC']) {
    assert.ok(zoneAbbrev(z, WINTER).length <= 10, `${z} too long`)
  }
})

// ── The wiring, which is what actually reached the screen ──────────────

const grid = readFileSync(new URL('../../pages/calendar/TimeGrid.jsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../../pages/calendar/ResourceBoard.jsx', import.meta.url), 'utf8')
const tab = readFileSync(new URL('../../pages/tabs/CalendarTab.jsx', import.meta.url), 'utf8')

test('both time views label their gutter', () => {
  for (const [name, src] of [['TimeGrid', grid], ['ResourceBoard', board]]) {
    assert.match(src, /zoneAbbrev\(zone, dayKeys\[0\]/, `${name} does not label its gutter`)
    // The abbreviation alone does not say WHICH clock; the title must.
    assert.match(src, /title=\{`Times shown in \$\{zone\}`\}/, `${name} has no full zone on hover`)
  }
})

test('the gutter is read for the day drawn, never for today', () => {
  // zoneAbbrev() with no date falls back to now, which would label a
  // week in July with January's name.
  for (const [name, src] of [['TimeGrid', grid], ['ResourceBoard', board]]) {
    const calls = src.match(/zoneAbbrev\([^)]*\)/g) || []
    assert.ok(calls.length > 0, `${name} never calls zoneAbbrev`)
    for (const c of calls) {
      assert.ok(c.includes('dayKeys[0]'), `${name} reads the zone for today: ${c}`)
    }
  }
})

test('the toolbar no longer repeats it in the time views', () => {
  // Stripped of comments first: an earlier test in this repo passed
  // vacuously by matching prose about the code instead of the code.
  const code = tab.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.match(code, /view === 'month' \|\| data\.timezone == null/,
    'the toolbar zone line is unconditional again')
})

test('the month view, which has no gutter, still says it', () => {
  // The one view where dropping the toolbar line would leave the zone
  // unstated anywhere.
  assert.ok(!/zoneAbbrev/.test(readFileSync(new URL('../../pages/calendar/MonthGrid.jsx', import.meta.url), 'utf8')),
    'MonthGrid grew a gutter; this guard needs revisiting')
  assert.match(tab, /Times shown in \{zone\}/)
})
