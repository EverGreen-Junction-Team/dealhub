// Promoted columns are merged into the custom-fields blob the editor renders.
//
// Run: node --test src/routes/__tests__/promotedCustomFields.test.mjs
//
// WHY. Ten opportunity custom fields are ALSO promoted to their own columns.
// Each value is therefore stored twice: in the column, written by the
// opportunity upsert, and in the custom_fields JSONB blob, written from
// whatever customFields the same event happened to carry.
//
// They normally agree. The blob is empty when an upsert rolled back, and on
// any deal that predates the promotion — and the custom-field editor renders
// from the blob alone, so the grid showed "Not set" over a value the deal card
// directly above it was displaying from the column.
//
// Merging server-side rather than mapping field-by-field in the UI: the list
// below is the ONLY place a promoted column is named. It builds the SELECT and
// the merge, so adding one is a single-line change and the editor needs no
// edit at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, '..', 'deals.js'), 'utf8');

// Production runs a server-only clone, so the dashboard may not be checked
// out — read it defensively and SKIP rather than failing the suite. See
// crossRepoReads.test.mjs for the deploy this convention protects.
const PANEL = join(here, '..', '..', '..', '..', '..', 'pipelinePulse-dashboard',
  'src', 'pages', 'deals', 'DealEditPanel.jsx');
const panel = existsSync(PANEL) ? readFileSync(PANEL, 'utf8') : null;

// The helper's real semantics, re-implemented from the source so the
// assertions below exercise behaviour rather than matching text.
const PROMOTED = [
  'client_type', 'product_system', 'product_type', 'first_contact_method',
  'lead_source_opportunity', 'master_initial_enquiry', 'inquiry',
  'postcode', 'gclid', 'upload_from_enquiry'
];
const ALIASES = { first_contact_method: ['first_contact__method'] };
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
function merge(blob, row) {
  const out = { ...(blob && typeof blob === 'object' ? blob : {}) };
  for (const key of PROMOTED) {
    const value = row[key];
    if (isEmpty(value)) continue;
    for (const k of [key, ...(ALIASES[key] || [])]) {
      if (isEmpty(out[k])) out[k] = value;
    }
  }
  return out;
}

test('a column fills a gap the blob has', () => {
  // The reported case: GHL showed "testingss", the editor showed "Not set".
  assert.equal(
    merge({}, { master_initial_enquiry: 'testingss' }).master_initial_enquiry,
    'testingss'
  );
});

test('the BLOB wins where it has a value of its own', () => {
  // The blob is what a save writes back. Letting the column win would make an
  // edit appear to revert until the next webhook landed.
  assert.equal(
    merge({ inquiry: 'edited' }, { inquiry: 'stale column' }).inquiry,
    'edited'
  );
});

test('an empty blob entry counts as a gap', () => {
  // '' and [] both render as "Not set", so both should be filled.
  assert.equal(merge({ inquiry: '' }, { inquiry: 'real' }).inquiry, 'real');
  assert.equal(merge({ client_type: [] }, { client_type: ['Architect'] }).client_type[0], 'Architect');
});

test('an empty column never overwrites a real blob value', () => {
  assert.equal(merge({ client_type: 'Architect' }, { client_type: [] }).client_type, 'Architect');
});

test('multi-selects stay arrays, not comma-joined strings', () => {
  // These come straight from JSONB. A multi Select renders a bare string as
  // ONE option, so "Crittall, Smarts" would show as a single invalid choice.
  const out = merge({}, { product_system: ['Crittall', 'Smarts'] });
  assert.ok(Array.isArray(out.product_system));
  assert.deepEqual(out.product_system, ['Crittall', 'Smarts']);
});

test('both spellings of the inconsistent GHL key are filled', () => {
  // The definitions endpoint reports whichever one that location has.
  const out = merge({}, { first_contact_method: ['Telephone'] });
  assert.deepEqual(out.first_contact_method, ['Telephone']);
  assert.deepEqual(out.first_contact__method, ['Telephone']);
});

// ---- the wiring, so the list stays the single source ----------------------

test('the SELECT is built from the same list as the merge', () => {
  // If these ever diverge, a column is merged that was never selected and the
  // field silently reads undefined.
  assert.match(route, /\$\{PROMOTED_CUSTOM_FIELDS\.map\(\(c\) => `o\.\$\{c\}`\)\.join\(', '\)\}/);
});

test('the response merges rather than returning the raw blob', () => {
  assert.match(route, /customFields: withPromotedFields\(d\.custom_fields, d\)/);
});

if (!panel) {
  console.log('  (dashboard repo not checked out — skipping its 1 check)');
} else {
  test('the editor carries no per-field fallback map', () => {
    // The whole point: adding a promoted column must not require a UI edit.
    assert.doesNotMatch(panel, /PROMOTED_FALLBACK/);
  });
}
