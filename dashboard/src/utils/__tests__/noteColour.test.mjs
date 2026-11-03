// Note colour normalisation.
//
// WHY THIS IS TESTED. The value comes from GoHighLevel and lands in a CSS
// declaration. Anyone with access to the sub-account can set a note's colour,
// and inbound integrations write notes too — so this is attacker-influenceable
// data heading for `background: ${x}`. An unfiltered value like
// `red; background-image: url(//evil/x)` escapes the declaration it was meant
// to fill.
//
// The rule is an allow-list, matching what GHL itself accepts on write (#FFF
// or #FFAA00 and nothing else). The second contract is just as important for
// the UI: ANYTHING ELSE IS null, meaning "no colour" — never a fallback grey,
// because most notes have no colour and they must not all render as grey ones.
import assert from 'node:assert/strict';
import { normaliseNoteColour, noteColourName, noteColourStyle, NOTE_COLOURS }
  from '../noteColour.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('normaliseNoteColour — allow-list, and nothing else');

// ── Valid ───────────────────────────────────────────────────────────────
t('a 6-digit hex passes', () => {
  assert.equal(normaliseNoteColour('#FFF2B2'), '#FFF2B2');
});
t('lowercase is normalised up', () => {
  // So two spellings of one colour compare equal.
  assert.equal(normaliseNoteColour('#fff2b2'), '#FFF2B2');
});
t('a 3-digit hex expands', () => {
  assert.equal(normaliseNoteColour('#abc'), '#AABBCC');
  assert.equal(normaliseNoteColour('#FFF'), '#FFFFFF');
});
t('surrounding whitespace is trimmed', () => {
  assert.equal(normaliseNoteColour('  #d3f8df  '), '#D3F8DF');
});
t('the real value from the DB works', () => {
  // The colour that proved the server-side bug: ghl_sent_color true, stored null.
  assert.equal(normaliseNoteColour('#d3f8df'), '#D3F8DF');
});
t('every palette entry survives its own normaliser', () => {
  for (const [hex] of NOTE_COLOURS) {
    assert.equal(normaliseNoteColour(hex), hex.toUpperCase(), hex);
  }
});

// ── CSS injection: the reason this function exists ──────────────────────
console.log('\ninjection attempts must all yield null');
const attacks = [
  'red; background-image: url(//evil/x)',
  '#fff; background-image: url(//evil/x)',
  'url(javascript:alert(1))',
  'expression(alert(1))',
  '#fff}body{display:none}',
  '#fff/*',
  'var(--surface-card)',
  '#fff !important',
  'rgb(255,0,0)',
  'rgba(0,0,0,.5)',
  'yellow',
  'transparent',
  'inherit',
  '#fff\n;background:url(//evil)',
  '#ffff',            // 4 digits — not a form GHL accepts
  '#fffff',           // 5
  '#fffffff',         // 7
  '#ggg',             // non-hex
  '#12345g',
  'fff2b2',           // missing the hash
  '##fff',
  '#',
  ''
];
for (const a of attacks) {
  assert.equal(normaliseNoteColour(a), null, `not rejected: ${JSON.stringify(a)}`);
}
n++; console.log(`  ok  ${attacks.length} malformed / hostile values all rejected`);

t('a rejected value never leaks into the style helper', () => {
  const s = noteColourStyle('red; background-image: url(//evil/x)');
  assert.equal(s.stripe, null);
  assert.equal(s.tint, null);
  assert.equal(s.hex, null);
  // Belt and braces: no field may carry any of the payload through.
  for (const v of Object.values(s)) {
    assert.ok(v === null || !/evil|url|;/.test(String(v)), `leaked: ${v}`);
  }
});

// ── Non-strings ─────────────────────────────────────────────────────────
console.log('\nnon-strings and absent values');
t('null / undefined / missing yield null', () => {
  assert.equal(normaliseNoteColour(null), null);
  assert.equal(normaliseNoteColour(undefined), null);
});
t('numbers, objects, arrays, booleans yield null', () => {
  for (const v of [0, 42, {}, [], ['#fff'], true, false, NaN]) {
    assert.equal(normaliseNoteColour(v), null, String(v));
  }
});

// ── Naming ──────────────────────────────────────────────────────────────
console.log('\nnoteColourName');
t('a palette colour gets its name', () => {
  assert.equal(noteColourName('#FFF2B2'), 'Yellow');
  assert.equal(noteColourName('#c2f0e0'), 'Green');
});
t('an unknown colour gets its hex, not "Custom"', () => {
  // More useful to a rep asking why a note looks odd.
  assert.equal(noteColourName('#D3F8DF'), '#D3F8DF');
});
t('no colour has no name', () => {
  assert.equal(noteColourName(null), null);
  assert.equal(noteColourName('nonsense'), null);
});

// ── The style contract the rows depend on ───────────────────────────────
console.log('\nnoteColourStyle');
t('a coloured note gets a stripe, a tint and a name', () => {
  const s = noteColourStyle('#FFF2B2');
  assert.equal(s.hex, '#FFF2B2');
  assert.equal(s.stripe, '#FFF2B2');
  assert.equal(s.tint, '#FFF2B2');
  assert.equal(s.name, 'Yellow');
});
t('an uncoloured note gets NO stripe — not a grey one', () => {
  // The rule that keeps the majority of notes looking uncoloured rather than
  // uniformly grey.
  const s = noteColourStyle(null);
  assert.deepEqual(s, { hex: null, stripe: null, tint: null, name: null });
});
t('an unrecognised-but-valid hex still renders', () => {
  // A colour GHL added, or an older note. It must not vanish just because it
  // is not in our list — the list is for offering choices, not validating.
  const s = noteColourStyle('#d3f8df');
  assert.equal(s.stripe, '#D3F8DF');
  assert.equal(s.name, '#D3F8DF');
});

console.log(`\n${n} passed`);
