// Provenance and the correction loop.
//
// Two of the three gaps the accuracy review named. Both are about being able
// to DIAGNOSE a wrong answer rather than prevent one — which is the part that
// decides whether a wrong number gets fixed or just argued about.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0;
const failures = [];
function t(name, cond) { if (cond) pass++; else failures.push(name); }

const store = readFileSync(new URL('../skillStore.js', import.meta.url), 'utf8');
const loop = readFileSync(new URL('../tools/toolLoop.js', import.meta.url), 'utf8');
const view = readFileSync(
  new URL('../../../../migrations/125_vw_answer_corrections.sql', import.meta.url), 'utf8'
);

// ── lineage ──────────────────────────────────────────────────────────
t('a skill result carries the query that produced it',
  /query: \{ sql, values \}/.test(store));

t('the bound values travel with the SQL',
  // Half the explanation: the same query with min_deals 5 and 50 are
  // different answers.
  /query: \{ sql, values \}/.test(store));

t('the run log keeps the query',
  /query: out\?\.query \|\| null/.test(loop));

t('the MODEL never receives the SQL',
  // Tokens spent on something it cannot use, and an invitation to quote a
  // query back to a rep.
  /out && out\.query \? \(\(\{ query, \.\.\.rest \}\) => rest\)\(out\) : out/.test(loop));

// ── correction loop ──────────────────────────────────────────────────
t('a down-rating is joined to the run that caused it',
  /rr\.rating = 'down'/.test(view));

t('the corrections join is scoped to the sub-account',
  // ai_runs is keyed per location; an id-only join would cross accounts.
  /r\.location_id = rr\.location_id/.test(view));

t('a correction says WHICH tools ran',
  // Without this every report is a guess: wrong skill, wrong view and wrong
  // reading of correct rows all look identical from the answer alone.
  /what_ran/.test(view) && /toolCalls/.test(view));

t('an answer that called nothing is flagged',
  // The most serious kind of wrong answer — the model used its own memory.
  /answered_without_looking/.test(view));

t('both the typed reason and the reason tags are kept',
  // A rep often picks a chip and types nothing; the chip alone still narrows
  // where to look.
  /rr\.reason\b/.test(view) && /rr\.reasons\b/.test(view));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILED:', failures); process.exit(1); }
