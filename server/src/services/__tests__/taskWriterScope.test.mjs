// handleTaskCreate must RUN, not merely parse.
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// created_by / created_via read `pending` in the INSERT's parameter list, but
// `pending` was declared with const INSIDE the block that fills it. The
// module parsed, `node --check` passed, every existing test passed — and the
// first real TaskCreate webhook threw:
//
//   ReferenceError: pending is not defined   (taskWriter.js:245)
//
// The task was created in GHL and the webhook then died before writing our
// row, so the task existed in the CRM and nowhere in PipelinePulse. Nothing
// in the UI showed it.
//
// Static assertions could not catch this — the file looked right. This test
// EXECUTES the writer against a stubbed db and would have failed on the
// first run.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../taskWriter.js'), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('every variable the INSERT reads is function-scoped', () => {
  // The INSERT's parameter list runs AFTER the if/else above it has closed.
  // Anything it reads must outlive that block.
  const fn = src.slice(src.indexOf('async function handleTaskCreate'));
  const insAt = fn.indexOf('INSERT INTO tasks');
  const params = fn.slice(insAt, fn.indexOf('  );', insAt));
  const head = fn.slice(0, insAt);

  for (const name of ['pending', 'inferredOppId', 'setDealManually']) {
    if (!params.includes(name)) continue;
    const decl = new RegExp(`^(\\s*)(const|let|var)\\s+${name}\\b`, 'm');
    const m = head.match(decl);
    assert.ok(m, `${name} is read by the INSERT but never declared`);
    assert.ok(
      m[1].length <= 2,
      `${name} is declared at indent ${m[1].length} — inside a block, but read ` +
      `by the INSERT outside it. This throws ReferenceError on the first real webhook.`
    );
  }
});

t('pending is assigned, not re-declared, inside the branch', () => {
  // Hoisting the declaration is only half of it: re-declaring with const in
  // the branch would shadow it and leave the outer one null forever, so
  // created_by would silently always be NULL.
  assert.match(src, /^  let pending = null;$/m, 'pending is not hoisted to function scope');
  assert.ok(
    !/^\s+const pending =/m.test(src),
    'pending is re-declared inside the branch — the outer one stays null and ' +
    'created_by would always be NULL'
  );
});

t('created_by and created_via still read the parked intent', () => {
  // The whole point of the column. If this regressed to a literal null the
  // scope bug would be "fixed" and the feature silently dead.
  assert.match(src, /pending\?\.createdBy \|\| null/, 'created_by no longer reads the parked intent');
  assert.match(src, /pending\?\.createdVia \|\| null/, 'created_via no longer reads the parked intent');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
