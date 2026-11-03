// A CHECKBOX custom field written into a BOOLEAN column.
//
// THIS BUG LOST OPPORTUNITIES SILENTLY.
//
// GHL sends a checkbox as an array of the TICKED LABELS:
//
//   ["I agree to receive occasional marketing communications (e.g. offers
//     and updates) from Bespoke Glazing Design."]
//
// contacts.marketing_consent is BOOLEAN, and the value was passed through
// untouched — so node-postgres serialised the array as a Postgres array
// literal and the insert died:
//
//   22P02 invalid input syntax for type boolean: "{"I agree to receive…"}"
//
// upsertContact runs inside the opportunity write's transaction, so the WHOLE
// write rolled back. Every OpportunityUpdate for a consenting contact was
// discarded — the opportunity never reached our database. The webhook still
// answered 200 and GHL does not redeliver, so the loss was permanent and
// invisible: a deal plainly visible in GHL was missing from the app, from the
// deal list, and from search.
//
// That is how "jsmillie1" went missing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'stageHistoryWriter.js'), 'utf8');

// Lifted from the source so this tests the shipped function, not a copy.
const start = src.indexOf('function asConsentBoolean(v) {');
assert.notEqual(start, -1, 'asConsentBoolean is gone — the 22P02 would return');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const asConsentBoolean = new Function(`${src.slice(start, end)}; return asConsentBoolean;`)();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Verbatim from the production log.
const REAL = ['I agree to receive occasional marketing communications '
  + '(e.g. offers and updates) from Bespoke Glazing Design.'];

console.log('the value that broke it');

t('the exact failing payload becomes true', () => {
  assert.equal(asConsentBoolean(REAL), true);
});

t('and it is a BOOLEAN, not a string or an array', () => {
  // Anything else and Postgres rejects it again.
  assert.equal(typeof asConsentBoolean(REAL), 'boolean');
});

t('the crittall variant too', () => {
  assert.equal(asConsentBoolean(['Marketing Consent']), true);
});

console.log('\nticked, unticked, absent');

t('an EMPTY array is false — explicitly not ticked', () => {
  assert.equal(asConsentBoolean([]), false);
});

t('an array of blanks is false, not true', () => {
  // [''] has length 1; counting entries rather than non-empty ones would
  // read a cleared checkbox as consent.
  assert.equal(asConsentBoolean(['', '  ']), false);
});

t('ABSENT stays null — not the same as declined', () => {
  // The column is nullable so "never asked" and "said no" stay different.
  // Consent is exactly the field where that distinction matters.
  assert.equal(asConsentBoolean(null), null);
  assert.equal(asConsentBoolean(undefined), null);
  assert.equal(asConsentBoolean(''), null);
  assert.equal(asConsentBoolean('   '), null);
});

console.log('\nother shapes GHL has sent');

t('a real boolean passes through', () => {
  assert.equal(asConsentBoolean(true), true);
  assert.equal(asConsentBoolean(false), false);
});

t('falsey strings are false, not true', () => {
  // String('false') is truthy in JS — the trap this guards.
  for (const v of ['false', 'no', 'off', '0', 'null', 'undefined', 'FALSE', ' No ']) {
    assert.equal(asConsentBoolean(v), false, v);
  }
});

t('a meaningful string is true', () => {
  for (const v of ['yes', 'true', 'on', '1', 'I agree']) {
    assert.equal(asConsentBoolean(v), true, v);
  }
});

t('numbers behave', () => {
  assert.equal(asConsentBoolean(1), true);
  assert.equal(asConsentBoolean(0), false);
});

t('never returns a non-boolean except null', () => {
  // A single stray array or string reaching the column is another 22P02 and
  // another silently discarded opportunity.
  for (const v of [REAL, [], ['a'], true, false, 0, 1, 'x', 'no', null, undefined, '', {}, [[]]]) {
    const out = asConsentBoolean(v);
    assert.ok(out === null || typeof out === 'boolean',
      `got ${typeof out} (${JSON.stringify(out)}) for ${JSON.stringify(v)}`);
  }
});

console.log('\nthe writer uses it');

t('the promoted field is coerced, not passed through', () => {
  assert.match(src, /marketing_consent: asConsentBoolean\(/,
    'the raw custom-field value is reaching a BOOLEAN column again');
});

console.log(`\n${n} passed`);
