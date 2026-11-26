import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pickCustomSchemas, contactAssociations, recordLabel, otherSide
} from '../customObjectShapes.js';

// Custom object records reach the calendar THROUGH THE CUSTOMER: GHL has no
// `appointment` object key for a relation to point at. These pin the shaping
// of GHL's responses and the orientation rule for writing a relation.

const OBJECTS = {
  objects: [
    { key: 'contact', labels: { singular: 'Contact' }, standard: true },
    { key: 'custom_objects.projects', labels: { singular: 'Project', plural: 'Projects' }, primaryDisplayProperty: 'custom_objects.projects.project_name' },
    { key: 'custom_objects.sites', labels: { singular: 'Site' } }
  ]
};

test('only custom objects are offered, with their labels', () => {
  const s = pickCustomSchemas(OBJECTS);
  assert.deepEqual(s.map((x) => x.key), ['custom_objects.projects', 'custom_objects.sites']);
  assert.equal(s[0].singular, 'Project');
  assert.equal(s[1].plural, 'Site');
  assert.deepEqual(pickCustomSchemas(null), []);
});

test('associations to a contact, on EITHER side, keep their orientation', () => {
  const schemas = pickCustomSchemas(OBJECTS);
  const got = contactAssociations({
    associations: [
      { id: 'a1', firstObjectKey: 'contact', secondObjectKey: 'custom_objects.projects' },
      { id: 'a2', firstObjectKey: 'custom_objects.sites', secondObjectKey: 'contact' },
      { id: 'a3', firstObjectKey: 'opportunity', secondObjectKey: 'custom_objects.sites' },
      { id: 'a4', firstObjectKey: 'contact', secondObjectKey: 'custom_objects.unknown' },
      { firstObjectKey: 'contact', secondObjectKey: 'custom_objects.projects' }
    ]
  }, schemas);
  assert.deepEqual(got.map((a) => [a.id, a.objectKey, a.contactSide]), [
    ['a1', 'custom_objects.projects', 'first'],
    ['a2', 'custom_objects.sites', 'second']
  ]);
});

test('a record is named by its primary property (short key), then any text', () => {
  const schema = { primaryProperty: 'custom_objects.projects.project_name' };
  assert.equal(recordLabel({ id: 'r1', properties: { project_name: 'Oak St windows' } }, schema), 'Oak St windows');
  assert.equal(recordLabel({ id: 'r1', properties: { project_name: '', city: 'Leeds' } }, schema), 'Leeds');
  assert.equal(recordLabel({ id: 'r1', properties: { tags: ['a', 'b'] } }, {}), 'a, b');
  assert.equal(recordLabel({ id: 'r1', properties: {} }, schema), 'r1');
  assert.equal(recordLabel(null, schema), 'Record');
});

test('the record id is whichever side is not the contact', () => {
  assert.equal(otherSide({ firstRecordId: 'c1', secondRecordId: 'r9' }, 'c1'), 'r9');
  assert.equal(otherSide({ firstRecordId: 'r9', secondRecordId: 'c1' }, 'c1'), 'r9');
  assert.equal(otherSide({ firstRecordId: 'x', secondRecordId: 'y' }, 'c1'), null);
});

const svc = readFileSync(new URL('../ghlCustomObjects.js', import.meta.url), 'utf8');
const route = readFileSync(new URL('../../routes/appointments.js', import.meta.url), 'utf8');

test('a relation is written with the contact on its own side', () => {
  assert.match(svc, /assoc\.contactSide === 'first'\s*\n\s*\? \[contactId, recordId\]\s*\n\s*: \[recordId, contactId\]/);
});

test('every GHL call is scope-optional — a missing scope must not halt sync', () => {
  const calls = svc.match(/ghlRequest\(install, \{[\s\S]*?\n\s*\}\)/g) || [];
  assert.ok(calls.length >= 6, `expected the reads and writes, saw ${calls.length}`);
  for (const c of calls) assert.match(c, /scopeOptional: true/);
});

test('unlink checks the relation is on THIS customer first', () => {
  assert.match(route, /if \(!records\.some\(\(r\) => r\.relationId === relationId\)\)/);
});

test('a missing scope is explained, naming the permissions', () => {
  assert.match(route, /associations\/relation\.write/);
  assert.match(route, /reason: 'scope_missing'/);
});

// Deal linking (migration 145): stored in Deal Hub, and kept from the sync.
const writer = readFileSync(new URL('../appointmentWriter.js', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../appointmentsSync.js', import.meta.url), 'utf8');

test('the webhook writer and the sweep leave a pinned deal alone', () => {
  for (const s of [writer, sync]) {
    assert.match(s, /opportunity_id\s*= CASE WHEN appointments\.opportunity_pinned\s*\n\s*THEN appointments\.opportunity_id/);
  }
});

test('a deal is only linked if it is on the appointment\'s customer', () => {
  assert.match(route, /appointmentsRouter\.put\('\/:id\/deal'/);
  assert.match(route, /oc\.contact_id = \$3/);
  assert.match(route, /'That deal is not on this customer'/);
  assert.match(route, /opportunity_pinned = true/);
});

test('association lists are read whatever the (undocumented) wrapper is', async () => {
  const { associationRows } = await import('../customObjectShapes.js');
  const row = { id: 'a' };
  for (const d of [[row], { associations: [row] }, { data: [row] }, { items: [row] }]) {
    assert.deepEqual(associationRows(d), [row]);
  }
  assert.deepEqual(associationRows({ total: 0 }), []);
  assert.deepEqual(associationRows(null), []);
});

test('record search sends every field GHL requires, searchAfter included', () => {
  assert.match(svc, /data: \{ locationId: install\.location_id, page: 1, pageLimit: 20, query: q \|\| '', searchAfter: \[\] \}/);
});

test('a relation is matched by object keys when its associationId is opaque', async () => {
  const { matchRelation } = await import('../customObjectShapes.js');
  const assocs = [
    { id: 'AS_P', objectKey: 'custom_objects.projects', contactSide: 'first' },
    { id: 'AS_S', objectKey: 'custom_objects.sites', contactSide: 'second' }
  ];
  assert.equal(matchRelation({ associationId: 'AS_S' }, assocs).id, 'AS_S');
  assert.equal(matchRelation({ associationId: '6aab95944b05', firstObjectKey: 'contact', secondObjectKey: 'custom_objects.projects' }, assocs).id, 'AS_P');
  assert.equal(matchRelation({ associationId: 'x', firstObjectKey: 'custom_objects.sites', secondObjectKey: 'contact' }, assocs).id, 'AS_S');
  assert.equal(matchRelation({ associationId: 'x', firstObjectKey: 'opportunity', secondObjectKey: 'contact' }, assocs), null);
});
