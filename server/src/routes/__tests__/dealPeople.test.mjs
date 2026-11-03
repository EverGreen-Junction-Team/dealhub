// The deal's people must carry their LINK id, not only their contact id.
//
// DELETE /api/deals/:id/contacts/:relationId unlinks a contact from a deal.
// The endpoint has existed and worked; the detail route never SENT
// relation_id, so the client had nothing to call it with — which is why the
// deal hub's Remove button was inert ("coming next") and the edit panel had
// no way to manage people at all.
//
// relation_id is opportunity_contacts' primary key (migration 048) and is
// issued by GHL, so it is the only correct handle for the delete.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const deals = readFileSync(join(here, '..', 'deals.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('the deal detail route sends relationId');

t('the contacts query selects relation_id', () => {
  assert.match(deals, /oc\.relation_id/,
    'without this the client cannot unlink anyone');
});

t('the people mapping exposes it as relationId', () => {
  assert.match(deals, /relationId: c\.relation_id \|\| null/);
});

t('it is NULL-guarded rather than assumed', () => {
  // A deal whose contact has no opportunity_contacts row gets a synthesised
  // primary. That link does not exist, so there is nothing to delete — the
  // UI hides Remove when relationId is null rather than calling with
  // "undefined" and getting a 404.
  assert.match(deals, /relationId: c\.relation_id \|\| null/,
    'a missing relation must be null, not undefined');
});

t('the delete route still keys on relationId', () => {
  assert.match(deals, /dealsRouter\.delete\('\/:id\/contacts\/:relationId'/);
  // And scopes the delete to the opportunity, so a relation id from another
  // deal cannot unlink someone here.
  assert.match(deals, /WHERE location_id = \$1 AND relation_id = \$2 AND opportunity_id = \$3/);
});

t('the add route exists and takes a contactId', () => {
  assert.match(deals, /dealsRouter\.post\('\/:id\/contacts'/);
});

console.log(`\n${n} passed`);
