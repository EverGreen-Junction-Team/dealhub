// One row per person on a deal, on EVERY route that reads them.
//
// Run: node --test src/routes/__tests__/dealPeopleDedup.test.mjs
//
// WHY. opportunity_contacts is keyed on (location_id, relation_id), NOT on
// (opportunity, contact). So one person holds two rows for the same deal:
//
//   primary:<opp>:<contact>   written by stageHistoryWriter from the
//                             opportunity's own contact_id
//   <ghl relation id>         written once the associations sync sees GHL's
//                             real OPPORTUNITIES_CONTACTS_ASSOCIATION
//
// Every read therefore has to collapse them, and each place that forgets shows
// the same person twice — both badged PRIMARY, because is_primary is true on
// both rows.
//
// The detail route was fixed when this was first reported. The LIST route and
// the per-deal counts were not, so the same deal read correctly in the edit
// panel and doubled on the card. These assertions cover all three.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../deals.js', import.meta.url), 'utf8');

// The json_agg subquery the LIST route builds `linked_contacts` from.
const listAgg = route.slice(
  route.indexOf('SELECT json_agg(x ORDER BY x.is_primary DESC'),
  route.indexOf('AS linked_contacts')
);

test('the list route collapses the duplicate relation rows', () => {
  assert.match(listAgg, /SELECT DISTINCT ON \(oc2\.contact_id\)/);
});

test('and keeps GHL\'s real relation over the synthetic one', () => {
  // The delete endpoint needs the id GHL will actually accept, so the
  // synthetic row must lose the tie.
  assert.match(listAgg, /\(oc2\.relation_id LIKE 'primary:%'\) ASC/);
});

test('the detail route still collapses them too', () => {
  // This one was already fixed; it is pinned so a refactor cannot quietly
  // drop it and reintroduce the duplicate in the edit panel.
  assert.match(route, /SELECT DISTINCT ON \(oc\.contact_id\) c\.contact_id/);
  assert.match(route, /\(oc\.relation_id LIKE 'primary:%'\) ASC/);
});

test('the per-deal contact count counts PEOPLE, not relation rows', () => {
  // COUNT(*) reported a deal with three people as having four, which is what
  // the nav pill and the "N of 11" label both read.
  const counts = route.slice(route.indexOf('AS contacts'), -1);
  assert.ok(counts.length > 0, 'the counts query moved');
  assert.match(
    route,
    /COUNT\(DISTINCT contact_id\)::int FROM opportunity_contacts/
  );
});

test('no read of opportunity_contacts counts rows blindly', () => {
  // A plain COUNT(*) over this table is always wrong — it counts relations,
  // and the question is always "how many people".
  assert.doesNotMatch(
    route,
    /COUNT\(\*\)::int FROM opportunity_contacts/
  );
});
