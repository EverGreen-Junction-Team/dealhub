// What each row in the deal switcher says.
//
// The search matches on the deal name AND the contact's name, email, phone
// and business. But the row only ever showed the deal name, stage and owner —
// so a result found by email appeared with nothing on it explaining why, and
// two deals both default-named after their contact were indistinguishable.
//
// contactLine, mirrored from DealHubTab.
function contactLine(d) {
  const c = d.contact || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  const label = name || c.business || c.email || c.phone || null;
  if (!label) return null;
  if (label.trim().toLowerCase() === String(d.dealTag || '').trim().toLowerCase()) return null;
  if (name && c.email) return `${name} · ${c.email}`;
  return label;
}

import assert from 'node:assert/strict';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('what the second line says');

t('the deal from the screenshot shows its contact', () => {
  // Searched "jsm", matched on the contact's email. Nothing on the row
  // explained why it appeared.
  assert.equal(
    contactLine({ dealTag: 'jsmillie', contact: { firstName: 'test', lastName: 'test', email: 'jsmillie13579@gmail.com' } }),
    'test test · jsmillie13579@gmail.com');
});

t('it is SUPPRESSED when it would repeat the deal name', () => {
  // GHL default-names an opportunity after its contact, so most rows would
  // otherwise print the same string twice.
  assert.equal(
    contactLine({ dealTag: 'Alison Smith', contact: { firstName: 'Alison', lastName: 'Smith' } }),
    null);
});

t('case and padding do not defeat the suppression', () => {
  assert.equal(
    contactLine({ dealTag: 'alison smith', contact: { firstName: '  Alison', lastName: 'Smith  ' } }),
    null);
});

t('a nameless contact falls back to business, email, then phone', () => {
  assert.equal(contactLine({ dealTag: 'X', contact: { business: 'Cortec Ltd' } }), 'Cortec Ltd');
  assert.equal(contactLine({ dealTag: 'X', contact: { email: 'a@b.com' } }), 'a@b.com');
  assert.equal(contactLine({ dealTag: 'X', contact: { phone: '+447885909888' } }), '+447885909888');
});

t('a named contact with no email shows just the name', () => {
  assert.equal(contactLine({ dealTag: 'X', contact: { firstName: 'Ed', lastName: 'Rose' } }), 'Ed Rose');
});

t('no contact yields null, not an empty row', () => {
  assert.equal(contactLine({ dealTag: 'Website Lead Form', contact: null }), null);
  assert.equal(contactLine({ dealTag: 'X' }), null);
  assert.equal(contactLine({ dealTag: 'X', contact: {} }), null);
});

t('an untitled deal still shows its contact', () => {
  // dealTag empty: the suppression must not fire on '' === ''.
  assert.equal(contactLine({ dealTag: '', contact: { firstName: 'Ed', lastName: 'Rose' } }), 'Ed Rose');
});

// ── The source still renders it ──────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const hub = readFileSync(join(here, '..', 'DealHubTab.jsx'), 'utf8');

console.log('\nthe row');

t('the deal name leads, in heading weight', () => {
  assert.match(hub, /\{d\.dealTag \|\| 'Untitled deal'\}/,
    'an unnamed deal must not render a blank first line');
  assert.match(hub, /fontWeight: 600, color: 'var\(--text-heading\)'/);
});

t('the contact line is rendered', () => {
  assert.match(hub, /\{contactLine\(d\) && \(/);
  assert.match(hub, /function contactLine\(d\)/);
});

t('stage and owner are still there, quieter', () => {
  assert.match(hub, /\[d\.stage, d\.owner\]\.filter\(Boolean\)\.join\(' · '\)/);
});

// ── The selected row ─────────────────────────────────────────────────────
//
// It was a solid brand-primary fill with `color: #fff` on the container. But
// the three inner spans each set their OWN colour (--text-heading,
// --text-body, --text-muted), so the row-level white never applied and dark
// text sat on dark green. Measured: the stage line and the value were both
// 1.30:1 — effectively invisible.
console.log('\nthe selected row');

t('a tint, not a solid fill', () => {
  // Fixing the white would mean overriding three nested colours for one
  // state. A tint lets every text colour keep working as designed.
  assert.match(hub, /background: active \? 'var\(--tint-pine\)' : '#fff'/);
  // Scoped to the SWITCHER ROW. Two pill buttons elsewhere in this file use
  // the same solid fill and are fine — they hold a single text node, so the
  // container's white actually applies. Only this row has nested spans that
  // override it.
  const rowBlock = /const active = d\.id === dealId[\s\S]{0,2600}?marginBottom: 2/.exec(hub);
  assert.ok(rowBlock, 'the switcher row block moved — rescope this test');
  assert.ok(!/background: active \? 'var\(--brand-primary\)'/.test(rowBlock[0]),
    'the solid fill is back on the row — the stage line drops to 1.30:1');
});

t('the text colour is no longer overridden per state', () => {
  // `color: active ? '#fff' : ...` was the lie: it never reached the spans.
  const rowBlock2 = /const active = d\.id === dealId[\s\S]{0,2600}?marginBottom: 2/.exec(hub);
  assert.match(rowBlock2[0], /color: 'var\(--text-body\)',/);
  assert.ok(!/color: active \? '#fff'/.test(rowBlock2[0]),
    'the per-state text colour is back — it never reached the spans anyway');
});

t('a left rail carries the selection', () => {
  // The tint alone is subtle; the rail is what makes it unmistakable, and it
  // is the convention the rest of the app already uses.
  assert.match(hub, /borderLeft: active \? '3px solid var\(--brand-primary\)' : 'none'/);
});

t('the rail eats padding rather than shifting the text', () => {
  // 10 - 3 = 7. Without this a selected row's text sits 3px right of every
  // other row's, and the list visibly jitters as you arrow through it.
  assert.match(hub, /paddingLeft: active \? 7 : 10/);
});

console.log(`\n${n} passed`);
