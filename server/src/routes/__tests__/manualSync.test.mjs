// Pressing "Sync now" must run ONE catalogue, for ONE sub-account.
//
// ── WHY THE ROUTE EXISTS ─────────────────────────────────────────────
//
// Businesses, tags and custom field definitions arrive by no webhook: GHL
// fires nothing when one is created, renamed or deleted. They land only on
// the 3am reconciliation, so a field added this morning is missing from every
// dropdown until tomorrow.
//
// ── WHAT THESE PIN ───────────────────────────────────────────────────
//
// The two things that would be quietly wrong rather than broken: running
// every tenant's sync from one rep's button press, and reporting success for
// a run that actually failed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const control = readFileSync(join(here, '../control.js'), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

function routeBody() {
  const at = control.indexOf("controlRouter.post('/sync/:kind'");
  assert.notEqual(at, -1, 'the sync route is gone');
  const end = control.indexOf('controlRouter.', at + 10);
  return control.slice(at, end === -1 ? control.length : end);
}

t('syncs ONE location, never every install', () => {
  // ForAllInstalls would set every other tenant's sync running from one
  // rep's button press — on a shared GHL rate limit, and writing to accounts
  // whose users did not ask for it.
  // Checked against CODE, not the whole file: the route's own comment
  // explains why ForAllInstalls is not used, and matching that made the test
  // fail on correct code.
  const code = control.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(
    !/ForAllInstalls/.test(code),
    'control.js calls a ForAllInstalls sync — one rep would sync every tenant'
  );
  for (const fn of ['syncBusinessesForLocation', 'syncTagsForLocation', 'syncCustomFieldsForLocation']) {
    assert.ok(control.includes(fn), `${fn} is not wired up`);
  }
});

t('the sync kind is allow-listed, not taken from the URL', () => {
  const body = routeBody();
  assert.match(body, /SYNCABLE\[kind\]/, 'the kind is not looked up in an allow-list');
  assert.match(body, /if \(!job\)/, 'an unknown kind is not rejected');
});

t('a sync that reported a failure is not returned as success', () => {
  // These services report failure in the RETURN VALUE rather than throwing,
  // so a plain 200 would tell a rep their catalogue refreshed when it did
  // not — and they would go on wondering why the new field is still missing.
  const body = routeBody();
  assert.match(body, /result && result\.error/, 'a failed run is not detected');
  assert.match(body, /502/, 'a failed run does not surface as an error status');
});

t('an uninstalled account is refused before reaching GHL', () => {
  const body = routeBody();
  assert.match(body, /getActiveInstall/, 'the install is not resolved');
  assert.match(body, /explainInactiveInstall/, 'an inactive install gets no explanation');
});

t('the route is tenant-scoped through the session, not a parameter', () => {
  // locationId must come from the session. Taking it from the body or query
  // would let any caller sync — and write to — another sub-account.
  const body = routeBody();
  assert.match(body, /const locationId = req\.locationId/, 'location is not read from the session');
  assert.ok(
    !/req\.(body|query)\.locationId/.test(body),
    'location is taken from the request — that is a tenant boundary hole'
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
