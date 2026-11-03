// Custom-field folders: the endpoint, the shape, and the ordering key.
//
// Three bugs, all found by running it against the live API rather than
// reading docs:
//
//   1. WRONG ENDPOINT. /custom-fields/object-key/:objectKey answered
//      400 "Api does not support objectKey of type contact or opportunity" —
//      that route is for CUSTOM OBJECTS. The right one is
//      /locations/:id/customFields/search?documentType=folder&model=…
//
//   2. POSITION IS FRACTIONAL. Typed INTEGER in migration 064; production
//      sends 775.78125, 37.5, 751.5625. GHL uses a float so a field dragged
//      between two others takes the midpoint. Every field write failed with
//      22P02, which aborted the WHOLE sync per location — names, options and
//      placeholders included, not just the new columns.
//
//   3. STANDARD FOLDERS ARE OPT-IN. Without includeStandards=true the
//      folders most fields live in — "Contact", "General Info", "Additional
//      Info" — are missing, and those fields stay ungrouped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'customFieldsSync.js'), 'utf8');
const mig = readFileSync(
  join(here, '..', '..', '..', 'migrations', '065_custom_field_position_numeric.sql'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Verbatim from the live response.
const FOLDER_RESPONSE = {
  customFieldFolders: [
    { _id: 'zfYYpscpGBHoMConvreD', id: 'zfYYpscpGBHoMConvreD', name: 'Website Form',
      model: 'contact', position: 350, fieldsCount: 12, documentType: 'folder' },
    { _id: 'E214n7a7HEx38jYzn3t7', id: 'E214n7a7HEx38jYzn3t7', name: 'Contact',
      model: 'contact', position: 100, fieldsCount: 19, standard: true,
      standardFieldsFolder: true, documentType: 'folder' },
    { _id: 'tR9qQgvDCdN0hCXaIr4t', id: 'tR9qQgvDCdN0hCXaIr4t', name: 'Opportunity Details',
      model: 'opportunity', position: 100, fieldsCount: 14, standard: true },
    { _id: '0sJInhlXJGR4R5ZIHNFW', id: '0sJInhlXJGR4R5ZIHNFW', name: 'Project Info',
      model: 'custom_objects.projects_tmpl', position: 100, fieldsCount: 3 }
  ],
  totalItems: 4
};

// And a field row, verbatim.
const FIELD = {
  id: '7ZZPRcTZyMaroGDc6D3L', name: 'utm_campaign', model: 'contact',
  fieldKey: 'contact.utm_campaign', dataType: 'TEXT', position: 100,
  documentType: 'field', parentId: 'zfYYpscpGBHoMConvreD'
};

// The unwrap + model filter, mirrored from syncFolders.
const foldersFor = (data, objectType) => {
  const rows = Array.isArray(data?.customFieldFolders) ? data.customFieldFolders
    : Array.isArray(data?.folders) ? data.folders : [];
  const out = [];
  for (const f of rows) {
    const id = f?.id || f?._id;
    if (!id) continue;
    // EXACT match. "not opportunity -> contact" filed custom-object folders
    // (custom_objects.projects_tmpl) as contact ones.
    if (f.model && f.model !== objectType) continue;
    out.push({ id, name: f.name, position: f.position });
  }
  return out;
};

console.log('the folder response');

t('customFieldFolders is unwrapped', () => {
  // Not `folders` — that was the shape of the endpoint that 400s.
  assert.equal(foldersFor(FOLDER_RESPONSE, 'contact').length, 2);
});

t('contact folders exclude opportunity and custom-object ones', () => {
  const names = foldersFor(FOLDER_RESPONSE, 'contact').map((f) => f.name);
  assert.deepEqual(names, ['Website Form', 'Contact']);
  assert.ok(!names.includes('Opportunity Details'));
  assert.ok(!names.includes('Project Info'),
    'a custom-object folder must not be filed under contact');
});

t('opportunity folders are separated', () => {
  const names = foldersFor(FOLDER_RESPONSE, 'opportunity').map((f) => f.name);
  assert.deepEqual(names, ['Opportunity Details']);
});

t('STANDARD folders are included — most fields live in them', () => {
  // "Contact" holds 19 of this location's 42 contact fields.
  const contact = foldersFor(FOLDER_RESPONSE, 'contact').find((f) => f.name === 'Contact');
  assert.ok(contact, 'the standard folder is missing');
  assert.equal(contact.id, 'E214n7a7HEx38jYzn3t7');
});

t('a field parentId matches a folder id', () => {
  // This is the whole join.
  const ids = foldersFor(FOLDER_RESPONSE, 'contact').map((f) => f.id);
  assert.ok(ids.includes(FIELD.parentId),
    `field parentId ${FIELD.parentId} matches no folder`);
});

console.log('\nthe endpoint');

t('it calls customFields/search, not object-key', () => {
  assert.match(src, /\/customFields\/search/);
  // Matches a real URL, not the comment that explains why we do not use it —
  // the first version of this test failed on its own documentation.
  assert.ok(!/url: `\/custom-fields\/object-key/.test(src),
    'the object-key route is back — it 400s for contact and opportunity');
});

t('documentType=folder and the model are both sent', () => {
  assert.match(src, /documentType=folder&model=/);
});

t('includeStandards=true is set', () => {
  // Without it, 19 of 42 contact fields stay ungrouped.
  assert.match(src, /includeStandards=true/);
});

t('parentId is read off the FIELD row', () => {
  // Confirmed live: the field list carries it on every row.
  assert.match(src, /parentId: f\.parentId \|\| null/);
});

console.log('\nthe ordering key');

t('position is NUMERIC, not integer', () => {
  // 775.78125 killed every write with 22P02, aborting the whole sync.
  assert.match(mig, /ALTER TABLE ghl_custom_field_definitions\s*\n\s*ALTER COLUMN position TYPE NUMERIC/);
  assert.match(mig, /ALTER TABLE ghl_custom_field_folders\s*\n\s*ALTER COLUMN position TYPE NUMERIC/);
});

t('a fractional position survives the JS guard', () => {
  // Number.isFinite accepts decimals; a parseInt would have truncated them
  // and collapsed distinct positions onto the same value.
  // Mirrors positionOf. The raw-value guard comes FIRST: Number(null) and
  // Number('') are both 0, so the naive version stored an absent position as
  // 0 and sorted that field to the top of its folder.
  const keep = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  assert.equal(keep(775.78125), 775.78125);
  assert.equal(keep('37.5'), 37.5);
  assert.equal(keep(100), 100);
  assert.equal(keep(null), null);
  assert.equal(keep('abc'), null);
  assert.equal(keep(undefined), null, 'absent must not become 0');
  assert.equal(keep(''), null, 'empty string must not become 0');
  assert.equal(keep(0), 0, 'a real zero is still a position');
});

console.log(`\n${n} passed`);
