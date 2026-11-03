// A person on a deal must open their contact record.
//
// The People list in the deal editor showed a name, email and phone with no
// way through to the record that owns them — a dead end, while every other
// surface in the app (the deal table's contact cell, the Deal Hub's chips)
// already linked. It read as broken rather than deliberate.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const panel = readFileSync(new URL('../DealEditPanel.jsx', import.meta.url), 'utf8')
const tab = readFileSync(new URL('../../tabs/DealsTab.jsx', import.meta.url), 'utf8')
const table = readFileSync(new URL('../DealTable.jsx', import.meta.url), 'utf8')

test('the person name opens the contact', () => {
  assert.match(panel, /onClick=\{\(\) => onOpenContact\(p\.id\)\}/)
})

test('it uses the CONTACT id, not the relation id', () => {
  // `people[].id` is contact_id (routes/deals.js); relationId is a separate
  // field used for unlinking. Passing the wrong one opens nothing.
  assert.ok(!/onOpenContact\(p\.relationId\)/.test(panel))
})

test('it matches the handler shape the rest of the app uses', () => {
  // DealTable calls onOpenContact(contactId) and the shell navigates to the
  // contacts tab with it. A different shape here would need its own handler.
  assert.match(table, /onOpenContact\(d\.contact\.id\)/)
})

test('the handler is threaded from the tab to every place a contact shows', () => {
  // DealsTab -> the grid card (View CONTACT), the table, and the deal's own
  // page -> DealEditPanel. A break anywhere is invisible — React passes
  // undefined and the name silently stops linking.
  //
  // The old Cards view (DealCard) was retired for the grid card in Oct 2026;
  // the grid card now carries the link.
  const grid = readFileSync(new URL('../DealGridCard.jsx', import.meta.url), 'utf8')
  assert.match(grid, /onOpenContact\(deal\.contact\.id\)/)
  assert.ok((tab.match(/onOpenContact=\{onOpenContact\}/g) || []).length >= 3)
  assert.match(panel, /onOpenContact=\{onOpenContact\}/)
})

test('it is a real button, not a clickable span', () => {
  // Keyboard-reachable and announced by a screen reader; a styled span is
  // neither.
  const people = panel.slice(panel.indexOf('function PeopleEditor'))
  assert.match(people, /<button\s+type="button"\s+onClick=\{\(\) => onOpenContact/)
})

test('the panel still renders without a handler', () => {
  // It is mounted in more than one place; a missing prop must degrade to
  // plain text, not throw.
  assert.match(panel, /onOpenContact \? \(/)
})

test('both editors link, not just the inline one', () => {
  // DealEditPanel is mounted twice: inline on a card, and full-page via
  // DealEditPage. Wiring only one would make the link appear and disappear
  // depending on how the deal was opened — worse than it never working.
  const page = readFileSync(new URL('../DealEditPage.jsx', import.meta.url), 'utf8')
  assert.match(page, /onOpenContact=\{onOpenContact\}/)
  assert.match(page, /onClose, onSaved, onDeleted, onOpenInHub, onOpenContact/)
  // and the tab supplies it to the page too
  assert.match(tab, /<DealEditPage[\s\S]{0,400}onOpenContact=\{onOpenContact\}/)
})
