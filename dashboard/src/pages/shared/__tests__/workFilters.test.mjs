// The Tasks / Notes filter drawer — the client's October 2026 "Filter notes"
// design.
//
// Run: node --test src/pages/shared/__tests__/workFilters.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../WorkFilters.jsx', import.meta.url), 'utf8');
const contacts = readFileSync(new URL('../../contacts/ContactFilters.jsx', import.meta.url), 'utf8');

test('the drawer is titled for its tab', () => {
  assert.match(src, />\s*Filter \{noun\}\s*</);
});

test('choices are staged behind Clear all · Cancel · Apply', () => {
  const foot = src.slice(src.indexOf('<footer'));
  assert.ok(foot.length > 7, 'the footer is missing');
  for (const label of ['Clear all', 'Cancel', 'Apply']) {
    assert.match(foot, new RegExp(`>\\s*${label}\\s*<`), `${label} missing from the footer`);
  }
  // Nothing reaches the list until Apply.
  assert.match(src, /onClick=\{\(\) => \{ onChange\(draft\); setOpen\(false\) \}\}/);
  assert.match(src, /const update = \(patch\) => setDraft\(/);
});

test('changing the contact clears a deal chosen under the old one', () => {
  assert.match(src, /update\(\{ contactId: id, dealId: undefined \}\)/);
});

test('Tasks, Notes and Contacts open filters with the same pill', () => {
  assert.match(src, /export function FiltersButton\(/);
  assert.match(src, /borderRadius: 'var\(--radius-pill\)'/);
  assert.match(contacts, /import \{ FiltersButton \} from '\.\.\/shared\/WorkFilters'/);
  assert.match(contacts, /<FiltersButton/);
});
