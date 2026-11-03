// What the DND panel says for a given contact.
//
// The switch means "this channel is REACHABLE", but it sits under a heading
// reading "Do not disturb" — so a contact with no DND set showed five toggles
// saying ON, which reads as "DND is on" rather than "we can reach them".
const isBlocked = (dnd, key) => {
  if (key === 'all') return dnd.all === true;
  if (key === 'inbound') return dnd.inbound === true;
  return dnd.all === true || dnd.channels?.[key] === true;
};
const metaFor = (dnd) => {
  const n = dnd.blockedCount || 0;
  return dnd.all ? 'Everything muted'
    : n > 0 ? `${n} channel${n === 1 ? '' : 's'} muted`
      : 'Nothing muted';
};
const accentFor = (dnd) =>
  (dnd.all || (dnd.blockedCount || 0) > 0 || dnd.inbound) ? 'rose' : 'gray';
// The switch now tracks DND ITSELF, matching GHL's checkbox: ON = muted.
const switchOn = (blocked) => blocked;
const switchLabel = (on) => (on ? 'MUTED' : 'OK');

import assert from 'node:assert/strict';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// The contact from the screenshot: every DND box unchecked in GHL.
const reachable = { all: false, inbound: false, channels: {}, blockedCount: 0 };

console.log('a contact with NO dnd set (4AdWSfZEs1mRbaNcCQsU)');

t('no channel reads as blocked', () => {
  for (const k of ['all', 'email', 'sms', 'call', 'inbound']) {
    assert.equal(isBlocked(reachable, k), false, k);
  }
});

t('the switch is OFF when nothing is muted', () => {
  // MATCHES GHL. Their panel ticks a box to turn DND on; ours read ON for a
  // reachable contact, so the same channel showed opposite states in the two
  // systems.
  assert.equal(switchOn(false), false);
  assert.equal(switchLabel(switchOn(false)), 'OK');
});

t('the header says "Nothing muted", not "All channels on"', () => {
  assert.equal(metaFor(reachable), 'Nothing muted');
});

t('the panel is NOT rose when nothing is muted', () => {
  // A permanently red panel over a fully reachable contact reads as a warning
  // about nothing.
  assert.equal(accentFor(reachable), 'gray');
});

console.log('\na contact WITH dnd set');

const muted = { all: false, inbound: false, channels: { email: true }, blockedCount: 1 };
t('the muted channel reads as blocked', () => {
  assert.equal(isBlocked(muted, 'email'), true);
  assert.equal(isBlocked(muted, 'sms'), false);
});
t('a muted channel switches ON and says MUTED', () => {
  assert.equal(switchOn(true), true, 'ON must mean muted, as in GHL');
  assert.equal(switchLabel(switchOn(true)), 'MUTED');
});
t('the header counts it', () => assert.equal(metaFor(muted), '1 channel muted'));
t('the panel turns rose', () => assert.equal(accentFor(muted), 'rose'));

const all = { all: true, inbound: false, channels: {}, blockedCount: 0 };
t('the master switch mutes every channel row', () => {
  for (const k of ['email', 'sms', 'call']) assert.equal(isBlocked(all, k), true, k);
});
t('and reads "Everything muted"', () => assert.equal(metaFor(all), 'Everything muted'));

t('inbound-only still turns the panel rose', () => {
  // It is not in blockedCount, so an accent keyed on that alone would miss it.
  assert.equal(accentFor({ all: false, inbound: true, channels: {}, blockedCount: 0 }), 'rose');
});

// ── The source must still say it this way ───────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'ContactDetail.jsx'), 'utf8');

console.log('\nthe component');

t('the switch tracks DND, not reachability', () => {
  // `on={blocked}` — the flip that aligns us with GHL.
  assert.match(src, /on=\{blocked\}/,
    'on={!blocked} is back — the switch would read opposite to the CRM');
  assert.match(src, /on \? 'MUTED' : 'OK'/);
});

t('a muted channel is rose, not green', () => {
  // Keying the colour to `on` without flipping it would paint a blocked
  // channel green.
  assert.match(src, /background: on \? 'var\(--status-stuck\)' : 'var\(--gray-300\)'/);
  assert.match(src, /color: on \? 'var\(--status-stuck\)' : 'var\(--green-600\)'/);
});

t('the screen-reader label says muted, not "on"', () => {
  assert.match(src, /\$\{on \? 'muted' : 'reachable'\}/);
});

t('the intro explains which way the switch runs', () => {
  assert.match(src, /Turn a channel <strong>on<\/strong> to stop contacting them/);
});

t('the header describes what is muted', () => {
  assert.match(src, /'Nothing muted'/);
  assert.ok(!/'All channels on'/.test(src),
    '"All channels on" under a "Do not disturb" heading reads backwards');
});

t('the accent is conditional, not always rose', () => {
  assert.match(src, /\? 'rose' : 'gray'/);
});

t('each row has both a reachable and a muted hint', () => {
  assert.match(src, /blocked \? mutedHint : okHint/);
});

console.log(`\n${n} passed`);
