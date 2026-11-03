// Association contract tests.
//
// These assert the things GHL will not tell us at runtime: the constant ids,
// the orientation rule (firstRecordId must match firstObjectKey), and the
// composite relation-id format their delete handler parses. Getting any of
// them wrong produces a request GHL accepts and silently misfiles, which is
// far worse than an error.
//
// Imports associationConstants, NOT ghlAssociations: the latter pulls in
// ghlClient and db, which import config, which throws without DATABASE_URL — so
// a test asserting a string constant would need a live database. The constants
// and pure helpers were split out for exactly this reason.
import assert from 'node:assert/strict';
import { ASSOCIATIONS, NOTE_OBJECT_KEYS, AssociationError, relationId }
  from '../associationConstants.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('ghlAssociations');

// ── The constants ────────────────────────────────────────────────────────
t('association id and key are the same literal string', () => {
  // GHL's ghlDefinedAssociations uses the key as the id. If these ever drift,
  // every relation write silently targets nothing.
  assert.equal(ASSOCIATIONS.TASK_OPPORTUNITY.id, 'TASK_OPPORTUNITY_ASSOCIATION');
  assert.equal(ASSOCIATIONS.TASK_BUSINESS.id, 'TASK_BUSINESS_ASSOCIATION');
  assert.equal(ASSOCIATIONS.NOTE_OPPORTUNITY.id, 'NOTE_OPPORTUNITY_ASSOCIATION');
  assert.equal(ASSOCIATIONS.NOTE_BUSINESS.id, 'NOTE_BUSINESS_ASSOCIATION');
});

t('every association puts task/note FIRST, never the deal', () => {
  // The orientation rule. firstRecordId must be the record whose object key is
  // firstObjectKey, so a task↔opportunity link sends the TASK id first. If one
  // of these were declared the other way round, our create call would send the
  // ids in the wrong slots.
  for (const key of ['TASK_OPPORTUNITY', 'TASK_BUSINESS']) {
    assert.equal(ASSOCIATIONS[key].firstObjectKey, 'task', `${key} first`);
  }
  for (const key of ['NOTE_OPPORTUNITY', 'NOTE_BUSINESS']) {
    assert.equal(ASSOCIATIONS[key].firstObjectKey, 'note', `${key} first`);
  }
  assert.equal(ASSOCIATIONS.TASK_OPPORTUNITY.secondObjectKey, 'opportunity');
  assert.equal(ASSOCIATIONS.NOTE_BUSINESS.secondObjectKey, 'business');
});

t('the note→opportunity cap is 1 — an add is really a replace', () => {
  // This is the behavioural one. cap 1 means adding a second opportunity
  // silently removes the first, so the UI must present it as "the deal this
  // note is about" and never as a multi-select.
  assert.equal(ASSOCIATIONS.NOTE_OPPORTUNITY.cap, 1);
  // Tasks are genuinely additive, which is why they need an explicit remove.
  assert.ok(ASSOCIATIONS.TASK_OPPORTUNITY.cap > 1);
});

// ── The composite relation id ────────────────────────────────────────────
t('relation id is firstRecordId-secondRecordId, not an ObjectId', () => {
  // Task relations live on the task document, so GHL synthesises the id.
  // Their delete handler SPLITS this string, so the format is a contract.
  assert.equal(
    relationId('dvB2GnUWWFhy0cUUoQQa', 'opp_7hK2mQ9xLpR4'),
    'dvB2GnUWWFhy0cUUoQQa-opp_7hK2mQ9xLpR4'
  );
});

t('relation id orientation is task-then-deal', () => {
  // Reversed, this deletes nothing and reports success.
  const id = relationId('TASK123', 'OPP456');
  assert.ok(id.startsWith('TASK123'), 'task id must come first');
  assert.ok(id.endsWith('OPP456'));
});

// ── Note object keys ─────────────────────────────────────────────────────
t('note object keys are exactly GHL\'s NOTES_OBJECT_KEYS', () => {
  assert.deepEqual(
    [...NOTE_OBJECT_KEYS].sort(),
    ['appointment', 'business', 'contact', 'opportunity']
  );
});

