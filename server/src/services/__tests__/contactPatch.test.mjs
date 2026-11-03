// Tests for the contact write patch — services/contactPatch.js.
//
// Run: node src/services/__tests__/contactPatch.test.mjs
//
// This is the first WRITE path in the app, and the failure modes are worse than
// anything on the read side:
//
//   * a mistyped field name is silently dropped — the UI says "saved" and GHL
//     never receives the edit
//   * an unknown key makes GHL reject the WHOLE request, losing the valid
//     fields alongside it
//   * `tags` OVERWRITES the entire tag list, so a partial array deletes tags
//     nobody asked to remove and there is no undo
//
// Each of those has a test below.

import { buildContactPatch, buildContactCreatePatch, ContactWriteError } from '../contactPatch.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };
const throws = (fn, match) => {
  try { fn(); return false; }
  catch (e) { return e instanceof ContactWriteError && (!match || match.test(e.message)); }
};

// ── The happy path ───────────────────────────────────────────────────
const { patch } = buildContactPatch({ firstName: 'Sarah', lastName: 'Whitmore' });
t('maps the fields it knows', patch.firstName === 'Sarah' && patch.lastName === 'Whitmore');
t('sends ONLY what was passed', Object.keys(patch).length === 2);

// ── Clearing vs not changing ─────────────────────────────────────────
// The distinction the whole patch model rests on.
t('an empty string clears the field',
  buildContactPatch({ phone: '' }).patch.phone === '');
t('undefined means "not changing this"',
  !('phone' in buildContactPatch({ phone: undefined }).patch));
t('a whitespace-only value clears rather than saving spaces',
  buildContactPatch({ city: '   ' }).patch.city === '');

// ── Unknown keys are dropped, not forwarded ──────────────────────────
// GHL rejects the entire request on an unknown key, so forwarding one would
// lose every valid field in the same patch.
const unknown = buildContactPatch({ firstName: 'Sarah', notAField: 'x', id: 'abc' });
t('drops keys GHL does not accept', !('notAField' in unknown.patch) && !('id' in unknown.patch));
t('keeps the valid field alongside them', unknown.patch.firstName === 'Sarah');
t('reports what it dropped', unknown.dropped.includes('notAField') && unknown.dropped.includes('id'));

// ── Contact type ─────────────────────────────────────────────────────
//
// This used to be dropped as "a custom field, not a contact property". It is
// not: GHL calls it `type` on the contact object, @HideApiProperty on PUT so
// absent from the docs, but applied — the same pattern as the opportunity's
// contactId. The old test asserted the drop using 'Builder', a value GHL
// would never have accepted, which is how the wrong assumption survived.
//
// Two values only.
t('maps contactType to GHL `type`',
  buildContactPatch({ contactType: 'lead' }).patch.type === 'lead');

t('accepts customer',
  buildContactPatch({ contactType: 'customer' }).patch.type === 'customer');

t('lower-cases what the UI sends',
  // The picker shows "Lead"; GHL stores lowercase.
  buildContactPatch({ contactType: 'Lead' }).patch.type === 'lead');

t('trims',
  buildContactPatch({ contactType: '  Customer  ' }).patch.type === 'customer');

t('refuses anything else',
  throws(() => buildContactPatch({ contactType: 'Builder' }), /Lead or Customer/));

t('refuses a blank rather than sending an empty type',
  // GHL has no "no type" state; an empty string sets nothing while looking
  // like it saved.
  throws(() => buildContactPatch({ contactType: '  ' }), /Pick a contact type/));

t('does not send contactType under its own name',
  !('contactType' in buildContactPatch({ contactType: 'lead' }).patch));

// ── Tags: the destructive one ────────────────────────────────────────
t('REFUSES tags outright', throws(() => buildContactPatch({ tags: ['vip'] }), /whole tag list/));
t('refuses an empty tag array too', throws(() => buildContactPatch({ tags: [] })));

// ── Validation ───────────────────────────────────────────────────────
t('rejects a malformed email', throws(() => buildContactPatch({ email: 'not-an-email' }), /email/i));
t('accepts a normal email', buildContactPatch({ email: 'a@b.co' }).patch.email === 'a@b.co');
t('rejects a non-ISO date of birth',
  throws(() => buildContactPatch({ dateOfBirth: '25/09/1990' }), /YYYY-MM-DD/));
t('accepts an ISO date of birth',
  buildContactPatch({ dateOfBirth: '1990-09-25' }).patch.dateOfBirth === '1990-09-25');
t('rejects a country name', throws(() => buildContactPatch({ country: 'United Kingdom' })));
t('upper-cases a two-letter country', buildContactPatch({ country: 'gb' }).patch.country === 'GB');

// Over-length rejects rather than truncating: a silently shortened address is
// worse than a visible failure.
t('rejects an over-length name', throws(() => buildContactPatch({ firstName: 'x'.repeat(1501) }), /1500/));
t('accepts a name at the limit', buildContactPatch({ firstName: 'x'.repeat(1500) }).patch.firstName.length === 1500);

// ── Nothing to send ──────────────────────────────────────────────────
t('an empty patch is empty, not an error', Object.keys(buildContactPatch({}).patch).length === 0);

// ── DND passes through as an object, unflattened ──────────────────────
const dnd = buildContactPatch({
  dnd: true,
  dndSettings: { SMS: { status: 'active', message: 'Do not SMS' } }
});
t('dnd boolean survives', dnd.patch.dnd === true);
t('dndSettings passes through as an object',
  dnd.patch.dndSettings?.SMS?.status === 'active');
t('a false dnd is sent, not treated as absent', buildContactPatch({ dnd: false }).patch.dnd === false);

