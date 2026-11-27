// Jump from one contact's page straight to another.
//
// Asked for from a contact record: the only way to another person was
// All contacts → search → click. The record's header now has a search beside
// "All contacts" that opens the chosen contact directly.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const detail = read('../ContactDetail.jsx')
const tab = read('../../tabs/ContactsTab.jsx')

test('the record header has a contact search beside All contacts', () => {
  const shell = detail.slice(detail.indexOf('function Shell('), detail.indexOf('// ── Details'))
  assert.match(shell, /All contacts/)
  assert.match(shell, /<ContactPicker/)
  assert.ok(shell.indexOf('All contacts') < shell.indexOf('<ContactPicker'))
  assert.match(shell, /placeholder="Jump to another contact…"/)
})

test('it is a way to go, not a field: empty, cleared after each jump, never the current contact', () => {
  const shell = detail.slice(detail.indexOf('function Shell('), detail.indexOf('// ── Details'))
  assert.match(shell, /value=\{null\}/)
  assert.match(shell, /key=\{currentId \|\| 'none'\}/)
  assert.match(shell, /exclude=\{currentId \? \[currentId\] : \[\]\}/)
  assert.match(shell, /if \(id && id !== currentId\) onOpenContact\(id\)/)
})

test('every state of the page carries it — loading, error and loaded', () => {
  assert.equal((detail.match(/<Shell onBack=\{onBack\} onOpenContact=\{onOpenContact\} currentId=\{contactId\}>/g) || []).length, 3)
})

test('the Contacts tab opens the pick the same way as a click in the list', () => {
  assert.match(tab, /onOpenContact=\{openRecord\}/)
  assert.match(tab, /const openRecord = \(id\) => \{\n\s+setOpenId\(id\)\n\s+if \(onNavigate\) onNavigate\(\{ contactId: id \}\)/)
})
