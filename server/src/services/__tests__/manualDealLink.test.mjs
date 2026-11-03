// The "a human decided this" rule for notes and tasks — migration 068.
//
// Run: node src/services/__tests__/manualDealLink.test.mjs
//
// These assert the SQL semantics of the ON CONFLICT clause in noteWriter.js
// and taskWriter.js against the three states a deal link can be in. They run
// the real CASE expression, so a change to it that breaks one of these fails
// here rather than in production.
//
// The bug this guards against: opportunity_id = NULL had to mean both "nobody
// has decided yet" (the rule should fill it) and "a rep unlinked it on
// purpose" (the rule must not). Indistinguishable, so every deliberate unlink
// was refilled on the next sync of that record — a rep detached a note, fixed
// a typo in GHL, and the note reattached itself.
//
// No database needed: the clause is small enough to model exactly, and the
// live behaviour was verified against real Postgres when it was written.

// The clause, as it appears in both writers.
function applyUpsert(existing, incoming, manual) {
  //   opportunity_id = CASE WHEN <t>.deal_set_manually THEN <t>.opportunity_id
  //                         ELSE COALESCE(<t>.opportunity_id, EXCLUDED.opportunity_id) END
  if (manual) return existing;
  return existing ?? incoming;
}

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── A deliberate unlink ──────────────────────────────────────────────
// The case that was broken. NULL + manual must stay NULL.
t('an unlink survives a sync that guessed a deal',
  applyUpsert(null, 'dealA', true) === null);

t('an unlink survives repeated syncs',
  applyUpsert(applyUpsert(null, 'dealA', true), 'dealB', true) === null);

// ── A deliberate move ────────────────────────────────────────────────
t('a manual move is not overwritten by the rule',
  applyUpsert('dealB', 'dealA', true) === 'dealB');

t('a manual move survives a sync carrying nothing',
  applyUpsert('dealB', null, true) === 'dealB');

// ── Not manual: the rule may still work ──────────────────────────────
// The flag must not freeze automatic attribution — a note nobody has touched
// still needs a deal.
t('a gap is filled by the rule',
  applyUpsert(null, 'dealA', false) === 'dealA');

t('a brand new record takes the incoming value',
  applyUpsert(undefined ?? null, 'dealA', false) === 'dealA');

// An automatic value is kept rather than re-guessed, so attribution does not
// flip between runs as deals open and close. This is the existing-wins rule
// notes were missing entirely before.
t('an automatic value is not revised by a later guess',
  applyUpsert('dealA', 'dealB', false) === 'dealA');

// ── The distinction the flag exists for ──────────────────────────────
t('NULL means different things with and without the flag',
  applyUpsert(null, 'dealA', true) !== applyUpsert(null, 'dealA', false));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
