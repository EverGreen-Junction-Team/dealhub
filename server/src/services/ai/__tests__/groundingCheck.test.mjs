// Tests for groundingCheck.js — the coarse "did this figure come from
// anywhere real" check on the portfolio Co-Pilot's free-text answers.
//
// Run: node src/services/ai/__tests__/groundingCheck.test.mjs
//
// This is a warning, not a validator like validate.js's citation check —
// there is no schema to enforce against free prose, so this only flags the
// one failure shape a real production case actually hit: a bolded deal name
// with a £ figure that no tool call this turn (or earlier in the
// conversation) backs. A regression here either stops catching that case,
// or starts flagging normal answers loudly enough that reps ignore it.

import { checkGrounding } from '../groundingCheck.js';

let pass = 0;
const failures = [];
function t(name, cond) {
  if (cond) pass++;
  else failures.push(name);
}

// The real production case: a deal named with a specific £ figure that no
// lookup this turn actually returned.
t('flags a bolded deal name with a figure nothing backs',
  checkGrounding('**Oliver Parry** deal is worth £2,579,807 in the Chris Higgs pipeline.', []).length === 1);

{
  const [w] = checkGrounding('**Oliver Parry** — £2,579,807.', []);
  t('names the unbacked deal in the warning text', w.includes('Oliver Parry'));
}

t('says nothing when the named deal IS in the known set',
  checkGrounding(
    '**Oliver Parry** deal is worth £2,579,807.',
    [{ id: 'x', name: 'Oliver Parry' }]
  ).length === 0);

t('says nothing for a correctly-backed list of many deals',
  checkGrounding(
    '18 opportunities were created last week:\n\n- **Kathryn Powell** — £8,598.00\n- **Kieran Rollings** — £5,210.00',
    [{ id: '1', name: 'Kathryn Powell' }, { id: '2', name: 'Kieran Rollings' }]
  ).length === 0);

t('says nothing when there is no money mentioned at all',
  checkGrounding('**Oliver Parry** is the primary contact on this deal.', []).length === 0);

t('says nothing for an empty or missing answer',
  checkGrounding('', []).length === 0 && checkGrounding(undefined, []).length === 0);

// A bolded heading over an aggregate ("**Summary** — 3 deals, £45,200
// combined") is not a claim about one deal named "Summary" — the exact
// false positive found while building this.
t('does not flag a structural heading like **Summary** near a total',
  checkGrounding('**Summary** — 3 deals total, worth £45,200 combined.', []).length === 0);

t('is case-insensitive on the known-deal match',
  checkGrounding('**oliver parry** — £2,579,807.', [{ id: 'x', name: 'Oliver Parry' }]).length === 0);

{
  const many = Array.from({ length: 8 }, (_, i) => `**Deal ${i}** — £${100000 + i}.`).join('\n');
  const warnings = checkGrounding(many, []);
  // One warning STRING (a banner), naming at most 5 deals inside it — not
  // 8 separate warning entries.
  t('caps the warning to a handful of names, not one per unbacked mention', warnings.length === 1);
}

// ── FALSE POSITIVES THAT REACHED A REP ───────────────────────────────
// This banner's value is that someone believes it, and each wrong warning
// spends that. Both of these shipped: one read "This answer names a deal
// ((147 days in that stage). -)", which is neither a name nor a sentence; the
// other named "Quote Sent" — a pipeline stage — as an unbacked deal. A rep who
// sees it be wrong twice stops reading it, and then it cannot do its one job.

t('does not flag a bolded sentence fragment',
  checkGrounding('The oldest is **(147 days in that stage). -** at 1,234 days.', []).length === 0);

t('does not flag a pipeline stage as a deal',
  ['Quote Sent', 'Negotiation', 'Sales Qualified', 'Marketing Qualified']
    .every((stage) => checkGrounding(`- **${stage}** — 12 deals worth 1,234,000.`, []).length === 0));

t('does not flag a bolded figure',
  checkGrounding('Totalling **£1,234,500** across the board.', []).length === 0);

t('does not flag a bolded measurement',
  checkGrounding('That is **147 days** in stage, across 1,234 deals.', []).length === 0
  && checkGrounding('Roughly **3 weeks**, worth £12,500.', []).length === 0);

// The structural-label exclusion is a WHOLE-STRING match, not a substring: a
// deal genuinely called "Summary House Renovation" must still be checked.
t('still flags a real deal whose name contains a structural word',
  checkGrounding('**Summary House Renovation** — £410,000.', []).length === 1);

// ── FALSE POSITIVES ON CORRECT ANSWERS ───────────────────────────────
// A warning that fires on a right answer is worse than no warning: it
// teaches people to ignore the banner, which is the one thing it cannot
// afford. Each of these flagged an answer whose numbers were correct.

// Whitespace is formatting, not identity. The model re-renders a name into
// its own prose, so a double space is not a different deal.
t('a name differing only in whitespace is not flagged',
  checkGrounding('**Acme  Roofing  Ltd** — £8,398.',
    [{ id: 'd1', name: 'Acme Roofing Ltd' }]).length === 0);

t('a name differing only in case is not flagged',
  checkGrounding('**ACME ROOFING LTD** — £8,398.',
    [{ id: 'd1', name: 'Acme Roofing Ltd' }]).length === 0);

// knownDeals arriving with its own stray whitespace must normalise too,
// otherwise the fix only works in one direction.
t('a stored name with stray whitespace still matches',
  checkGrounding('**Acme Roofing Ltd** — £8,398.',
    [{ id: 'd1', name: '  Acme   Roofing Ltd ' }]).length === 0);

// The real one: a deal named out of a SKILL's rows. Several views expose
// deal_name (migration 132 added it to three, precisely so the AI says a
// name rather than an id), and askPortfolio now feeds those names in. Before
// that, knownDeals was EMPTY on a skill-only turn and every correctly-named
// deal beside a figure was flagged.
t('a deal named from a skill row is not flagged once its name is known',
  checkGrounding('**Acme Roofing Ltd** lost at £8,398.',
    [{ id: null, name: 'Acme Roofing Ltd' }]).length === 0);

// And the check must still earn its keep.
t('an invented deal is still flagged alongside known ones',
  checkGrounding(
    '**Acme Roofing Ltd** at £8,398 and **Phantom Manor** at £2,580,000.',
    [{ id: 'd1', name: 'Acme Roofing Ltd' }]
  ).length === 1);

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('FAILED:', failures);
  process.exit(1);
}