// ── Custom fields ────────────────────────────────────────────────────
//
// GHL wants [{ id, field_value }] — note field_value in SNAKE case, unlike
// every other key in the body. A wrong shape is accepted by the request and
// then silently ignored, so the rep sees a successful save and an unchanged
// value. Failing locally is the lesser evil.

t('a well-formed list passes through',
  JSON.stringify(buildContactPatch({
    customFields: [{ id: 'f1', field_value: 'Yes' }]
  }).patch.customFields) === '[{"id":"f1","field_value":"Yes"}]');

t('camelCase fieldValue is accepted and CONVERTED',
  // The caller may use either; the wire format is always field_value.
  JSON.stringify(buildContactPatch({
    customFields: [{ id: 'f1', fieldValue: 'Yes' }]
  }).patch.customFields) === '[{"id":"f1","field_value":"Yes"}]');

t('a cleared field sends an empty string, not a dropped key',
  // Omitting field_value leaves the OLD value in place, so a clear has to be
  // explicit.
  JSON.stringify(buildContactPatch({
    customFields: [{ id: 'f1', field_value: null }]
  }).patch.customFields) === '[{"id":"f1","field_value":""}]');

t('an id is trimmed',
  buildContactPatch({ customFields: [{ id: '  f1  ', field_value: 'x' }] })
    .patch.customFields[0].id === 'f1');

t('several fields keep their order',
  buildContactPatch({ customFields: [
    { id: 'a', field_value: '1' }, { id: 'b', field_value: '2' }
  ] }).patch.customFields.map((f) => f.id).join(',') === 'a,b');

t('an empty list is allowed',
  Array.isArray(buildContactPatch({ customFields: [] }).patch.customFields));

t('a non-array is refused',
  throws(() => buildContactPatch({ customFields: { id: 'f1' } }), /must be a list/));

t('a field with no id is refused',
  throws(() => buildContactPatch({ customFields: [{ field_value: 'x' }] }), /no id/));

t('a blank id is refused',
  throws(() => buildContactPatch({ customFields: [{ id: '   ', field_value: 'x' }] }), /no id/));

t('a non-object entry is refused',
  throws(() => buildContactPatch({ customFields: ['f1'] }), /is not valid/));

t('null entries are refused rather than silently skipped',
  throws(() => buildContactPatch({ customFields: [null] }), /is not valid/));

t('a numeric value survives — not every field is text',
  buildContactPatch({ customFields: [{ id: 'f1', field_value: 42 }] })
    .patch.customFields[0].field_value === 42);


// ── buildContactCreatePatch — the write path an AI-proposed "create this
// contact" action confirms into. Same field map/validation as update
// (reused, not duplicated), minus the two rules that only make sense when
// there's an EXISTING contact to protect: tags (nothing to accidentally
// wipe on a brand-new row) and "empty type throws" (a new contact simply
// has no type yet, which is fine — update's rule exists because a rep might
// think they're clearing a value that GHL has no "cleared" state for).
t('maps fields the same way update does',
  buildContactCreatePatch({ firstName: 'Priya', email: 'priya@example.com' })
    .patch.firstName === 'Priya');

t('a name alone is addressable — no phone/email required',
  !throws(() => buildContactCreatePatch({ firstName: 'Priya', lastName: 'Nair' })));
t('a phone alone is addressable — no name required',
  !throws(() => buildContactCreatePatch({ phone: '+447700900000' })));
t('an email alone is addressable — no name required',
  !throws(() => buildContactCreatePatch({ email: 'a@b.com' })));

t('nothing addressable at all is refused, not silently sent',
  throws(() => buildContactCreatePatch({ city: 'London' }), /name, phone number or email/));
t('an empty create patch is refused for the same reason',
  throws(() => buildContactCreatePatch({}), /name, phone number or email/));

t('tags on create are dropped silently, not treated as an error',
  !('tags' in buildContactCreatePatch({ firstName: 'X', tags: ['vip'] }).patch));
t('tags do not block the rest of the create from going through',
  buildContactCreatePatch({ firstName: 'X', tags: ['vip'] }).patch.firstName === 'X');

t('an empty contactType on create does not throw — update\'s "pick a type" rule does not apply',
  !throws(() => buildContactCreatePatch({ firstName: 'X', contactType: '' })));
t('a real contactType on create still validates against the same lead/customer rule',
  buildContactCreatePatch({ firstName: 'X', contactType: 'lead' }).patch.type === 'lead');
t('an invalid contactType on create is still refused',
  throws(() => buildContactCreatePatch({ firstName: 'X', contactType: 'prospect' }), /Lead or Customer/));

t('still validates email format, same rule as update',
  throws(() => buildContactCreatePatch({ email: 'not-an-email' }), /not valid/));

// ── businessId: the deal↔business link ───────────────────────────────
// GHL has no opportunities.business_id — a deal reaches a business only
// through contacts.business_id (migration 056). "Add a business to this
// deal" therefore sets businessId on one of its contacts, and this mapping
// is what lets that write reach GHL. It was ABSENT: the Deal Hub could show
// a business a contact already had but had no way to set one, and a
// mistyped key here would be dropped silently (see the header above).
{
  const { patch: link } = buildContactPatch({ businessId: 'biz_123' });
  t('businessId is mapped, not silently dropped', link.businessId === 'biz_123');
  t('businessId is the ONLY key sent for a link', Object.keys(link).length === 1);
  // A clear is a real write. It must survive the "undefined means unchanged"
  // rule and reach GHL as null, the same way companyName clears.
  const { patch: clear } = buildContactPatch({ businessId: null });
  t('businessId: null is a deliberate clear, not an omission',
    'businessId' in clear && clear.businessId === null);
  t('businessId: undefined is left out, i.e. unchanged',
    !('businessId' in buildContactPatch({ firstName: 'x', businessId: undefined }).patch));
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
