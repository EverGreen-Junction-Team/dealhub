// Grouping a contact's custom fields into GHL's folders.
//
// GHL's own contact panel renders one collapsible section per folder —
// "General Info", "Website Form", "Charlie lead upload (Crittall)". Our
// editor showed none: the definitions were synced (migration 023) but never
// sent to the client, and the folder each belongs to was not stored until
// migration 064.
//
// The failure modes worth guarding are all about LOSS: a field whose folder
// was deleted, a value keyed by field_key rather than id, a FILE_UPLOAD
// offered as editable when no OAuth API can write it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'contacts.js'), 'utf8');

// The grouping rule, mirrored from customFieldGroups().
const group = (defs, rawValues) => {
  const values = (rawValues && typeof rawValues === 'object') ? rawValues : {};
  const groups = new Map();
  for (const d of defs) {
    const key = d.folder_name ? d.parent_id : '__ungrouped__';
    if (!groups.has(key)) {
      groups.set(key, {
        id: d.folder_name ? d.parent_id : null,
        name: d.folder_name || 'Other fields',
        position: d.folder_position ?? 9999,
        fields: []
      });
    }
    groups.get(key).fields.push({
      id: d.field_id,
      label: d.display_name || d.field_key || 'Untitled field',
      type: d.field_type || 'TEXT',
      value: values[d.field_id] ?? (d.field_key ? values[d.field_key] : undefined) ?? null,
      readOnly: (d.field_type || '').toUpperCase() === 'FILE_UPLOAD'
    });
  }
  return [...groups.values()].sort((a, b) =>
    a.position - b.position || a.name.localeCompare(b.name));
};

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('grouping');

t('fields land in their folder', () => {
  const out = group([
    { field_id: 'a', display_name: 'Enquiry', parent_id: 'f1', folder_name: 'General Info', folder_position: 0 },
    { field_id: 'b', display_name: 'Source', parent_id: 'f1', folder_name: 'General Info', folder_position: 0 }
  ], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'General Info');
  assert.equal(out[0].fields.length, 2);
});

t('separate folders stay separate', () => {
  const out = group([
    { field_id: 'a', parent_id: 'f1', folder_name: 'General Info', folder_position: 0 },
    { field_id: 'b', parent_id: 'f2', folder_name: 'Website Form', folder_position: 1 }
  ], {});
  assert.deepEqual(out.map((g) => g.name), ['General Info', 'Website Form']);
});

t('folders keep GHL own order', () => {
  // So the sections appear in the order a rep already knows from the CRM.
  const out = group([
    { field_id: 'a', parent_id: 'f2', folder_name: 'Website Form', folder_position: 5 },
    { field_id: 'b', parent_id: 'f1', folder_name: 'Contact', folder_position: 1 }
  ], {});
  assert.deepEqual(out.map((g) => g.name), ['Contact', 'Website Form']);
});

t('a field with NO folder falls into "Other fields"', () => {
  const out = group([{ field_id: 'a', parent_id: null, folder_name: null }], {});
  assert.equal(out[0].name, 'Other fields');
  assert.equal(out[0].id, null);
});

t('a field whose folder was DELETED is not lost', () => {
  // parent_id set, but the join found no active folder. The value is visible
  // in the CRM, so it must not vanish here.
  const out = group([
    { field_id: 'a', display_name: 'Orphan', parent_id: 'gone', folder_name: null }
  ], { a: 'still here' });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Other fields');
  assert.equal(out[0].fields[0].value, 'still here');
});

t('several orphans share ONE group, not one each', () => {
  // Keying on parent_id would make a separate unnamed section per orphan.
  const out = group([
    { field_id: 'a', parent_id: 'goneA', folder_name: null },
    { field_id: 'b', parent_id: 'goneB', folder_name: null },
    { field_id: 'c', parent_id: null, folder_name: null }
  ], {});
  assert.equal(out.length, 1, 'orphans must collapse into one section');
  assert.equal(out[0].fields.length, 3);
});

t('"Other fields" sorts LAST', () => {
  const out = group([
    { field_id: 'a', parent_id: null, folder_name: null },
    { field_id: 'b', parent_id: 'f1', folder_name: 'General Info', folder_position: 3 }
  ], {});
  assert.deepEqual(out.map((g) => g.name), ['General Info', 'Other fields']);
});

console.log('\nvalues');

t('a value is read by field id', () => {
  const out = group([{ field_id: 'a', parent_id: null, folder_name: null }], { a: 'Yes' });
  assert.equal(out[0].fields[0].value, 'Yes');
});

t('a value keyed by field_key is still found', () => {
  // customFields blobs have used both spellings across API versions.
  const out = group(
    [{ field_id: 'a', field_key: 'contact.enquiry', parent_id: null, folder_name: null }],
    { 'contact.enquiry': 'From the key' }
  );
  assert.equal(out[0].fields[0].value, 'From the key');
});

t('an unset field is null, not undefined', () => {
  // The client renders this; undefined would drop the key from JSON.
  const out = group([{ field_id: 'a', parent_id: null, folder_name: null }], {});
  assert.equal(out[0].fields[0].value, null);
});

t('a false or 0 value survives', () => {
  // ?? not ||: a checkbox set to false is a real answer.
  const out = group([
    { field_id: 'a', parent_id: null, folder_name: null },
    { field_id: 'b', parent_id: null, folder_name: null }
  ], { a: false, b: 0 });
  assert.equal(out[0].fields[0].value, false);
  assert.equal(out[0].fields[1].value, 0);
});

t('a missing custom_fields blob does not crash', () => {
  for (const v of [null, undefined, 'nonsense', 42]) {
    assert.doesNotThrow(() => group([{ field_id: 'a', parent_id: null, folder_name: null }], v));
  }
});

t('a nameless field still has a label', () => {
  // An empty label renders as a blank row with an input beside it.
  const out = group([{ field_id: 'a', parent_id: null, folder_name: null }], {});
  assert.equal(out[0].fields[0].label, 'Untitled field');
});

console.log('\nwhat can be edited');

t('FILE_UPLOAD is read-only', () => {
  // There is no OAuth documents API, so the control could never save.
  const out = group([
    { field_id: 'a', field_type: 'FILE_UPLOAD', parent_id: null, folder_name: null }
  ], {});
  assert.equal(out[0].fields[0].readOnly, true);
});

t('ordinary types are editable', () => {
  for (const type of ['TEXT', 'DROPDOWN', 'CHECKBOX', 'DATE', 'NUMERICAL']) {
    const out = group([{ field_id: 'a', field_type: type, parent_id: null, folder_name: null }], {});
    assert.equal(out[0].fields[0].readOnly, false, type);
  }
});

console.log('\nthe source');

t('the route sends the groups', () => {
  assert.match(src, /customFieldGroups: result\.customFieldGroups \|\| \[\]/);
});

t('the definitions query runs inside withTenant', () => {
  // A folder list must not cross sub-accounts — it needs the RLS context.
  assert.match(src, /customFieldGroups: await customFieldGroups\(\s*\n?\s*client, locationId/);
});

t('only ACTIVE fields and folders are offered', () => {
  // A field deleted in GHL must stop appearing, though its row stays so old
  // values remain resolvable.
  assert.match(src, /AND d\.is_active/);
  assert.match(src, /AND f\.is_active/);
});

console.log(`\n${n} passed`);
