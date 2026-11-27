// Every booking is drawn in its calendar's colour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALENDAR_PALETTE, calendarColourMap, colourOfAppointment, defaultCalendarColour, NO_CALENDAR_COLOUR
} from '../calendarColours.js'

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('a chosen colour wins; otherwise a default by position', () => {
  const m = calendarColourMap([{ id: 'a', colour: '#123456' }, { id: 'b' }, { id: 'c', colour: null }])
  assert.equal(m.get('a'), '#123456')
  assert.equal(m.get('b'), defaultCalendarColour(1))
  assert.equal(m.get('c'), defaultCalendarColour(2))
})

test('neighbouring calendars get different defaults, and the defaults wrap', () => {
  for (let i = 0; i < 30; i++) assert.notEqual(defaultCalendarColour(i), defaultCalendarColour(i + 1))
  assert.equal(defaultCalendarColour(0), defaultCalendarColour(24))
})

test('a booking takes its calendar colour; blocked time and unknown calendars are grey', () => {
  const m = calendarColourMap([{ id: 'a', colour: '#123456' }])
  assert.equal(colourOfAppointment(m, { calendarId: 'a' }), '#123456')
  assert.equal(colourOfAppointment(m, { calendarId: 'zz' }), NO_CALENDAR_COLOUR)
  assert.equal(colourOfAppointment(m, { calendarId: 'a', kind: 'blocked' }), NO_CALENDAR_COLOUR)
  assert.equal(colourOfAppointment(null, { calendarId: 'a' }), NO_CALENDAR_COLOUR)
})

test('the palette is 24 distinct #rrggbb colours (the server accepts only that form)', () => {
  assert.equal(CALENDAR_PALETTE.length, 24)
  assert.equal(new Set(CALENDAR_PALETTE.map((p) => p.hex)).size, 24)
  for (const p of CALENDAR_PALETTE) assert.match(p.hex, /^#[0-9a-f]{6}$/)
})

test('every view colours cards by calendar, not by person', () => {
  for (const f of ['TimeGrid.jsx', 'MonthGrid.jsx', 'ResourceBoard.jsx']) {
    const s = src(f)
    assert.match(s, /colourOfAppointment\(calendarColours/, f)
    assert.doesNotMatch(s, /colourFor\(|statusAccent\(/, f)
  }
  const tab = readFileSync(new URL('../../tabs/CalendarTab.jsx', import.meta.url), 'utf8')
  assert.equal((tab.match(/calendarColours=\{calendarColours\}/g) || []).length, 4)
  assert.match(tab, /onChangeCalendarColour=\{handleCalendarColour\}/)
})

test('choosing a colour does not tick or untick the calendar', () => {
  const s = src('CalendarSidebar.jsx')
  assert.match(s, /const stop = \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\) \}/)
  assert.match(s, /onClick=\{\(e\) => \{ stop\(e\); setOpen/)
})
