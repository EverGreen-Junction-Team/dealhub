// Tests for businessPatch.js — the mapper between our business fields and
// GHL's /businesses endpoints. Dependency-free, like the module under test.

import {
  buildBusinessPatch, normaliseDomain, normaliseLogo, assertBusinessId,
  BusinessWriteError
} from '../businessPatch.js';

let passed = 0, failed = 0;

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n        got  ${g}\n        want ${w}`); }
};

const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

function throwsWith(name, fn, { field = undefined, match = undefined } = {}) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${name}\n        expected a throw, got none`);
  } catch (err) {
    if (!(err instanceof BusinessWriteError)) {
      failed++;
      console.log(`FAIL  ${name}\n        threw ${err.name}, not BusinessWriteError`);
      return;
    }
    if (field !== undefined && err.field !== field) {
      failed++;
      console.log(`FAIL  ${name}\n        field ${err.field}, expected ${field}`);
      return;
    }
    if (match && !err.message.toLowerCase().includes(match.toLowerCase())) {
      failed++;
      console.log(`FAIL  ${name}\n        "${err.message}" lacks "${match}"`);
      return;
    }
    passed++;
    console.log(`  ok  ${name}`);
  }
}

console.log('\n--- create: name is the only required field ---');

eq('minimal create',
  buildBusinessPatch({ name: 'Crittall Windows' }, { create: true }).patch,
  { name: 'Crittall Windows' });

throwsWith('create with no name',
  () => buildBusinessPatch({ phone: '+44123' }, { create: true }),
  { field: 'name', match: 'needs a name' });

throwsWith('create with a whitespace name',
  () => buildBusinessPatch({ name: '   ' }, { create: true }), { field: 'name' });

eq('every documented field',
  buildBusinessPatch({
    name: 'Acme Demo LLC', phone: '+15555550123', email: 'owner@example.com',
    website: 'www.example.com', address: '123 Example Street', city: 'springfield',
    state: 'california', postalCode: '12345', country: 'US',
    description: 'Demo business', domainname: 'acme.com'
  }, { create: true }).patch,
  {
    name: 'Acme Demo LLC', phone: '+15555550123', email: 'owner@example.com',
    website: 'www.example.com', address: '123 Example Street', city: 'springfield',
    state: 'california', postalCode: '12345', country: 'US',
    description: 'Demo business', domainname: 'acme.com'
  });

console.log('\n--- update: partial bodies ---');

eq('one field', buildBusinessPatch({ phone: '+15555550999' }).patch, { phone: '+15555550999' });
eq('fields are trimmed', buildBusinessPatch({ city: '  Taunton  ' }).patch, { city: 'Taunton' });
eq('a field can be cleared with an empty string',
  buildBusinessPatch({ website: '' }).patch, { website: '' });
eq('...or with null', buildBusinessPatch({ website: null }).patch, { website: null });
eq('undefined means "not changing"',
  buildBusinessPatch({ phone: '+1', city: undefined }).patch, { phone: '+1' });

throwsWith('an empty update', () => buildBusinessPatch({}), { match: 'nothing to update' });

// GHL rejects an empty name outright, so an edit that blanks it would fail
// anyway — better to say so with the field named.
throwsWith('clearing the name on an edit',
  () => buildBusinessPatch({ name: '' }),
  { field: 'name', match: 'cannot be cleared' });

console.log('\n--- locationId: required on create, REJECTED on update ---');

// The endpoint asymmetry that would otherwise 422 every edit made from a whole
// record. It is dropped, not passed through, and the caller supplies it from the
// session on create.
eq('locationId is dropped from the patch',
  buildBusinessPatch({ name: 'x', locationId: 'abc' }, { create: true }).patch,
  { name: 'x' });
eq('...and reported as dropped',
  buildBusinessPatch({ name: 'x', locationId: 'abc' }, { create: true }).dropped,
  ['locationId']);
eq('dropped on update too, so a full-record edit does not 422',
  buildBusinessPatch({ phone: '+1', locationId: 'abc' }).patch, { phone: '+1' });

console.log('\n--- fields GHL explicitly refuses ---');

// Documented as rejected with "Custom fields are not supported yet". Named
// rather than silently dropped, so the caller learns why.
throwsWith('customFields', () => buildBusinessPatch({ name: 'x', customFields: {} }),
  { field: 'customFields', match: 'not supported' });
throwsWith('externalObjectId',
  () => buildBusinessPatch({ name: 'x', externalObjectId: 'e1' }),
  { field: 'externalObjectId', match: 'import-only' });
throwsWith('relations — not on this API at all',
  () => buildBusinessPatch({ name: 'x', relations: [] }),
  { field: 'relations', match: 'no relations' });

console.log('\n--- unknown fields are dropped, not passed through ---');

// An unknown key makes GHL reject the WHOLE request, so a typo must not travel
// with the valid fields.
eq('unknown keys dropped',
  buildBusinessPatch({ name: 'x', id: 'b1', isActive: true }).patch, { name: 'x' });
eq('...and reported for logging',
  buildBusinessPatch({ name: 'x', id: 'b1', isActive: true }).dropped.sort(),
  ['id', 'isActive']);

// Our own column names for things GHL calls something else — silent data loss if
// they ever reached the patch unmapped.
eq('our snake_case postal_code is NOT postalCode',
  buildBusinessPatch({ name: 'x', postal_code: 'TA1' }).dropped, ['postal_code']);
eq('our domain_name is NOT domainname',
  buildBusinessPatch({ name: 'x', domain_name: 'acme.com' }).dropped, ['domain_name']);

