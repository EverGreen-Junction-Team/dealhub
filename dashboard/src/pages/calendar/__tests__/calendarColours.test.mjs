// Every booking is drawn in its calendar's colour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALENDAR_PALETTE, calendarIndex, calendarOf, colourOfAppointment, defaultCalendarColour, NO_CALENDAR_COLOUR
} from '../calendarColours.js'

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('a chosen colour wins; otherwise a default by position', () => {
  const { colours } = calendarIndex([{ id: 'a', colour: '#123456' }, { id: 'b' }, { id: 'c', colour: null }])
  assert.equal(colours.get('a'), '#123456')
  assert.equal(colours.get('b'), defaultCalendarColour(1))
  assert.equal(colours.get('c'), defaultCalendarColour(2))
})

test('neighbouring calendars get different defaults, and the defaults wrap', () => {
  for (let i = 0; i < 30; i++) assert.notEqual(defaultCalendarColour(i), defaultCalendarColour(i + 1))
  assert.equal(defaultCalendarColour(0), defaultCalendarColour(24))
})

test('a booking takes its calendar colour; unknown calendar with no person is grey', () => {
  const ix = calendarIndex([{ id: 'a', colour: '#123456' }])
  assert.equal(colourOfAppointment(ix, { calendarId: 'a' }), '#123456')
  assert.equal(colourOfAppointment(ix, { calendarId: 'zz' }), NO_CALENDAR_COLOUR)
  assert.equal(colourOfAppointment(null, { calendarId: 'a' }), NO_CALENDAR_COLOUR)
})

test('blocked time is coloured too — by its calendar, else its person\'s Personal calendar', () => {
  // Found live: person-level blocked time has no calendar in GHL, only a user.
  const ix = calendarIndex([
    { id: 'team', name: 'Team Iris & Gabriel', colour: '#8e24aa', userIds: ['u1', 'u2'] },
    { id: 'p1', name: "Charlie Stoyle's Personal Calendar", type: 'personal', userIds: ['u1'], colour: '#d50000' },
    { id: 'p2', name: "Chris Higgs's Personal Calendar", colour: '#0b8043' } // no members: matched by name
  ], [{ id: 'u1', name: 'Charlie Stoyle' }, { id: 'u3', name: 'Chris Higgs' }])
  assert.equal(colourOfAppointment(ix, { kind: 'blocked', calendarId: 'team' }), '#8e24aa')
  assert.equal(colourOfAppointment(ix, { kind: 'blocked', assignedUserId: 'u1' }), '#d50000')
  assert.equal(colourOfAppointment(ix, { kind: 'blocked', assignedUserId: 'u3' }), '#0b8043')
  // A team calendar is never a person's own.
  assert.equal(colourOfAppointment(ix, { kind: 'blocked', assignedUserId: 'u2' }), NO_CALENDAR_COLOUR)
  // Its own calendar beats its person's.
  assert.equal(calendarOf(ix, { calendarId: 'team', assignedUserId: 'u1' }), 'team')
  assert.equal(calendarOf(ix, { assignedUserId: 'u1' }), 'p1')
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
  assert.equal((tab.match(/calendarColours=\{calendarColours\}/g) || []).length, 5)
  // Counts and the calendar ticks follow the same rule as the colour.
  assert.equal((tab.match(/calendarOf\(calendarColours, a\)/g) || []).length, 2)
  assert.match(tab, /onChangeCalendarColour=\{handleCalendarColour\}/)
})

test('choosing a colour does not tick or untick the calendar', () => {
  const s = src('CalendarSidebar.jsx')
  assert.match(s, /const stop = \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\) \}/)
  assert.match(s, /onClick=\{\(e\) => \{ stop\(e\); setOpen/)
})

test('"+N more" opens the day list over the cell, not the day view', () => {
  const s = src('MonthGrid.jsx')
  assert.match(s, /open=\{moreDay === day\}/)
  assert.match(s, /<DayList/)
  // The day view is still one click away, from the date in the list.
  assert.match(s, /onOpenDay=\{onOpenDay \? \(\) => \{ setMoreDay\(null\); onOpenDay\(day\) \} : null\}/)
  // The more button itself no longer navigates.
  assert.doesNotMatch(s, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onOpenDay\?\.\(day\) \}\}/)
  // Every booking in the list is coloured by its calendar.
  assert.match(s.slice(s.indexOf('function DayList')), /colourOfAppointment\(calendarColours/)
})

test('the booking card shows each calendar\'s colour and previews the slot in it', () => {
  const book = src('BookAppointment.jsx')
  assert.match(book, /background: calendarColours\?\.colours\?\.get\(c\.id\)/, 'no colour dot in the calendar picker')
  assert.match(book, /colour: \(calendarId && calendarColours\?\.colours\?\.get\(calendarId\)\) \|\| null/)
  assert.match(book, /\[day, time, duration, title, assignedUserId, calendarId, calendarColours, onDraft\]/,
    'changing the calendar must repaint the draft')
  for (const f of ['TimeGrid.jsx', 'ResourceBoard.jsx']) assert.match(src(f), /colour=\{draft\.colour\}/, f)
  assert.match(src('MonthGrid.jsx'), /draft\.colour \|\| 'var\(--brand-primary\)'/)
  assert.match(src('DraftSlot.jsx'), /colour \|\| 'var\(--brand-primary\)'/)
  const tab = readFileSync(new URL('../../tabs/CalendarTab.jsx', import.meta.url), 'utf8')
  assert.match(tab, /onDraft=\{setDraft\}\s*\n\s*calendarColours=\{calendarColours\}/)
})
