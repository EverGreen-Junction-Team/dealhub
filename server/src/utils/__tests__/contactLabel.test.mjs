// A contact's display label must never be empty.
//
// WHY. Three routes built it as
//   [first_name, last_name].filter(Boolean).join(' ') || null
// and the dashboard renders it into <ContactChip name={c.name}>. A GHL contact
// with no first or last name — normal for one created from an inbound message,
// a web form, or a CSV import — yielded null, so the chip rendered with no
// text. In the task queue most rows showed NO contact at all despite having
// one linked, which is the bug that prompted this.
//
// The contract is simple and absolute: given a row, return something a rep can
// read. Never null, never empty, never the raw contact id.
import assert from 'node:assert/strict';
import { contactLabel } from '../contactLabel.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('contactLabel');

t('a full name wins', () => {
  assert.equal(contactLabel({ first_name: 'James', last_name: 'Stevens' }), 'James Stevens');
});

t('a first name alone is enough', () => {
  assert.equal(contactLabel({ first_name: 'James' }), 'James');
  assert.equal(contactLabel({ last_name: 'Stevens' }), 'Stevens');
});

t('falls back to the company — a B2B contact is often known only by their firm', () => {
  assert.equal(contactLabel({ company_name: 'Crittall Windows' }), 'Crittall Windows');
});

t('then the email, which a rep can actually act on', () => {
  assert.equal(contactLabel({ email: 'jaladanki@evergreenjunction.com' }),
    'jaladanki@evergreenjunction.com');
});

t('then the phone', () => {
  assert.equal(contactLabel({ phone: '+447700900123' }), '+447700900123');
});

t('the priority order holds when several are present', () => {
  const row = {
    first_name: 'James', last_name: 'Stevens',
    company_name: 'Crittall', email: 'j@x.com', phone: '+44'
  };
  assert.equal(contactLabel(row), 'James Stevens');
  assert.equal(contactLabel({ ...row, first_name: null, last_name: null }), 'Crittall');
  assert.equal(contactLabel({ ...row, first_name: null, last_name: null, company_name: null }), 'j@x.com');
});

t('NEVER empty — the whole point', () => {
  // Each of these produced null before, and therefore an invisible chip.
  for (const row of [
    {}, null, undefined,
    { first_name: null, last_name: null },
    { first_name: '', last_name: '' },
    { first_name: '   ', last_name: '  ' },
    { contact_id: 'Kf2bBEEvu8aJZ4Mo0Ikj' }
  ]) {
    const out = contactLabel(row);
    assert.ok(typeof out === 'string' && out.trim().length > 0,
      `empty label for ${JSON.stringify(row)}`);
  }
});

t('never leaks the contact id', () => {
  // An id in a chip reads as a rendering bug and tells a rep nothing — one
  // task in production displayed "Kf2bBEEvu8aJZ4Mo0Ikj" as its title.
  const out = contactLabel({ contact_id: 'Kf2bBEEvu8aJZ4Mo0Ikj', id: 'Kf2bBEEvu8aJZ4Mo0Ikj' });
  assert.equal(out, 'Unknown contact');
  assert.ok(!out.includes('Kf2b'), 'the id leaked into the label');
});

t('whitespace-only values are treated as absent', () => {
  assert.equal(contactLabel({ first_name: '  ', company_name: ' Crittall ' }), 'Crittall');
  assert.equal(contactLabel({ email: '   ' }), 'Unknown contact');
});

t('surrounding whitespace is trimmed', () => {
  assert.equal(contactLabel({ first_name: '  James  ', last_name: ' Stevens ' }), 'James Stevens');
});

t('non-string values do not crash or render as [object Object]', () => {
  // Postgres can hand back a number for a phone column.
  assert.equal(contactLabel({ phone: 447700900123 }), '447700900123');
  const out = contactLabel({ first_name: {}, email: 'a@b.com' });
  assert.ok(!out.includes('[object'), out);
});

t('never throws', () => {
  for (const v of [null, undefined, {}, 0, 'str', [], true]) {
    assert.doesNotThrow(() => contactLabel(v), JSON.stringify(v));
  }
});

console.log(`\n${n} passed`);
