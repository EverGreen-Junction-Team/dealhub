// A Contact filter in the toolbar — Tasks, Notes and Deals.
//
// Asked for beside Assignee on Tasks, then "notes page also" and "deal page
// too". Tasks and Notes could already filter by contact, but only inside the
// Filters drawer; Deals could not at all from the toolbar. The box writes the
// same key the drawer uses (filters.contactId), so the two agree.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const tasks = read('../TasksTab.jsx')
const notes = read('../NotesTab.jsx')
const deals = read('../DealsTab.jsx')
const work = read('../../shared/WorkFilters.jsx')
const picker = read('../../shared/ContactPicker.jsx')
const board = read('../../deals/DealBoard.jsx')
const list = read('../../deals/DealList.jsx')

test('one shared Contact box, bound to the drawer\'s own setting', () => {
  const fn = work.slice(work.indexOf('export function ContactFilter'), work.indexOf('export default function WorkFilters'))
  assert.match(fn, /<ContactPicker/)
  assert.match(fn, /value=\{filters\.contactId \|\| null\}/)
  // A deal picked for the previous contact is cleared, as the drawer does.
  assert.match(fn, /delete next\.dealId/)
  assert.match(fn, /height=\{34\}/)
})

test('Tasks and Notes show it beside Assignee / Author, and query by it', () => {
  for (const [src, before, after] of [[tasks, 'label="Assignee"', 'label="Due"'], [notes, 'label="Author"', 'label="Sort"']]) {
    assert.match(src, /<LabelledControl label="Contact">\s*<ContactFilter filters=\{filters\} onChange=\{setFilters\} \/>/)
    assert.ok(src.indexOf(before) < src.indexOf('label="Contact"'))
    assert.ok(src.indexOf('label="Contact"') < src.indexOf(after))
    assert.match(src, /contactId: filters\.contactId \|\| undefined/)
  }
})

test('Deals: a Contact box after Owner, applied in every view and the counts', () => {
  assert.ok(deals.indexOf('<ToolbarField label="Owner">') < deals.indexOf('<ToolbarField label="Contact">'))
  const field = deals.slice(deals.indexOf('<ToolbarField label="Contact">'), deals.indexOf('</ToolbarField>', deals.indexOf('<ToolbarField label="Contact">')))
  assert.match(field, /value=\{filters\.contactId \|\| null\}/)
  assert.match(field, /setDirtyView\(activeViewId\)/)
  // The count and stage strip
  assert.match(deals, /tag: filters\.tag \|\| undefined,\n\s+contactId: filters\.contactId \|\| undefined,/)
  // Board and table each get it
  assert.equal((deals.match(/contactId=\{filters\.contactId \|\| undefined\}/g) || []).length, 2)
  // Grid: the list query spreads `filters`, contactId included
  assert.match(deals, /\.\.\.filters\n\s+\}\),\n\s+\[search, filters, boardPipelineId, sort, sortDir\]/)
  // Board columns and table groups send it, and refetch when it changes
  assert.match(board, /contactId: contactId \|\| undefined,/)
  assert.match(board, /\}, \[stage\.id, search, status, tag, assignedTo, contactId, sort, dir\]\)/)
  assert.match(list, /contactId: contactId \|\| undefined,/)
  assert.match(list, /\}\), \[status, search, tag, assignedTo, contactId, sort, dir\]\)/)
})

test('a remembered contact shows its NAME, not its id', () => {
  assert.match(picker, /contactsAPI\.get\(value\)/)
  assert.match(picker, /setChosen\(c\)/)
})

test('the placeholder is honoured — the drawer\'s "Anyone" was ignored', () => {
  assert.match(picker, /placeholder=\{placeholder\}/)
})
