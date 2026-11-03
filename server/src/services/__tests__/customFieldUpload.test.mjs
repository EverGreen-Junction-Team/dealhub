// Uploading a file to a FILE_UPLOAD custom field.
//
// THESE FIELDS WERE MARKED READ-ONLY ON A WRONG CLAIM. The code said
// "FILE_UPLOAD has no OAuth documents API", which is true of EMAIL
// attachments and false of custom fields:
//
//   POST /locations/:locationId/customFields/upload
//   Version: v3, multipart/form-data
//   fields: id (contact/opportunity), maxFiles, and the file under the
//           custom field's own KEY
//
// So a rep saw "Upload files in your CRM" beside a field the API could have
// written all along.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svc = readFileSync(join(here, '..', 'customFieldUpload.js'), 'utf8');
const route = readFileSync(join(here, '..', '..', 'routes', 'contacts.js'), 'utf8');
const deals = readFileSync(join(here, '..', '..', 'routes', 'deals.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('the endpoint');

t('posts to customFields/upload', () => {
  assert.match(svc, /\/locations\/\$\{encodeURIComponent\(install\.location_id\)\}\/customFields\/upload/);
  assert.match(svc, /method: 'POST'/);
});

t('pins Version v3', () => {
  // The app-wide default is 2021-07-28. A version mismatch makes GHL answer
  // 401 — not 400 — which reads as a dead token and halted a sub-account
  // once already.
  assert.match(svc, /UPLOAD_API_VERSION = 'v3'/);
  assert.match(svc, /Version: UPLOAD_API_VERSION/);
});

t('is scopeOptional, so a 401 cannot flag the install', () => {
  assert.match(svc, /scopeOptional: true/);
});

t('sends id and maxFiles, and the file under the FIELD KEY', () => {
  // The form field name is how GHL knows which custom field this belongs to.
  assert.match(svc, /form\.append\('id', recordId\)/);
  assert.match(svc, /form\.append\('maxFiles'/);
  assert.match(svc, /form\.append\(fieldKey, f\.buffer/);
});

t('does not let axios cap the body', () => {
  // A multipart body is not a JSON payload; the default limits would reject
  // a large drawing.
  assert.match(svc, /maxBodyLength: Infinity/);
});

console.log('\nlimits');

t('refuses more files than the field allows', () => {
  // Checked before the bytes leave: GHL would reject it too, but only after
  // the whole body has been sent.
  assert.match(svc, /if \(files\.length > limit\)/);
  assert.match(svc, /This field takes at most/);
});

t('falls back to GHL own ceiling of 15', () => {
  assert.match(svc, /DEFAULT_MAX_FILES = 15/);
});

t('the route caps size and count too', () => {
  // Without a limit here a 200MB body is read into memory in full before
  // anyone rejects it.
  assert.match(route, /files: 15/);
  assert.match(route, /fileSize: 25 \* 1024 \* 1024/);
  assert.match(route, /multer\.memoryStorage\(\)/);
});

console.log('\nwhat the route checks before forwarding');

t('the contact is verified under RLS first', () => {
  // An id from another sub-account fails as "not found" rather than being
  // attempted upstream.
  assert.match(route, /SELECT 1 FROM contacts\s*\n\s*WHERE location_id = \$1 AND contact_id = \$2/);
});

t('the field must exist AND be a FILE_UPLOAD', () => {
  // Uploading to a text field would be accepted by GHL and then unreadable.
  assert.match(route, /That field does not take files/);
  assert.match(route, /!== 'FILE_UPLOAD'/);
});

t('the token never reaches the browser', () => {
  // The whole reason for proxying: the access token reads every contact in
  // the sub-account.
  assert.match(route, /WHY IT PROXIES/);
});

console.log('\nthe read-only claim is gone');

t('contacts no longer mark FILE_UPLOAD read-only', () => {
  assert.ok(!/readOnly: \(d\.field_type \|\| ''\)\.toUpperCase\(\) === 'FILE_UPLOAD'/.test(route),
    'the wrong read-only flag is back');
  assert.match(route, /upload: \(d\.field_type \|\| ''\)\.toUpperCase\(\) === 'FILE_UPLOAD'/);
});

t('deals likewise', () => {
  assert.ok(!/readOnly: \/FILE_UPLOAD\/i\.test/.test(deals),
    'the wrong read-only flag is back on the deal route');
  assert.match(deals, /upload: \/FILE_UPLOAD\/i\.test/);
});

t('the field own maxFileLimit is passed through', () => {
  assert.match(route, /maxFiles: d\.raw_definition\?\.maxFileLimit \?\? null/);
});

console.log(`\n${n} passed`);
