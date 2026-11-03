import assert from 'node:assert/strict';
import {
  customFieldsFrom, resolveCustomFieldArray, fieldValueOf, shortKey
} from '../customFieldResolve.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// The location's real ids, shape as customFieldsSync stores them.
const MAP = {
  'cf_client': 'opportunity.client_type',
  'cf_sys':    'opportunity.product_system',
  'cf_first':  'opportunity.first_contact__method',
  'cf_lead':   'opportunity.lead_source_opportunity'
};

console.log('customFieldResolve');

t('resolves a raw array by id, stripping the opportunity. prefix', () => {
  const cf = resolveCustomFieldArray(
    [{ id: 'cf_client', fieldValue: 'Trade' }, { id: 'cf_sys', fieldValue: 'W20' }],
    MAP
  );
  assert.deepEqual(cf, { client_type: 'Trade', product_system: 'W20' });
});

t('keeps GHL\'s double-underscore key verbatim', () => {
  // first_contact__method is GHL's own typo and is the real key. Normalising
  // it to a single underscore would break the promoted lookup.
  const cf = resolveCustomFieldArray([{ id: 'cf_first', fieldValue: 'Phone' }], MAP);
  assert.deepEqual(cf, { first_contact__method: 'Phone' });
});

t('carries a checkbox array through as an array', () => {
  const cf = resolveCustomFieldArray(
    [{ id: 'cf_sys', fieldValueArray: ['W20', 'Corporate 45'] }], MAP
  );
  assert.deepEqual(cf.product_system, ['W20', 'Corporate 45']);
});

t('prefers an entry\'s own fieldKey over the map', () => {
  const cf = resolveCustomFieldArray(
    [{ id: 'unknown_id', fieldKey: 'opportunity.client_type', fieldValue: 'Retail' }], {}
  );
  assert.deepEqual(cf, { client_type: 'Retail' });
});

t('keeps an unmapped id rather than dropping the value', () => {
  const cf = resolveCustomFieldArray([{ id: 'cf_mystery', fieldValue: 'x' }], MAP);
  assert.deepEqual(cf, { cf_mystery: 'x' });
});

t('preserves an explicit empty string — a cleared field is not an absent one', () => {
  const cf = resolveCustomFieldArray([{ id: 'cf_client', fieldValue: '' }], MAP);
  assert.ok(Object.prototype.hasOwnProperty.call(cf, 'client_type'));
  assert.equal(cf.client_type, '');
});

t('enriched object wins over a raw array', () => {
  const cf = customFieldsFrom({
    customFieldsResolved: { client_type: 'Trade' },
    customFields: [{ id: 'cf_client', fieldValue: 'STALE' }]
  }, MAP);
  assert.equal(cf.client_type, 'Trade');
});

t('passes a plain customFields object through', () => {
  assert.deepEqual(customFieldsFrom({ customFields: { client_type: 'Trade' } }, MAP),
    { client_type: 'Trade' });
});

t('returns {} for a webhook with no custom fields at all', () => {
  // Must stay empty, not invent keys: the promoted block treats a missing key
  // as "GHL did not send it" and skips it. Inventing nulls here would restore
  // the field-history write loop.
  assert.deepEqual(customFieldsFrom({}, MAP), {});
  assert.deepEqual(customFieldsFrom({ customFields: null }, MAP), {});
});

t('shortKey strips both prefixes and tolerates junk', () => {
  assert.equal(shortKey('opportunity.client_type'), 'client_type');
  assert.equal(shortKey('contact.utm_source'), 'utm_source');
  assert.equal(shortKey('client_type'), 'client_type');
  assert.equal(shortKey(null), '');
});

t('fieldValueOf prefers fieldValue and falls back in order', () => {
  assert.equal(fieldValueOf({ fieldValue: 'a', value: 'b' }), 'a');
  assert.equal(fieldValueOf({ value: 'b' }), 'b');
  assert.equal(fieldValueOf({ fieldValueString: 'c' }), 'c');
  assert.deepEqual(fieldValueOf({ fieldValueArray: ['d'] }), ['d']);
  assert.equal(fieldValueOf(null), null);
});

// ---- the multi-select truncation ------------------------------------------
//
// Reported as: pick two product systems, the chip shows both, switch tabs and
// only the first is left. The save was never the problem — the read back was.

