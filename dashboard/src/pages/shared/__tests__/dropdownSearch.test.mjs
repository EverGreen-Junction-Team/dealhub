// Type to search in the long dropdowns.
//
// Asked for from the Tasks Assignee picker: a sub-account's user list runs
// long, and scrolling it was the only way to find one person. The same goes
// for the other pickers that list people, pipelines, saved views and
// calendars. (Short fixed lists — status, due, sort — need no search; the
// multi-selects already search by default.)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
// The <Select …> element that follows `anchor`, up to its own closing.
function selectAfter(src, anchor) {
  const at = src.indexOf(anchor)
  assert.ok(at > -1, `not found: ${anchor}`)
  const start = src.lastIndexOf('<Select', at)
  return src.slice(start, src.indexOf('/>', at))
}

test('Owner / Assignee (Tasks, Deals, Contacts, Notes) searches by name', () => {
  const sel = selectAfter(read('../ListFilters.jsx'), 'popupMatchSelectWidth={260}')
  assert.match(sel, /showSearch/)
  assert.match(sel, /optionFilterProp="label"/)
  assert.match(sel, /notFoundContent="No one by that name"/)
})

test('the Deals pipeline picker searches', () => {
  const sel = selectAfter(read('../../tabs/DealsTab.jsx'), 'aria-label="Pipeline"')
  assert.match(sel, /showSearch/)
  assert.match(sel, /optionFilterProp="label"/)
})

test('the Contacts saved-view picker searches', () => {
  const sel = selectAfter(read('../../tabs/ContactsTab.jsx'), 'onChange={(id) => applyView(id || null)}')
  assert.match(sel, /showSearch/)
})

test('the Book form searches people and calendars — calendars by plain name', () => {
  const book = read('../../calendar/BookAppointment.jsx')
  assert.match(selectAfter(book, 'onChange={setAssignedUserId}'), /showSearch/)
  const cal = selectAfter(book, 'onChange={setCalendarId}')
  assert.match(cal, /showSearch/)
  // The label is a colour dot plus the name, so it is matched on `search`.
  assert.match(cal, /optionFilterProp="search"/)
  assert.match(book, /search: c\.name \|\| ''/)
})
