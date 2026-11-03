// Linking a business to a deal: the write landed in GHL, then vanished.
//
// WHAT HAPPENED. "Add business" PATCHed the contact with businessId, GHL
// returned 200, the business painted on the deal — and 2.5s later it was
// gone. The logs showed GHL fires NO ContactUpdate for a business-link
// change. It models it as a relation SWAP:
//
//   RelationDelete  BUSINESSES_CONTACTS_ASSOCIATION  old business ↔ contact
//   RelationCreate  BUSINESSES_CONTACTS_ASSOCIATION  new business ↔ contact
//
// Nothing handled those. The opp↔contact writer correctly rejects them (not
// an opportunity pair), the task/note writer knows only its own two
// associations, so both were silently dropped. contacts.business_id had
// exactly two writers — the contact upsert (needs a ContactUpdate that never
// comes) and the daily sync — so the link was never recorded locally, and
// the reconcile refetch overwrote the optimistic paint with the old empty
// column.
//
// THE RACE THIS MUST GET RIGHT. GHL sends the delete and the create
// back-to-back with no guaranteed order. A blind `SET business_id = NULL` on
// the delete wipes the NEW link if the create lands first. The delete is
// therefore conditional on the column still pointing at the business being
// unlinked.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mirrored, not imported: the writer pulls in db.js, which demands a
// DATABASE_URL at load time. The pair resolver is pure, so it is tested as
// a copy — the same convention every other writer test here uses.
function pickBusinessContact(event) {
  const a = { key: event.firstObjectKey, id: event.firstRecordId };
  const b = { key: event.secondObjectKey, id: event.secondRecordId };
  if (a.key === 'business' && b.key === 'contact') return { businessId: a.id, contactId: b.id };
  if (b.key === 'business' && a.key === 'contact') return { businessId: b.id, contactId: a.id };
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const writer = readFileSync(join(root, 'src/services/businessContactRelationWriter.js'), 'utf8');
const router = readFileSync(join(root, 'src/routes/webhooks.js'), 'utf8');

let pass = 0;
const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// The exact payloads from the production log.
const DELETE_OLD = {
  type: 'RelationDelete', firstObjectKey: 'business', firstRecordId: '6942ad1f2dfec14869f9d675',
  secondObjectKey: 'contact', secondRecordId: 'Rx64CVZPBdU1rcEHTdTp',
  associationId: 'BUSINESSES_CONTACTS_ASSOCIATION'
};
const CREATE_NEW = {
  type: 'RelationCreate', firstObjectKey: 'business', firstRecordId: '6ab6b56ad8b16850dd944460',
  secondObjectKey: 'contact', secondRecordId: 'Rx64CVZPBdU1rcEHTdTp',
  associationId: 'BUSINESSES_CONTACTS_ASSOCIATION'
};

// The mirror above must match the real resolver byte-for-byte on its two
// decisive lines, or this test could pass while the writer is wrong.
t('the test mirror matches the writer\'s own resolver',
  /if \(a\.key === 'business' && b\.key === 'contact'\) return \{ businessId: a\.id, contactId: b\.id \};/.test(writer)
  && /if \(b\.key === 'business' && a\.key === 'contact'\) return \{ businessId: b\.id, contactId: a\.id \};/.test(writer));

// ── Pair resolution, by object key ───────────────────────────────────
t('the real create payload resolves to the right business and contact', (() => {
  const p = pickBusinessContact(CREATE_NEW);
  return p && p.businessId === '6ab6b56ad8b16850dd944460' && p.contactId === 'Rx64CVZPBdU1rcEHTdTp';
})());
t('the reversed key order resolves identically', (() => {
  const p = pickBusinessContact({ firstObjectKey: 'contact', firstRecordId: 'c1', secondObjectKey: 'business', secondRecordId: 'b1' });
  return p && p.businessId === 'b1' && p.contactId === 'c1';
})());
t('an opportunity↔contact pair is NOT claimed — that is the other writer\'s',
  pickBusinessContact({ firstObjectKey: 'opportunity', firstRecordId: 'o1', secondObjectKey: 'contact', secondRecordId: 'c1' }) === null);
t('a task↔opportunity pair is not claimed either',
  pickBusinessContact({ firstObjectKey: 'task', firstRecordId: 't1', secondObjectKey: 'opportunity', secondRecordId: 'o1' }) === null);

// ── The writes ───────────────────────────────────────────────────────
t('create SETS contacts.business_id', /SET business_id = \$3/.test(writer));
t('delete clears it ONLY when it still points at that business',
  /SET business_id = NULL[\s\S]*?AND business_id = \$3/.test(writer));
t('both writes are tenant-scoped', (writer.match(/WHERE location_id = \$1 AND contact_id = \$2/g) || []).length === 2);
t('a soft-deleted contact is left alone', (writer.match(/deleted_at IS NULL/g) || []).length === 2);

// ── Wired into the router, as its OWN branch ─────────────────────────
// Not via HANDLED_ASSOCIATIONS: that would also route business events into
// the task/note writer, which must stay untouched.
t('RelationCreate reaches the business writer', /await handleBusinessContactRelationCreate\(install, event\)/.test(router));
t('RelationDelete reaches the business writer', /await handleBusinessContactRelationDelete\(install, event\)/.test(router));
t('it is not shoehorned into HANDLED_ASSOCIATIONS',
  !/HANDLED_ASSOCIATIONS[^\n]*BUSINESSES_CONTACTS/.test(readFileSync(join(root, 'src/services/taskNoteRelationWriter.js'), 'utf8')));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
