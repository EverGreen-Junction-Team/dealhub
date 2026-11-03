// Tests for services/taskNoteRelationWriter.js.
//
// This handler exists because RelationCreate/RelationDelete were arriving and
// being DROPPED: opportunityContactWriter returns early for any association
// that is not OPPORTUNITIES_CONTACTS, at debug level, so a task linked to a
// second deal in GHL simply never appeared in our copy.
//
// The pure logic is tested here. The SQL is verified separately against a real
// Postgres — a mocked query() would have accepted the 11-parameter statement
// that a real one rejected.

// The module reaches config.js, which throws on a missing DATABASE_URL. Stub
// values rather than reading the source as text: importing the real export
// means a renamed or deleted constant fails this test, which reading a file
// would not.
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.invalid/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough-for-config';

const { HANDLED_ASSOCIATIONS } = await import('../taskNoteRelationWriter.js');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── Which events we claim ────────────────────────────────────────────
//
// The webhook route gates on this set. Too wide and we act on an association
// whose shape we have not checked; too narrow and events keep vanishing.
t('claims task↔opportunity', HANDLED_ASSOCIATIONS.has('TASK_OPPORTUNITY_ASSOCIATION'));
t('claims note↔opportunity', HANDLED_ASSOCIATIONS.has('NOTE_OPPORTUNITY_ASSOCIATION'));

t('does NOT claim the contact association — that is opportunityContactWriter\'s',
  // Both handlers run on every RelationCreate. If this set claimed the contact
  // association too, a contact link would be written twice, once by a handler
  // that does not understand it.
  !HANDLED_ASSOCIATIONS.has('OPPORTUNITIES_CONTACTS_ASSOCIATION'));

t('does not claim associations we have not modelled',
  // TASK_BUSINESS and NOTE_BUSINESS are real GHL associations with different
  // caps (10 and 1000). Claiming them here would write them into
  // task_relations, whose opportunity_id column is not a business.
  !HANDLED_ASSOCIATIONS.has('TASK_BUSINESS_ASSOCIATION')
  && !HANDLED_ASSOCIATIONS.has('NOTE_BUSINESS_ASSOCIATION'));

t('is exactly two associations', HANDLED_ASSOCIATIONS.size === 2);

t('an undefined associationId is not claimed',
  // A malformed webhook must not reach the handler — event.associationId is
  // read straight off the payload.
  !HANDLED_ASSOCIATIONS.has(undefined) && !HANDLED_ASSOCIATIONS.has(null));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
