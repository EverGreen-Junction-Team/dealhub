// Editing a contact's custom fields.
//
// The riskiest part is not the rendering — it is what goes on the wire.
// GHL accepts several shapes for `customFields` and SILENTLY IGNORES the
// wrong ones, so a bad value produces a successful save and an unchanged
// field. That is worse than an error, because nothing tells the rep.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const detail = readFileSync(join(here, '..', 'ContactDetail.jsx'), 'utf8');
const sections = readFileSync(join(here, '..', '..', 'shared', 'CustomFieldSections.jsx'), 'utf8');

// normaliseOut, mirrored from ContactDetail.
const normaliseOut = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(',');
  return v;
};

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('what goes on the wire');

t('a multi-select becomes a comma-joined string', () => {
  // GHL stores a CHECKBOX field as a joined string on the contact. Sending
  // the array is a shape it accepts and then ignores.
  assert.equal(normaliseOut(['Homeowner', 'Architect']), 'Homeowner,Architect');
});

t('a single value passes through', () => {
  assert.equal(normaliseOut('Cortizo'), 'Cortizo');
});

t('a cleared field sends an empty string, not null', () => {
  // Dropping the key leaves the OLD value in place, so a clear must be
  // explicit.
  assert.equal(normaliseOut(null), '');
  assert.equal(normaliseOut(undefined), '');
});

t('an emptied multi-select clears rather than sending "[]"', () => {
  assert.equal(normaliseOut([]), '');
});

t('a number survives — not every field is text', () => {
  assert.equal(normaliseOut(42), 42);
  assert.equal(normaliseOut(0), 0, 'zero is a real answer, not an empty one');
});

t('false survives — a checkbox set to no is an answer', () => {
  assert.equal(normaliseOut(false), false);
});

console.log('\nonly what changed is sent');

t('the patch is built from the DIRTY ids, not every field', () => {
  // Forty fields behind one Save would rewrite values the rep never touched,
  // and an unrelated failure would look like their edit failed.
  assert.match(detail, /const dirtyIds = Object\.keys\(draft\)/);
  assert.match(detail, /dirtyIds\.map\(\(id\) => \(\{/);
});

t('it sends field_value in SNAKE case', () => {
  // The one key in GHL's contact body that is not camelCase. fieldValue is
  // accepted by the request and then ignored.
  assert.match(detail, /field_value: normaliseOut\(draft\[id\]\)/);
});

t('the save bar only appears once something changed', () => {
  assert.match(detail, /dirtyIds\.length > 0 && \(/);
});

console.log('\nthe sections');

t('the first folder is open, the rest closed', () => {
  // Eight folders open at once would bury the contact's name and phone.
  //
  // Now gated on openFirst, which DEFAULTS to true — so contacts, which do
  // not pass it, keep this behaviour. Deals pass false: one folder there holds
  // 22 fields and opening it pushes People, Tasks and Notes off the screen.
  assert.match(sections, /openFirst && groups\.length \? \[groups\[0\]\.id \?\? '__ungrouped__'\] : \[\]/);
  assert.match(sections, /openFirst = true/, 'the default must stay true or contacts change too');
});

t('a deal starts with every folder closed', () => {
  const panel = readFileSync(join(here, '..', '..', 'deals', 'DealEditPanel.jsx'), 'utf8');
  assert.match(panel, /openFirst=\{false\}/);
});

t('FILE_UPLOAD renders a real picker', () => {
  // These were read-only on the claim that GHL has no upload API for them.
  // It does — POST /locations/:id/customFields/upload — so "Upload files in
  // your CRM" was telling a rep to go elsewhere for no reason.
  assert.match(sections, /if \(field\.upload\)/);
  assert.match(sections, /<FileField/);
  assert.ok(!/Upload files in your CRM/.test(sections),
    'the read-only message is back');
});

t('a file field with no upload handler still shows what is stored', () => {
  // The handler is optional; without it the field degrades to a list of
  // links rather than vanishing.
  assert.match(sections, /existing\.length === 0 && <span className="pp-cf-empty">No file<\/span>/);
});

t('uploads fire immediately, not on Save', () => {
  // A file is not a draft value — it goes to GHL storage and comes back as a
  // URL. Batching would also discard a successful upload when a text field
  // in the same Save is rejected.
  assert.match(sections, /const uploaded = await onUpload\(field\.key \|\| field\.id, files\)/);
});

t('a second file APPENDS rather than replacing', () => {
  // A multi-file field accumulates; replacing would silently drop whatever
  // was already attached.
  assert.match(sections, /\[\.\.\.existing\.map\(\(f\) => f\.url\), \.\.\.uploaded\.map\(\(f\) => f\.url\)\]/);
});

t('the field maxFiles is respected', () => {
  assert.match(sections, /const full = max \? existing\.length >= max : false/);
});

t('picking the same file twice still fires', () => {
  // Without clearing the input, a re-pick of the same filename is not a
  // change event and nothing happens.
  assert.match(sections, /e\.target\.value = ''/);
});

t('an unknown field type still renders as text', () => {
  // A type we do not recognise is better shown than hidden, and text
  // round-trips through GHL unchanged.
  assert.match(sections, /TEXT, NUMERICAL, PHONE, MONETARY and anything unrecognised/);
});

t('multi and single choice types are distinguished', () => {
  assert.match(sections, /const MULTI = new Set\(\['CHECKBOX', 'MULTIPLE_OPTIONS'\]\)/);
  assert.match(sections, /const SINGLE = new Set\(\['SINGLE_OPTIONS', 'DROPDOWN', 'RADIO'\]\)/);
});

t('a location with no custom fields renders nothing', () => {
  // Not an error — an ordinary setup. A panel saying "no custom fields"
  // would be noise on every contact.
  assert.match(detail, /if \(!groups\.length\) \{/);
});

console.log(`\n${n} passed`);
