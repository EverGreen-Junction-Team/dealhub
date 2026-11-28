// No Contact box in the Deals, Notes or Tasks toolbars.
//
// One was added to all three (Nov 2026) and then taken out at the user's
// request. Tasks and Notes still filter by contact from their Filters drawer,
// which shows and clears it. Deals has no such drawer, so a contact left over
// in someone's remembered filters is dropped on arrival — otherwise the grid,
// which sends every filter, would keep narrowing with nothing on screen.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const tasks = read('../TasksTab.jsx')
const notes = read('../NotesTab.jsx')
const deals = read('../DealsTab.jsx')
const work = read('../../shared/WorkFilters.jsx')
const picker = read('../../shared/ContactPicker.jsx')

test('no Contact box in the three toolbars', () => {
  assert.doesNotMatch(tasks, /label="Contact"/)
  assert.doesNotMatch(notes, /label="Contact"/)
  assert.doesNotMatch(deals, /label="Contact"/)
  assert.doesNotMatch(work, /export function ContactFilter/)
})

test('Tasks and Notes keep the contact filter in their Filters drawer', () => {
  assert.match(work, /<span style=\{LABEL\}>Contact<\/span>/)
  assert.match(tasks, /contactId: filters\.contactId \|\| undefined/)
  assert.match(notes, /contactId: filters\.contactId \|\| undefined/)
})

test('Deals drops a contact left in remembered filters', () => {
  assert.match(deals, /if \(!filters\?\.contactId\) return\n\s+setFilters\(\(f\) => \{\n\s+const next = \{ \.\.\.f \}\n\s+delete next\.contactId/)
})

test('the picker fixes stay: a remembered contact shows its name, the placeholder is honoured', () => {
  assert.match(picker, /contactsAPI\.get\(value\)/)
  assert.match(picker, /placeholder=\{placeholder\}/)
})
