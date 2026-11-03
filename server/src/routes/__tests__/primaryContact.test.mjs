// ONE primary contact per deal, and changing it actually changes the deal.
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// A deal showed TWO people badged PRIMARY, and "Make primary" appeared to do
// nothing. Two independent faults producing one symptom:
//
//   1. PUT /primary-contact wrote NOTHING locally. It called GHL and relied
//      on an OpportunityUpdate webhook to carry the new contactId back. For a
//      contactId-only change that webhook is not guaranteed, so our row kept
//      the old primary and the UI repainted from it — the same failure the
//      business link had.
//
//   2. The people list computes `primary` as
//        !!p.is_primary || p.contact_id === d.contact_id
//      — two separate stores of one fact, OR'd. stageHistoryWriter inserted a
//      new `primary:` row with is_primary = true but never demoted the old
//      one, so once they disagreed BOTH rendered as PRIMARY.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const deals = read('../deals.js');
const writer = read('../../services/stageHistoryWriter.js');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// The route body, so a match elsewhere in this 2,700-line file cannot pass.
function primaryRoute() {
  const at = deals.indexOf("dealsRouter.put('/:id/primary-contact'");
  assert.notEqual(at, -1, 'primary-contact route not found');
  const end = deals.indexOf('dealsRouter.', at + 10);
  return deals.slice(at, end === -1 ? at + 4000 : end);
}

t('changing the primary writes to our own row, not just GHL', () => {
  const body = primaryRoute();
  assert.match(
    body, /UPDATE opportunities[\s\S]{0,120}SET contact_id/,
    'the route still leaves opportunities.contact_id to a webhook that may never arrive'
  );
});

t('the deal page follows the new primary', () => {
  // The deal's `contact` block joins on opportunities.contact_id, so writing
  // that column IS what makes the main deal page show the new person. Pinned
  // because the two are only connected by that column.
  assert.match(
    deals, /contact: d\.contact_id \? \{/,
    'the deal detail no longer resolves its contact from opportunities.contact_id'
  );
});

t('exactly one link row stays flagged primary', () => {
  const body = primaryRoute();
  assert.match(
    body, /UPDATE opportunity_contacts[\s\S]{0,160}is_primary = \(contact_id = \$3\)/,
    'the route does not re-flag the link rows — two people can read as PRIMARY'
  );
});

t('the webhook path demotes the previous primary too', () => {
  // The route is not the only writer: an OpportunityUpdate carrying a new
  // contactId arrives here. Without the demotion this re-creates the bug on
  // every change made outside our UI.
  const at = writer.indexOf("'primary:' || $2 || ':' || $3");
  assert.notEqual(at, -1, 'the primary link insert is gone');
  const after = writer.slice(at, at + 1400);
  assert.match(
    after, /UPDATE opportunity_contacts[\s\S]{0,200}SET is_primary = false/,
    'stageHistoryWriter promotes the new primary without demoting the old one'
  );
  assert.match(after, /contact_id <> \$3/, 'the demotion is not scoped away from the new primary');
});

t('the demotion cannot reach another deal', () => {
  const at = writer.indexOf('SET is_primary = false');
  const stmt = writer.slice(at, at + 400);
  assert.match(stmt, /location_id = \$1/, 'demotion is not scoped to the location');
  assert.match(stmt, /opportunity_id = \$2/, 'demotion is not scoped to this deal');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
