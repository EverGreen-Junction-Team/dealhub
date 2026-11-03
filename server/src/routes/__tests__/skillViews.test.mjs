// GET /api/control/skills/views — the view dropdown's options.
//
// Someone configuring a skill had to type the view's exact name from memory.
// The names are in the database catalogue; this endpoint reads them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const control = readFileSync(join(root, 'src/routes/control.js'), 'utf8');
const validator = readFileSync(join(root, 'src/services/ai/skillValidator.js'), 'utf8');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// ROUTE ORDER. Express matches in order and ":name" matches the literal
// string "views", so registering the list route second would send
// GET /skills/views into describeView(locationId, 'views') and 404.
t('the list route is declared BEFORE /skills/views/:name',
  control.indexOf("controlRouter.get('/skills/views'")
    < control.indexOf("controlRouter.get('/skills/views/:name'"));
t('both routes exist',
  control.includes("controlRouter.get('/skills/views'")
  && control.includes("controlRouter.get('/skills/views/:name'"));

// The listing must apply the SAME rule the validator enforces on save.
// Offering a view that would then be refused reads as a bug in the form.
const list = validator.slice(
  validator.indexOf('export async function listUsableViews'),
  validator.indexOf('export async function describeView')
);
t('only plain views are offered (not tables, not matviews)',
  /relkind = 'v'/.test(list));
t('only the public schema is offered', /nspname = 'public'/.test(list));
t('security_invoker is required', /security_invoker/.test(list));
t('both the true and on spellings are accepted', /\(true\|on\)/.test(list));
t('a NULL reloptions does not throw', /COALESCE\(c\.reloptions/.test(list));
t('the query is tenant-scoped through withTenant', /withTenant/.test(list));
t("the view's own comment comes back for the dropdown's second line",
  /obj_description/.test(list));
t('results are ordered by name', /ORDER BY c\.relname/.test(list));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
