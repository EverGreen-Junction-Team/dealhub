// The skill-selection fixture must reference tools that EXIST.
//
// skillEval.js makes a real API call per case, so a stale fixture is only
// discovered by paying for a run and reading a column of MISS. Renaming a
// skill is routine — three have been renamed or absorbed already this
// session — and nothing else would catch it.
//
// This runs offline: it checks names against the registry and the tool
// catalogue, not against the model.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Tool names are read from the SOURCE, not by importing the module: the
// registry pulls in config.js, which throws without DATABASE_URL, and the
// rest of this suite runs with no database at all.

let pass = 0;
const failures = [];
function t(name, cond) { if (cond) pass++; else failures.push(name); }

const fx = JSON.parse(readFileSync(new URL('../../../../evals/skillSelection.json', import.meta.url), 'utf8'));
const reg = JSON.parse(readFileSync(new URL('../../../../data/skills/registry.json', import.meta.url), 'utf8'));

const skillNames = new Set(reg.skills.map((s) => `skill_${s.skill}`));
const registrySrc = readFileSync(new URL('../tools/registry.js', import.meta.url), 'utf8');
const builtins = new Set(
  [...registrySrc.matchAll(/^\s*name: '([a-z][a-z0-9_]*)',$/gm)].map((m) => m[1])
);
const known = (n) => skillNames.has(n) || builtins.has(n);

t('the fixture has cases', fx.cases.length >= 15);

{
  const unknown = [];
  for (const c of fx.cases) {
    for (const n of [c.expect, ...(c.alsoOk || []), ...(c.avoid || [])]) {
      if (!known(n)) unknown.push(`${c.id}: ${n}`);
    }
  }
  t(`every referenced tool exists${unknown.length ? ` — missing: ${unknown.join(', ')}` : ''}`,
    unknown.length === 0);
}

{
  const dupes = fx.cases.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
  t('case ids are unique', dupes.length === 0);
}

{
  // An `avoid` entry that is also the expected answer would fail every run.
  const contradictory = fx.cases.filter((c) => (c.avoid || []).includes(c.expect));
  t('no case avoids its own expected tool', contradictory.length === 0);
}

{
  // The point of `avoid` is to name a plausible-but-wrong neighbour. One
  // without a `why` is a rule nobody can check later.
  const unexplained = fx.cases.filter((c) => (c.avoid || []).length && !c.why);
  t(`every avoid rule explains itself${unexplained.length ? ` — ${unexplained.map((c) => c.id).join(', ')}` : ''}`,
    unexplained.length === 0);
}

{
  // The forecast set is where near-misses cluster — eight skills sharing a
  // vocabulary. If none of them is covered, the eval is not testing the hard
  // part.
  const forecastCases = fx.cases.filter((c) => c.expect.includes('forecast'));
  t('the forecast skills are covered', forecastCases.length >= 6);
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILED:', failures); process.exit(1); }

// ── seedAiSkills --update-existing ───────────────────────────────────
{
  const seed = readFileSync(new URL('../../../scripts/seedAiSkills.js', import.meta.url), 'utf8');

  t('the seed script can rewrite existing skills',
    /--update-existing/.test(seed) && /updateSkill\(/.test(seed));

  // A skill's description is what the model reads to choose it, and it lives
  // in the ai_skills row. Without this flag, improving the wording in a file
  // changed nothing: `created 0 skipped 43` means nothing was rewritten, which
  // is exactly what happened after two descriptions were fixed from an eval.
  t('updating is opt-in, so a routine seed cannot overwrite a hand edit',
    /updateExisting = false/.test(seed));

  // params is JSONB and Postgres reorders an object's keys, so comparing with
  // a plain JSON.stringify marked every skill as changed — 36 of 40 on the
  // first run, burying the one that actually differed.
  t('the change check ignores JSON key order',
    /Object\.keys\(val\)\.sort\(\)/.test(seed));
}
