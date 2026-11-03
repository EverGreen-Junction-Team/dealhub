// Clearing a multi-select custom field.
//
// Run: node --test src/routes/__tests__/clearCustomField.test.mjs
//
// THE BUG. Emptying "Product system" sends { field_value: [] } to GHL and
// succeeds — the PATCH returns 200 and ghlOpportunityWrite logs "deal updated".
// GHL then fires OpportunityUpdate, but its payload OMITS the field it just
// emptied rather than reporting it as empty. stageHistoryWriter reads that
// absence through absent(), which returns undefined, binds NULL, and the
// UPSERT's COALESCE keeps the stored value:
//
//   COALESCE(EXCLUDED.product_system, opportunities.product_system)
//
// So the clear reached GHL and never reached us. The chip emptied, the refetch
// brought the old value back, and nothing was logged because nothing failed.
//
// The COALESCE is NOT the bug and must stay: a bare webhook carries no custom
// fields at all, so reading absence as "clear everything" would wipe every
// promoted column on each event.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../deals.js', import.meta.url), 'utf8');
const writer = readFileSync(
  new URL('../../services/stageHistoryWriter.js', import.meta.url),
  'utf8'
);

test('the PATCH applies cleared fields locally, after the GHL write', () => {
  // After, not before: if GHL rejects the change we must not have already
  // emptied our own column.
  const ghlAt = route.indexOf('const opportunity = await updateGhlOpportunity');
  const localAt = route.indexOf('await applyClearedCustomFields(');
  assert.ok(ghlAt > 0 && localAt > ghlAt, 'the local write must follow the GHL write');
});

test('only an EMPTY value counts as a clear', () => {
  // A field being SET is already carried by the webhook, which reports the
  // values it has. Writing those here too would be a second source of truth.
  assert.match(route, /Array\.isArray\(v\) \? v\.length === 0 : \(v === '' \|\| v === null\)/);
});

test('the column name comes from a fixed map, never from the request', () => {
  // It is interpolated into the SQL text, where a placeholder cannot be used.
  assert.match(route, /const CLEARABLE_COLUMNS = \{/);
  assert.match(route, /SET \$\{column\} = NULL/);
  // Both spellings of the inconsistent GHL key reach the same column.
  assert.match(route, /first_contact__method: 'first_contact_method'/);
  assert.match(route, /first_contact_method: 'first_contact_method'/);
});

test('a failed local write does not report the save as failed', () => {
  // The GHL write already succeeded. Telling the rep it failed would be false,
  // and the next event carrying the field reconciles us anyway.
  const fn = route.slice(route.indexOf('async function applyClearedCustomFields'));
  assert.match(fn, /logger\.warn\(/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /throw /);
});

test('the UPSERT still COALESCEs — absence is not a clear', () => {
  // The other half of the contract. If this is ever "fixed" to write
  // EXCLUDED directly, every bare webhook wipes all five promoted columns.
  assert.match(
    writer,
    /product_system\s+= COALESCE\(EXCLUDED\.product_system, opportunities\.product_system\)/
  );
});

test('absent() still distinguishes "not sent" from "cleared"', () => {
  // This is what makes the COALESCE above correct, and it is why the clear
  // has to be recorded by the route instead.
  assert.match(writer, /const absent = \(key, value\) => \(has\(key\) \? value : undefined\)/);
});
