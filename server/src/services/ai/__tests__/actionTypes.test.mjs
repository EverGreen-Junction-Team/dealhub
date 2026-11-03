// The DB constraint and the executor must agree on what an action can be.
//
// They did not. ai_actions.action_type allowed 5 values; actionExecutor
// dispatched on 24. A rep asking Co-Pilot to create a task got an opaque
// "system error" because the INSERT failed a check constraint — the tools and
// the UI were all wired, only the constraint was stale.
//
// Reading both sides from SOURCE rather than restating them: a hardcoded
// expected list here would drift exactly the way the constraint drifted.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// Every `case 'x':` the executor dispatches on.
const executorSrc = readFileSync(join(root, 'src/services/ai/actionExecutor.js'), 'utf8');
const executorTypes = new Set(
  [...executorSrc.matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1])
);

// The newest migration that (re)defines the constraint wins.
const migrationSrc = readFileSync(
  join(root, 'migrations/081_ai_actions_all_types.sql'), 'utf8'
);
const checkBlock = migrationSrc.match(
  /ADD CONSTRAINT ai_actions_action_type_check\s*CHECK\s*\(action_type IN\s*\(([\s\S]*?)\)\s*\)/
);
const constraintTypes = new Set(
  checkBlock ? [...checkBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
);

t('the migration defines a parseable constraint', constraintTypes.size > 0);
t('the executor dispatches on a non-trivial set', executorTypes.size >= 20);

// The regression itself: anything the executor can run must be insertable.
const missingFromDb = [...executorTypes].filter((x) => !constraintTypes.has(x));
t(
  `every executor action is allowed by the constraint${
    missingFromDb.length ? ` (missing: ${missingFromDb.join(', ')})` : ''
  }`,
  missingFromDb.length === 0
);

// And the reverse, so the constraint does not promise actions nothing runs —
// a row that inserts fine and then has no executor case is a different, later
// failure with the same shape.
const missingFromExecutor = [...constraintTypes].filter((x) => !executorTypes.has(x));
t(
  `every allowed action has an executor case${
    missingFromExecutor.length ? ` (orphaned: ${missingFromExecutor.join(', ')})` : ''
  }`,
  missingFromExecutor.length === 0
);

// The specific action from the report, named so a regression is obvious.
t('create_task is insertable (the reported failure)', constraintTypes.has('create_task'));
t('create_task has an executor case', executorTypes.has('create_task'));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
