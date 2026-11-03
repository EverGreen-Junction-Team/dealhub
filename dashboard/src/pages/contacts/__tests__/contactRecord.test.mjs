// The contact record page — the client's October 2026 design: one record card
// holding identity, tags and a two-column field table.
//
// Run: node --test src/pages/contacts/__tests__/contactRecord.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../ContactDetail.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../styles/dealhub-tokens.css', import.meta.url), 'utf8');

const details = src.slice(src.indexOf('function Details('), src.indexOf('function Status('));

test('identity and fields are ONE card — no separate header', () => {
  assert.doesNotMatch(src, /<Header contact=/);
  assert.doesNotMatch(src, /function Header\(/);
  assert.match(details, />\s*Contact record\s*</);
  assert.match(details, /<TagStrip contactId=\{contact\.id\}/);
});

test('the fields are a ruled two-column table, in the design order', () => {
  assert.match(details, /className="pp-cc-fields pp-cc-fields-2"/);
  assert.match(css, /\.pp-cc-fields-2 \{\s*grid-template-columns: 1fr 1fr;/);
  const order = [...src.matchAll(/\['(\w+)', '[\w ]+', '\w+', '\w+'\]/g)].map((m) => m[1]);
  assert.deepEqual(order, ['firstName', 'lastName', 'email', 'phone', 'address', 'timezone']);
  // Business and contact type close the table.
  const biz = details.indexOf('<BusinessLink contact={contact}');
  const type = details.indexOf('>Contact type<');
  assert.ok(biz > 0 && type > biz, 'business then contact type, after the text fields');
});

test('cells edit in place and keep the batched Save', () => {
  assert.match(src, /function FieldCell\(/);
  assert.match(src, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); onSave\(\) \}/);
  assert.match(src, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); onCancel\(\) \}/);
  assert.match(details, /\$\{state === 'saving' \? 'Saving…' : `Save \$\{dirtyKeys\.length\}`\}|Save \$\{dirtyKeys\.length\}/);
});

test('contact type is still left out of the save', () => {
  // The update endpoint drops it — see PENDING_FUNCTIONALITY.md.
  assert.match(details, /const dirtyKeys = FIELDS\.map\(\(\[k\]\) => k\)\.filter\(isDirty\)/);
  assert.doesNotMatch(src, /\['contactType',/);
});

test('the back link is a solid slate pill', () => {
  assert.match(src, /background: 'var\(--gray-800\)', color: '#fff'/);
});

test('a zero-value deal shows £0', () => {
  assert.match(src, /d\.value != null && d\.value !== ''/);
});
