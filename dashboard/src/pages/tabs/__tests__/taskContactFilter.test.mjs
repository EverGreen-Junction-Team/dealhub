// A Contact filter in the Tasks toolbar.
//
// Asked for beside the Assignee picker. Tasks could already be filtered by
// contact, but only inside the Filters drawer, where nobody looked. The
// toolbar box is the SAME setting (filters.contactId), so the two agree.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const tab = read('../TasksTab.jsx')
const picker = read('../../shared/ContactPicker.jsx')

test('the toolbar has a Contact box bound to the drawer\'s own setting', () => {
  const block = tab.slice(tab.indexOf('<LabelledControl label="Contact">'), tab.indexOf('</LabelledControl>', tab.indexOf('<LabelledControl label="Contact">')))
  assert.ok(block.length > 0, 'no Contact control in the toolbar')
  assert.match(block, /<ContactPicker/)
  assert.match(block, /value=\{filters\.contactId \|\| null\}/)
  // A deal picked for the previous contact is cleared, as the drawer does.
  assert.match(block, /delete next\.dealId/)
  assert.match(block, /height=\{34\}/)
  // and the query still sends it
  assert.match(tab, /contactId: filters\.contactId \|\| undefined/)
})

test('it sits beside Assignee', () => {
  assert.ok(tab.indexOf('label="Assignee"') < tab.indexOf('label="Contact"'))
  assert.ok(tab.indexOf('label="Contact"') < tab.indexOf('label="Due"'))
})

test('a remembered contact shows its NAME, not its id', () => {
  // After a tab switch, a Refresh or a reload the picker has only the id; the
  // contact is fetched by it when no list holds it.
  assert.match(picker, /contactsAPI\.get\(value\)/)
  assert.match(picker, /setChosen\(c\)/)
})

test('the placeholder is honoured — the drawer\'s "Anyone" was ignored', () => {
  assert.match(picker, /placeholder=\{placeholder\}/)
  assert.doesNotMatch(picker, /placeholder="Search by name, email, phone or business"\n/)
})