console.log('\n--- domainname: bare domain, unique per location, max 253 ---');

eq('a plain domain', normaliseDomain('acme.com'), 'acme.com');
eq('lowercased', normaliseDomain('ACME.COM'), 'acme.com');
// A rep pastes from the address bar; the intent is unambiguous, so normalise
// rather than reject.
eq('https:// stripped', normaliseDomain('https://acme.com'), 'acme.com');
eq('http:// stripped', normaliseDomain('http://acme.com'), 'acme.com');
eq('www. stripped', normaliseDomain('www.acme.com'), 'acme.com');
eq('protocol AND www stripped', normaliseDomain('https://www.acme.com'), 'acme.com');
eq('path stripped', normaliseDomain('https://acme.com/about/us'), 'acme.com');
eq('query stripped', normaliseDomain('acme.com?utm=x'), 'acme.com');
eq('fragment stripped', normaliseDomain('acme.com#top'), 'acme.com');
eq('trailing dot stripped', normaliseDomain('acme.com.'), 'acme.com');
eq('a subdomain is kept — it is a different site',
  normaliseDomain('shop.acme.co.uk'), 'shop.acme.co.uk');
eq('hyphens are legal', normaliseDomain('evergreen-junction.co.uk'), 'evergreen-junction.co.uk');
eq('null clears it', normaliseDomain(null), null);
eq('empty string clears it', normaliseDomain(''), null);

throwsWith('an email address is not a domain',
  () => normaliseDomain('owner@acme.com'), { field: 'domainname', match: 'email' });
throwsWith('a bare word has no dot',
  () => normaliseDomain('acme'), { field: 'domainname' });
throwsWith('spaces are rejected',
  () => normaliseDomain('acme corp.com'), { field: 'domainname' });
throwsWith('over 253 characters',
  () => normaliseDomain('a'.repeat(250) + '.com'), { field: 'domainname', match: '253' });
throwsWith('a number is not a domain',
  () => normaliseDomain(12345), { field: 'domainname' });
throwsWith('a leading hyphen is not a valid label',
  () => normaliseDomain('-acme.com'), { field: 'domainname' });

console.log('\n--- companylogo: array of one { url }, https only ---');

eq('a bare url string is wrapped',
  normaliseLogo('https://cdn.example.com/logo.png'),
  [{ url: 'https://cdn.example.com/logo.png' }]);
eq('an array of one passes through',
  normaliseLogo([{ url: 'https://cdn.example.com/l.png' }]),
  [{ url: 'https://cdn.example.com/l.png' }]);
// meta must survive — dropping it would lose data on an edit that wasn't about
// the logo at all.
eq('meta is preserved',
  normaliseLogo([{ url: 'https://x.com/l.png', meta: { w: 100 } }]),
  [{ url: 'https://x.com/l.png', meta: { w: 100 } }]);
eq('an empty array is a deliberate clear', normaliseLogo([]), []);
eq('null clears it', normaliseLogo(null), null);

throwsWith('http is rejected — GHL requires https',
  () => normaliseLogo('http://insecure.com/l.png'),
  { field: 'companylogo', match: 'https' });
throwsWith('more than one logo',
  () => normaliseLogo([{ url: 'https://a.com/1.png' }, { url: 'https://a.com/2.png' }]),
  { field: 'companylogo', match: 'one logo' });
throwsWith('an entry with no url',
  () => normaliseLogo([{ meta: {} }]), { field: 'companylogo', match: 'needs a URL' });
throwsWith('a number is not a logo',
  () => normaliseLogo(42), { field: 'companylogo' });

console.log('\n--- other field validation ---');

eq('country is upper-cased', buildBusinessPatch({ country: 'gb' }).patch.country, 'GB');
throwsWith('a country name is not a code',
  () => buildBusinessPatch({ country: 'United Kingdom' }), { field: 'country' });
throwsWith('a bad email',
  () => buildBusinessPatch({ email: 'not-an-email' }), { field: 'email' });
eq('a valid email passes',
  buildBusinessPatch({ email: 'owner@example.com' }).patch.email, 'owner@example.com');
throwsWith('name must be text',
  () => buildBusinessPatch({ name: 42 }), { field: 'name' });
throwsWith('a non-object body',
  () => buildBusinessPatch('name=x'), { match: 'nothing to save' });
throwsWith('an array is not a field set',
  () => buildBusinessPatch(['x']), { match: 'nothing to save' });

console.log('\n--- business ids are Mongo ObjectIds ---');

// GHL's guard rejects anything else before it reaches the record. Checked
// locally so the message is clear, and so a caller cannot aim a request at a
// path segment that is not an id at all.
eq('a valid ObjectId', assertBusinessId('641c094001436dbc2081e642'), '641c094001436dbc2081e642');
ok('uppercase hex is accepted', assertBusinessId('641C094001436DBC2081E642').length === 24);

throwsWith('too short', () => assertBusinessId('641c09'), { field: 'businessId' });
throwsWith('too long', () => assertBusinessId('641c094001436dbc2081e642ff'), { field: 'businessId' });
throwsWith('non-hex characters', () => assertBusinessId('641c094001436dbc2081e64z'), { field: 'businessId' });
throwsWith('a path traversal attempt', () => assertBusinessId('../../locations'), { field: 'businessId' });
throwsWith('undefined', () => assertBusinessId(undefined), { field: 'businessId' });
throwsWith('a number', () => assertBusinessId(641), { field: 'businessId' });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