t('a multi-select keeps every choice when BOTH carriers are sent', () => {
  // This is the real GHL payload for a checkbox field: fieldValue holds only
  // the FIRST selection and fieldValueArray holds all of them. Reading
  // fieldValue first stored 'Crittall' and dropped 'Smarts'.
  assert.deepEqual(
    fieldValueOf({ fieldValue: 'Crittall', fieldValueArray: ['Crittall', 'Smarts'] }),
    ['Crittall', 'Smarts']
  );
  assert.deepEqual(
    fieldValueOf({ value: 'Crittall', fieldValueArray: ['Crittall', 'Smarts'] }),
    ['Crittall', 'Smarts']
  );
});

t('an EMPTY array never beats a real scalar', () => {
  // A single-option field can carry fieldValueArray: [] beside its value.
  // Preferring the array unconditionally would turn every single-select into
  // "Not set" — trading one silent data loss for a wider one.
  assert.equal(fieldValueOf({ fieldValue: 'Architect', fieldValueArray: [] }), 'Architect');
  assert.equal(fieldValueOf({ fieldValue: 'Architect' }), 'Architect');
});

t('a multi-select survives the whole resolve path', () => {
  const out = resolveCustomFieldArray(
    [{ id: 'cf_sys', fieldValue: 'Crittall', fieldValueArray: ['Crittall', 'Smarts'] }],
    { cf_sys: 'opportunity.product_system' }
  );
  assert.deepEqual(out.product_system, ['Crittall', 'Smarts']);
});

// ---- the reported bug, end to end -----------------------------------------
t('REGRESSION: the old array branch dropped every promoted field', () => {
  // The exact payload GHL echoes after our own PUT sets client_type.
  const webhook = {
    id: 'dA7nI2NBTzr1MGj926EW',
    customFields: [{ id: 'cf_client', fieldValue: 'Trade' }]
  };

  // What the code used to do.
  const old = webhook.customFieldsResolved
    || (Array.isArray(webhook.customFields) ? {} : (webhook.customFields || {}));
  assert.deepEqual(old, {}, 'old behaviour: array discarded');
  assert.equal(Object.prototype.hasOwnProperty.call(old, 'client_type'), false,
    'so absent() returned undefined and the column was never written');

  // What it does now.
  const now = customFieldsFrom(webhook, MAP);
  assert.equal(now.client_type, 'Trade');
});

console.log(`\n${passed} passed`);

// ---- jsonbParam ------------------------------------------------------------
const { jsonbParam } = await import('../customFieldResolve.js');

t('a resolved multi-select binds as a real JSON array', () => {
  // The other half of the same bug: the column is JSONB, and a value stored as
  // a quoted string ("[\"a\"]") reads back as text rather than as two choices.
  const out = resolveCustomFieldArray(
    [{ id: 'cf_sys', fieldValue: 'Crittall', fieldValueArray: ['Crittall', 'Smarts'] }],
    { cf_sys: 'opportunity.product_system' }
  );
  assert.equal(jsonbParam(out.product_system), '["Crittall","Smarts"]');
});
let p2 = 0;
const t2 = (name, fn) => { fn(); p2++; console.log(`  ok  ${name}`); };
console.log('\njsonbParam');

t2('serializes an array to JSON, not a Postgres array literal', () => {
  // The exact value from the failing webhook. node-postgres would otherwise
  // send {"Interior Designer","Contractor"} and JSONB rejects it (22P02).
  assert.equal(jsonbParam(['Interior Designer', 'Contractor']),
    '["Interior Designer","Contractor"]');
});

t2('passes null and undefined through as null', () => {
  assert.equal(jsonbParam(null), null);
  assert.equal(jsonbParam(undefined), null);
});

t2('wraps a bare scalar into a single-element array', () => {
  assert.equal(jsonbParam('Trade'), '["Trade"]');
  assert.equal(jsonbParam(7), '[7]');
});

t2('does not double-encode already-serialized JSON', () => {
  assert.equal(jsonbParam('["Trade"]'), '["Trade"]');
  assert.equal(jsonbParam('{"a":1}'), '{"a":1}');
});

t2('serializes a plain object', () => {
  assert.equal(jsonbParam({ a: 1 }), '{"a":1}');
});

t2('result is always valid JSON or null', () => {
  for (const v of [['a'], 'x', 7, { a: 1 }, [], ['a', 'b']]) {
    const out = jsonbParam(v);
    assert.doesNotThrow(() => JSON.parse(out), `invalid JSON for ${JSON.stringify(v)}`);
  }
  // An empty array stays an empty array — NOT null. A rep clearing every
  // checkbox is a real change and must not read as "not sent".
  assert.equal(jsonbParam([]), '[]');
});

console.log(`\n${p2} passed`);
