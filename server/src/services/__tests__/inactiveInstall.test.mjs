// "This sub-account is no longer connected" was reported for TWO different
// states, and for one of them it was untrue.
//
// WHAT HAPPENED. A PATCH /api/tasks/:id returned 409 "no longer connected"
// while every read kept working. The install was fine — it was FLAGGED:
// installs.reauth_required_at had been set by one endpoint 401ing (a note
// relations call needing notes.write) without `scopeOptional`.
// getActiveInstall withholds a flagged install, so all 12 write paths 409'd
// with a message describing a state that had not occurred, and the only trace
// of the real reason was a logger.debug invisible in production.
//
// Reads were unaffected because they query our own Postgres and never touch
// GHL — which is exactly what made it look like one broken write endpoint.
//
// Asserted against the SOURCE: the defect was a hardcoded string repeated at
// 12 call sites, which no unit test of any single function would catch.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, '../../routes');
const routeFiles = readdirSync(routesDir).filter((f) => f.endsWith('.js'));

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── No route may hardcode the message any more ───────────────────────
const offenders = routeFiles.filter((f) =>
  readFileSync(join(routesDir, f), 'utf8').includes("'This sub-account is no longer connected'")
);
t('no route hardcodes the disconnected message', offenders.length === 0);

// ── Every getActiveInstall null-check explains itself ────────────────
for (const f of routeFiles) {
  const src = readFileSync(join(routesDir, f), 'utf8');
  if (!src.includes('getActiveInstall')) continue;
  // webhooks.js uses allowDead and never refuses a write, so it needs none.
  if (f === 'webhooks.js') continue;
  t(`${f} calls explainInactiveInstall`, src.includes('explainInactiveInstall'));
  t(`${f} imports it`, /import \{[^}]*explainInactiveInstall[^}]*\} from '\.\.\/services\/ghlClient\.js'/.test(src));
}

// ── The helper distinguishes the two states ──────────────────────────
const client = readFileSync(join(here, '../ghlClient.js'), 'utf8');
t('explainInactiveInstall exists', /export async function explainInactiveInstall/.test(client));
t('it reports reauth_required', client.includes("reason: 'reauth_required'"));
t('it reports not_installed', client.includes("reason: 'not_installed'"));
t('it uses allowDead to see the flagged install',
  /explainInactiveInstall[\s\S]{0,400}allowDead: true/.test(client));

// ── The diagnostic must be visible in production ─────────────────────
// Scoped to the guard BLOCK, not a character count. The first version took
// the next 900 characters, which swept in tryHealReauth's own logger.error
// and failed on correct code — a brittle assertion, not a regression.
const guardStart = client.indexOf('if (install.reauth_required_at && !allowDead)');
const guard = client.slice(guardStart, client.indexOf('\n  }', guardStart));
t('the reauth guard logs at warn, not debug',
  // At debug this was invisible in production, which is why the cause took a
  // support round trip to find.
  /logger\.warn/.test(guard) && !/logger\.debug/.test(guard));

t('the guard block is what was measured, not a fixed window',
  // Guards the assertion above: if this slice ever spans the whole file the
  // test would pass on anything.
  guard.length > 100 && guard.length < 2500 && guard.includes('tryHealReauth'));

// ── `reason` must survive to the client ──────────────────────────────
for (const [file, cls] of [
  ['../businessPatch.js', 'BusinessWriteError'],
  ['../tagPatch.js', 'TagWriteError'],
  ['../notePatch.js', 'NoteWriteError'],
  ['../opportunityPatch.js', 'OpportunityWriteError'],
  ['../taskPatch.js', 'TaskWriteError'],
]) {
  const src = readFileSync(join(here, file), 'utf8');
  t(`${cls} accepts a reason`, /constructor\(message, \{[^}]*reason = null[^}]*\}/.test(src));
  t(`${cls} stores it`, /this\.reason = reason/.test(src));
}

// ── Self-healing ─────────────────────────────────────────────────────
//
// The flag is set by ANY unguarded 401, so one endpoint the app lacks a scope
// for can flag a healthy install. Recovery was a deadlock: clearing the flag
// needs a successful refresh, a refresh only happens inside ghlRequest, and
// ghlRequest is only reached via getActiveInstall — which refused to return a
// flagged install. The only exits were a reinstall or hand-written SQL.
t('a flagged install gets one chance to prove its token works',
  /tryHealReauth/.test(client) && /const healed = await tryHealReauth\(install\)/.test(client));

t('the heal runs BEFORE the refusal, not after',
  client.indexOf('const healed = await tryHealReauth(install)')
    < client.indexOf("'getActiveInstall: install is flagged reauth_required"));

t('a successful heal returns the install so the write proceeds',
  /if \(healed\) return healed;/.test(client));

t('the heal forces the refresh — an unexpired token would otherwise no-op',
  // ensureFreshToken returns early when the token has not expired, which
  // would skip the UPDATE that clears the flag.
  /refreshAccessToken\(install, \{ force: true \}\)/.test(client));

// Assert the cooldown is ENFORCED, not merely declared. The first version
// checked that both identifiers appeared somewhere in the file, which a
// rename left passing while the limit was gone.
const heal = client.slice(client.indexOf('async function tryHealReauth'),
                          client.indexOf('async function markReauthRequired'));
t('heal attempts are rate limited',
  // Without this a genuinely dead install retries on every request and can
  // get the app rate-limited across every location.
  /Date\.now\(\) - last < REHEAL_COOLDOWN_MS/.test(heal)
  && /return null;/.test(heal));

t('and the attempt time is recorded, or the limit never triggers',
  /lastHealAttempt\.set\(locationId, Date\.now\(\)\)/.test(heal));

t('the cooldown is a real duration',
  /const REHEAL_COOLDOWN_MS = \d+ \* \d+ \* 1000/.test(client));

t('a failed heal leaves the flag set',
  // The catch returns null rather than clearing anything, so a genuinely dead
  // install is still refused.
  /catch \(err\) \{[\s\S]{0,400}return null;/.test(client.slice(client.indexOf('async function tryHealReauth'))));

t('a failed heal logs GHL\'s own error, not a summary',
  /logger\.error\(\s*\{ err, locationId \}/.test(client.slice(client.indexOf('async function tryHealReauth'))));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
