// Appearance settings — services/uiPreferences.js.
//
// Run: node --test src/routes/__tests__/uiPreferences.test.mjs
//
// WHY THIS IS TESTED AND saved_views' FILTERS ARE NOT, QUITE THE SAME WAY.
// A bad saved filter shows the wrong rows. A bad stored `zoom` makes the
// whole dashboard unreadable INCLUDING the settings screen that would put it
// back, so the person is locked out of their own fix and has to be rescued
// with SQL. The range check is the thing standing between a typo and that,
// and it is worth a test that imports the real function rather than a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, cleanPrefs, resolve } from '../../services/uiPreferences.js';

test('the defaults are what the app shipped with', () => {
  // 0.85 was hardcoded in index.css before this feature existed. If it ever
  // changes here, every sub-account that never chose anything moves.
  assert.equal(DEFAULTS.zoom, 0.85);
  assert.equal(DEFAULTS.textScale, 1);
});

test('a good object passes through', () => {
  const { prefs, bad } = cleanPrefs({ zoom: 0.9, textScale: 1.1 });
  assert.equal(bad, null);
  assert.deepEqual(prefs, { zoom: 0.9, textScale: 1.1 });
});

test('a partial object stays partial', () => {
  // Writing only the key that was changed is what lets the other one keep
  // following the layer above it.
  const { prefs } = cleanPrefs({ textScale: 1.2 });
  assert.deepEqual(prefs, { textScale: 1.2 });
});

test('an unknown key is named, not ignored', () => {
  const { prefs, bad } = cleanPrefs({ zoom: 0.9, colour: 'blue' });
  assert.equal(prefs, null);
  assert.match(bad, /colour/);
});

test('a zoom that would make the app unusable is refused', () => {
  for (const zoom of [0, 0.05, 0.59, 1.21, 12]) {
    const { prefs, bad } = cleanPrefs({ zoom });
    assert.equal(prefs, null, `zoom ${zoom} should not be storable`);
    assert.match(bad, /zoom/);
  }
});

test('the ends of each range are allowed', () => {
  // An off-by-one here would make the slider's own extremes unsaveable,
  // which reads as the save button randomly failing.
  assert.equal(cleanPrefs({ zoom: 0.6 }).bad, null);
  assert.equal(cleanPrefs({ zoom: 1.2 }).bad, null);
  assert.equal(cleanPrefs({ textScale: 0.85 }).bad, null);
  assert.equal(cleanPrefs({ textScale: 1.3 }).bad, null);
});

test('a numeric string is accepted', () => {
  // A form field that never converted its value should not be a 400 the
  // user cannot explain.
  const { prefs, bad } = cleanPrefs({ zoom: '0.9' });
  assert.equal(bad, null);
  assert.deepEqual(prefs, { zoom: 0.9 });
});

test('nonsense is refused rather than coerced', () => {
  for (const v of ['big', '', null, undefined, {}, []]) {
    assert.equal(cleanPrefs({ zoom: v }).prefs, null, `zoom ${JSON.stringify(v)}`);
  }
});

test('float noise is rounded to something that compares equal', () => {
  // 0.85 + 0.05 in binary floating point is 0.9000000000000001. Stored raw,
  // the UI would never match it against a preset and the "Default" pill
  // would stop lighting up.
  const { prefs } = cleanPrefs({ zoom: 0.8500000000000001 });
  assert.equal(prefs.zoom, 0.85);
});

test('the top level is checked, not just the keys', () => {
  assert.equal(cleanPrefs(null).prefs, null);
  assert.equal(cleanPrefs('zoom=2').prefs, null);
  assert.equal(cleanPrefs([['zoom', 1]]).prefs, null);
});

// ── resolve ───────────────────────────────────────────────────────────

test('nothing stored anywhere gives the defaults', () => {
  assert.deepEqual(resolve(null, null), DEFAULTS);
});

test('a user beats the account', () => {
  assert.deepEqual(
    resolve({ zoom: 0.7 }, { zoom: 1 }),
    { zoom: 1, textScale: 1 }
  );
});

test('resolution is per key, not per row', () => {
  // THE RULE THE WHOLE FEATURE TURNS ON. Someone who only ever changed the
  // text size still follows the account's zoom — so when the account
  // changes it, they see the change. Merging whole rows would have frozen
  // their zoom at the moment they touched an unrelated slider.
  assert.deepEqual(
    resolve({ zoom: 0.7, textScale: 1 }, { textScale: 1.2 }),
    { zoom: 0.7, textScale: 1.2 }
  );
});

test('an account row fills in only what it sets', () => {
  assert.deepEqual(
    resolve({ textScale: 1.1 }, null),
    { zoom: DEFAULTS.zoom, textScale: 1.1 }
  );
});
