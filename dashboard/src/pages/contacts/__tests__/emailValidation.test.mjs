// Email validation on the contact details panel.
//
// Three problems, all visible in one screenshot:
//
//   1. The message rendered in Panel's `meta` slot, hardcoded to
//      --text-muted — the same grey as "Editable". A rejected save looked
//      like a status line.
//   2. The invalid field was tinted GREEN. That tint marks a field as dirty
//      ("this will be sent"), which is right until the save comes back
//      rejecting it — then green reads as success on the one field that
//      failed.
//   3. There was no client-side check at all, so a malformed address cost a
//      round trip before saying anything.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const detail = readFileSync(join(here, '..', 'ContactDetail.jsx'), 'utf8');
const chrome = readFileSync(join(here, '..', '..', 'shared', 'ListChrome.jsx'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// The rule, taken from the client. It must equal the server's.
const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

console.log('the address rule');

t('the value from the screenshot is refused', () => {
  assert.equal(isValidEmail('adfafd'), false);
});

t('ordinary addresses pass', () => {
  for (const good of [
    'jaladanki@evergreenjunction.com',
    'a@b.co',
    'first.last+tag@sub.domain.co.uk',
    "o'brien@example.com"
  ]) {
    assert.equal(isValidEmail(good), true, good);
  }
});

t('malformed addresses are refused', () => {
  for (const bad of [
    'adfafd', 'no-at-sign.com', '@nolocal.com', 'nodomain@',
    'no@tld', 'two@@at.com', 'spa ce@x.com', 'trailing@space .com'
  ]) {
    assert.equal(isValidEmail(bad), false, bad);
  }
});

t('the client rule MATCHES the server character for character', () => {
  // A stricter client would refuse addresses the API accepts; a looser one
  // would let the round trip happen and change nothing.
  const server = readFileSync(
    join(here, '..', '..', '..', '..', '..', 'pipelinePulse', 'server',
      'src', 'services', 'contactPatch.js'), 'utf8');
  const serverRe = /\/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$\//;
  assert.match(server, serverRe, 'the server rule changed — update this one to match');
  assert.match(detail, serverRe, 'the client rule does not match the server');
});

console.log('\nhow the failure is shown');

t('the check runs BEFORE the request', () => {
  assert.match(detail, /if \(dirtyKeys\.includes\('email'\)\)/,
    'a malformed address must not cost a round trip');
});

t('an empty email is allowed through — clearing is not invalid', () => {
  // `email && !isValid` — a blank field means "no address", which is a
  // legitimate state, not a malformed one.
  assert.match(detail, /if \(email && !\//);
});

t('the message is red and announced, not muted grey', () => {
  assert.match(chrome, /metaTone = 'muted'/);
  // Red on the PALE panel, which is what every tab but Deal hub renders. On a
  // solid header band (--panel-head-*) red on clay or plum is unreadable, so
  // the failure stays white there and leans on its icon, weight and the
  // role="alert" below — which is what actually reports it in both cases.
  assert.match(chrome, /solidHeader \? '#fff' : 'var\(--status-stuck-text\)'/);
  assert.match(chrome, /role=\{metaTone === 'error' \? 'alert' : undefined\}/,
    'a screen reader user gets no colour — the failure must be announced');
  assert.match(detail, /metaTone=\{state === 'error' \? 'error' : 'muted'\}/);
});

t('the REJECTED field beats the DIRTY highlight', () => {
  // Measured: the dirty tint is rgb(216,237,228) — green. On the field that
  // was just rejected that reads as success.
  assert.match(detail, /errorField === key\s*\n?\s*\? 'var\(--status-stuck\)'/);
  assert.match(detail, /errorField === key\s*\n?\s*\? 'var\(--tint-rose\)'/);
  assert.match(detail, /aria-invalid=\{errorField === key \|\| undefined\}/);
});

t('editing the rejected field clears the complaint', () => {
  // Otherwise the red highlight stays on a now-valid address.
  assert.match(detail, /if \(errorField === key\) \{/);
});

console.log(`\n${n} passed`);
