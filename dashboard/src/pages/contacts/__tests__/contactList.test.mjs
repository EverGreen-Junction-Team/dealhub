// The Contacts list view — the client's October 2026 design.
//
// Run: node --test src/pages/contacts/__tests__/contactList.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const table = readFileSync(new URL('../ContactTable.jsx', import.meta.url), 'utf8');
const tab = readFileSync(new URL('../../tabs/ContactsTab.jsx', import.meta.url), 'utf8');

test('the list has the design columns in order, Name always first', () => {
  const cols = [...table.matchAll(/\{ key: '(\w+)', label: '(\w+)' \}/g)].map((m) => m[1]);
  assert.deepEqual(cols, ['type', 'email', 'phone', 'business', 'address', 'tags', 'tasks', 'notes', 'deals']);
  assert.match(table, /<th style=\{TH\}>Name<\/th>/);
});

test('the toolbar can hide columns, and the switch says List', () => {
  assert.match(tab, /<ColumnsControl value=\{columns\} onChange=\{setColumns\} \/>/);
  assert.match(tab, /Columns · \{value\.length \+ 1\} of \{total\}/);
  assert.match(tab, /\{ id: 'table', icon: 'view_agenda', label: 'List' \}/);
});

test('cells write through the existing APIs only', () => {
  assert.match(table, /contactsAPI\.update\(c\.id, \{ address \}\)/);
  assert.match(table, /contactsAPI\.update\(c\.id, \{ businessId: null \}\)/);
  assert.match(table, /contactsAPI\.addTags\(c\.id, \[tag\]\)/);
  assert.match(table, /contactsAPI\.removeTags\(c\.id, \[tag\]\)/);
  // Tags never through the general update — it replaces the whole array.
  assert.doesNotMatch(table, /contactsAPI\.update\([^)]*tags/);
});

test('pills expand a section under the row; each item has a View pill', () => {
  // The October design: no floating menu — the pill toggles its group below.
  assert.match(table, /const toggle = \(kind\) =>/);
  assert.match(table, /open\.size > 0 &&/);
  assert.match(table, /onClick=\{onOpenDeal \? \(\) => onOpenDeal\(d\.id\)/);
  assert.match(table, /kind="TASK"/);
  assert.match(table, /kind="NOTE"/);
  // A contact with none still opens the record.
  const tasks = table.slice(table.indexOf("show('tasks')"), table.indexOf("show('notes')"));
  assert.match(tasks, /onClick=\{\(\) => onOpen && onOpen\(c\.id\)\}/);
});

test('rows can be selected, with select-all over the loaded rows', () => {
  assert.match(table, /aria-label="Select every contact shown"/);
  assert.match(table, /el\.indeterminate = someOn/);
  assert.match(tab, /onToggleAll=\{\(on\) => setSelected\(on \? new Set\(contacts\.map\(\(c\) => c\.id\)\) : new Set\(\)\)\}/);
});

test('the expansion spans the whole row, inside the table', () => {
  // In the table, not a portal: the design draws it under the row.
  assert.match(table, /<td colSpan=\{99\} style=\{\{ \.\.\.TD, borderRight: 'none', padding: 0/);
});

test('every unwired control is on the pending list', () => {
  const pending = readFileSync(new URL('../../../../PENDING_FUNCTIONALITY.md', import.meta.url), 'utf8');
  for (const item of ['**Type** row pencil', '**Tasks** pill chevron', '**Notes** pill chevron',
    '**Add contact**', '**Selection checkboxes**', 'Bulk **Assign owner**',
    'Bulk **Delete**']) {
    assert.ok(pending.includes(item), `${item} missing from PENDING_FUNCTIONALITY.md`);
  }
});
