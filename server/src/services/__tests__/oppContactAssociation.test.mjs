// Adding a contact to a deal never reached our database.
//
// WHAT HAPPENED. A rep added a contact, everything reported success, and the
// person never appeared in the People rail. The logs showed each step
// working:
//
//   POST /api/deals/v5MpTnMLyETrPTVqeHfX/contacts        201   (892ms)
//   ghlAssociations: relation created                          (GHL accepted)
//   webhook: relation event applied                      200   (we ACKed it)
//   GET  /api/deals/v5MpTnMLyETrPTVqeHfX                 304   (unchanged)
//
// That 304 is the tell. The deal genuinely had not changed, because the
// webhook handler dropped the event before writing anything.
//
// THE CAUSE. handleRelationCreate required
//   associationId === 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
// GHL does not send that string. The real payload (verbatim, from the log
// line above) carries a Mongo ObjectId instead, and identifies the relation
// through its object keys:
//
//   "associationId":  "6aab95944b0508155d99556b"
//   "firstObjectKey": "contact", "secondObjectKey": "opportunity"
//
// So every genuine RelationCreate was logged as "ignoring non-OPP_CONTACT
// association" and returned early. Only the PRIMARY contact ever showed,
// because stageHistoryWriter writes that row itself with the canonical
// string hardcoded.
//
// Asserted against the SOURCE as well as in logic: the failure was an early
// return on a field comparison, which a test of the exported function alone
// would not notice without a live database and webhook.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const writer = readFileSync(join(root, 'src/services/opportunityContactWriter.js'), 'utf8');
const backfill = readFileSync(join(root, 'src/scripts/backfillOpportunityContacts.js'), 'utf8');

let pass = 0;
const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// The exact payload GHL sent, from the production log.
const REAL_EVENT = {
  type: 'RelationCreate',
  locationId: 'fJNuIdxGgchGpJ9OoBbk',
  id: '6ac69965821d95036267e84e',
  firstObjectKey: 'contact',
  firstRecordId: 'T8v4Le9pp08Omc0oISuN',
  secondObjectKey: 'opportunity',
  secondRecordId: 'v5MpTnMLyETrPTVqeHfX',
  associationId: '6aab95944b0508155d99556b',
  pipelineId: 'npY4trIyIMS4LVQ0LkD2'
};

// Mirrors pickOppContact.
function pickOppContact(event) {
  const a = { key: event.firstObjectKey, id: event.firstRecordId };
  const b = { key: event.secondObjectKey, id: event.secondRecordId };
  if (a.key === 'opportunity' && b.key === 'contact') return { oppId: a.id, contactId: b.id };
  if (b.key === 'opportunity' && a.key === 'contact') return { oppId: b.id, contactId: a.id };
  return null;
}

// ── The bug itself ───────────────────────────────────────────────────
t('the real payload does NOT carry the canonical association string',
  REAL_EVENT.associationId !== 'OPPORTUNITIES_CONTACTS_ASSOCIATION');

t('so the old associationId guard is gone from the create handler',
  !/if \(associationId !== OPP_CONTACT_ASSOC\)/.test(writer));

t('relations are identified by object key instead',
  /const pair = pickOppContact\(event\);/.test(writer)
  && writer.indexOf('const pair = pickOppContact(event);') < writer.indexOf('await rawQuery('));

// ── The payload resolves correctly, in either key order ──────────────
t('the real payload resolves to the right opp and contact', (() => {
  const p = pickOppContact(REAL_EVENT);
  return p && p.oppId === 'v5MpTnMLyETrPTVqeHfX' && p.contactId === 'T8v4Le9pp08Omc0oISuN';
})());

t('the reversed key order resolves identically', (() => {
  const p = pickOppContact({
    firstObjectKey: 'opportunity', firstRecordId: 'opp1',
    secondObjectKey: 'contact', secondRecordId: 'c1'
  });
  return p && p.oppId === 'opp1' && p.contactId === 'c1';
})());

t('a genuinely unrelated relation is still ignored',
  pickOppContact({
    firstObjectKey: 'contact', firstRecordId: 'c1',
    secondObjectKey: 'custom_object', secondRecordId: 'x1'
  }) === null);

// ── What gets STORED must match what 13 read sites filter on ─────────
// Writing GHL's ObjectId would insert a row that every read then filters
// straight back out — the same invisible failure, one layer down.
t('the create handler stores the canonical constant, not the payload id',
  /OPP_CONTACT_ASSOC, event$/m.test(writer)
  && !/event\.associationId \|\| null, event/.test(writer));

t('stageHistoryWriter already writes that same canonical string', (() => {
  const shw = readFileSync(join(root, 'src/services/stageHistoryWriter.js'), 'utf8');
  return /'OPPORTUNITIES_CONTACTS_ASSOCIATION', 'webhook'/.test(shw);
})());

// ── The backfill had the identical flaw ──────────────────────────────
t('the backfill no longer filters on associationId',
  !/r\.associationId === OPP_CONTACT_ASSOC/.test(backfill));

t('the backfill filters by object key', /firstObjectKey === 'opportunity'/.test(backfill)
  && /secondObjectKey === 'contact'/.test(backfill));

t('the backfill also normalises what it stores',
  /OPP_CONTACT_ASSOC, r$/m.test(backfill));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