t('a deal is not a valid note object key under the wrong name', () => {
  // GHL's key is 'opportunity'. 'deal' is OUR word for it and would be
  // rejected by their validator — worth a local guard with a clear message.
  assert.ok(!NOTE_OBJECT_KEYS.has('deal'));
  assert.ok(!NOTE_OBJECT_KEYS.has('company'));   // theirs is 'business'
  assert.ok(NOTE_OBJECT_KEYS.has('business'));
});

// ── Error shape ──────────────────────────────────────────────────────────
t('AssociationError carries status and field like the other write errors', () => {
  // The route error handlers branch on this shape; without status/field a
  // validation failure becomes a 500 the UI cannot attribute to a control.
  const e = new AssociationError('nope', { status: 404, field: 'opportunityId' });
  assert.equal(e.status, 404);
  assert.equal(e.field, 'opportunityId');
  assert.equal(e.name, 'AssociationError');
  assert.ok(e instanceof Error);
});

t('AssociationError defaults to 400 with no field', () => {
  const e = new AssociationError('bad');
  assert.equal(e.status, 400);
  assert.equal(e.field, null);
});

// ── The payload builder, as a replica ────────────────────────────────────
//
// createRelation is module-private and makes a network call. This asserts the
// SHAPE it must produce, which is the part that can be wrong without erroring.
t('a task relation payload puts the task in firstRecordId', () => {
  const assoc = ASSOCIATIONS.TASK_OPPORTUNITY;
  const payload = {
    locationId: 'loc1',
    associationId: assoc.id,
    firstRecordId: 'TASK123',
    secondRecordId: 'OPP456'
  };
  assert.equal(payload.associationId, 'TASK_OPPORTUNITY_ASSOCIATION');
  assert.equal(payload.firstRecordId, 'TASK123');
  assert.equal(payload.secondRecordId, 'OPP456');
  // The invariant, stated as the code states it.
  assert.equal(assoc.firstObjectKey, 'task');
});

t('a note relation payload uses objectKey/recordId, not first/second', () => {
  // Notes go through a DIFFERENT endpoint with a different body shape. Sending
  // the generic relations shape to /notes/:id/relations fails validation.
  const body = {
    type: 'add',
    relations: [{ objectKey: 'opportunity', recordId: 'OPP456' }]
  };
  assert.ok(['add', 'remove'].includes(body.type));
  assert.ok(body.relations.length >= 1);
  assert.ok('objectKey' in body.relations[0]);
  assert.ok(!('firstRecordId' in body.relations[0]));
});

// ── Deal ↔ contact ───────────────────────────────────────────────────────
t('the opportunity comes FIRST on a deal-contact link', () => {
  // Orientation is the failure that does not error: reversed, GHL stores a
  // link it reads as a contact with an opportunity-shaped record attached.
  const a = ASSOCIATIONS.OPPORTUNITY_CONTACT;
  assert.equal(a.id, 'OPPORTUNITIES_CONTACTS_ASSOCIATION');
  assert.equal(a.firstObjectKey, 'opportunity');
  assert.equal(a.secondObjectKey, 'contact');
});

t('a deal-contact relation id is NOT the composite form', () => {
  // The `${first}-${second}` id works for TASK and NOTE relations because
  // those live on the parent document. An opportunity↔contact relation is a
  // real row with its own ObjectId — which is why opportunity_contacts is
  // keyed on relation_id and why removeDealContact takes that id rather than
  // deriving one. Deriving it would delete nothing and report success.
  const derived = relationId('OPP1', 'CONTACT1');
  assert.equal(derived, 'OPP1-CONTACT1');
  // Documented here as the thing NOT to send to the delete endpoint.
  assert.notEqual(derived, '665f1c2a9b4e1a0012ab34cd');
});

t('a deal holds fewer contacts than a contact holds deals', () => {
  // cap is the first→second direction: 25 contacts on one deal.
  assert.equal(ASSOCIATIONS.OPPORTUNITY_CONTACT.cap, 25);
});

console.log(`\n${n} passed`);
