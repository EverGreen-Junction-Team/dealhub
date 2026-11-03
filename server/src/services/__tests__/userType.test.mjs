// Agency vs account users — who counts as a sales rep.
//
// GHL's `roles` is an OBJECT ({ role, type, locationIds }), not an array.
// The old reader expected an array, so `role` came out NULL on every real
// payload and `type` was never read at all. These pin both.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const R = (p) => readFileSync(join(here, '..', '..', '..', p), 'utf8');
const writer = R('src/services/userWriter.js');
const deals = R('src/routes/deals.js');
const migration = R('migrations/133_users_type.sql');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { fail++; console.error(`FAIL ${name}\n  ${e.message}`); }
};

// The extraction, mirrored from pickUserFields. Kept in step by the source
// assertions below rather than by importing (userWriter pulls in db.js).
function extract(payload) {
  const roles = payload.roles;
  const rolesObj = roles && !Array.isArray(roles) && typeof roles === 'object' ? roles : null;
  const rolesFirst = Array.isArray(roles) ? roles[0] : null;
  let role = null;
  if (typeof payload.role === 'string') role = payload.role;
  else if (payload.role?.type) role = payload.role.type;
  else if (rolesObj?.role) role = rolesObj.role;
  else if (rolesFirst) role = typeof rolesFirst === 'string' ? rolesFirst : (rolesFirst.type || null);
  const envelopeType = (payload.companyId && !payload.locationId) ? 'agency' : null;
  const userType = rolesObj?.type
    ?? (typeof rolesFirst === 'object' ? rolesFirst?.type : null)
    ?? payload.role?.type ?? envelopeType ?? null;
  return { role, userType };
}

// ── the shape GHL actually sends ─────────────────────────────────────
t('an agency user is typed agency', () => {
  const { role, userType } = extract({
    id: 'u1', roles: { role: 'admin', type: 'agency', locationIds: ['a', 'b'] }
  });
  assert.equal(userType, 'agency');
  assert.equal(role, 'admin', 'role must come from roles.role, not roles.type');
});

t('an account user is typed account', () => {
  const { role, userType } = extract({ id: 'u2', roles: { role: 'user', type: 'account' } });
  assert.equal(userType, 'account');
  assert.equal(role, 'user');
});

t('the legacy array shape still reads', () => {
  assert.equal(extract({ id: 'u3', roles: [{ type: 'account' }] }).userType, 'account');
});

t('a flat role string leaves type unknown', () => {
  const { role, userType } = extract({ id: 'u4', role: 'admin' });
  assert.equal(role, 'admin');
  assert.equal(userType, null);
});

t('no roles at all is null, not a guess', () => {
  assert.deepEqual(extract({ id: 'u5' }), { role: null, userType: null });
});

// ── the webhook envelope `type` is NOT the user type ─────────────────
// A UserCreate/UserUpdate payload carries type: "UserUpdate" — the EVENT
// name. Reading it as the user's kind would type every user as "UserUpdate",
// and the dropdown's `<> 'agency'` test would pass them all through while
// looking like it worked.
t('the webhook event name never becomes a user type', () => {
  const evt = { type: 'UserUpdate', id: 'u1', firstName: 'Paul', email: 'p@x.com' };
  assert.equal(extract(evt).userType, null);
});

t('a webhook with no roles yields no type', () => {
  // This is the normal case — webhooks do not carry roles at all.
  assert.equal(extract({ type: 'UserCreate', id: 'u2', email: 'x@y.com' }).userType, null);
});

t('merging the API record supplies the type', () => {
  const evt = { type: 'UserUpdate', id: 'u1', firstName: 'Eduarda' };
  const full = { id: 'u1', roles: { role: 'admin', type: 'agency', locationIds: ['a'] } };
  const merged = extract({ ...evt, ...full });
  assert.equal(merged.userType, 'agency');
  assert.equal(merged.role, 'admin');
});

t('the upsert path fetches the full user when the event has no roles', () => {
  assert.match(writer, /if \(!event\.roles && !event\.role\)/);
  assert.match(writer, /getUserFull\(install, fromEvent\.userId\)/);
});

t('a failed fetch still writes the user', () => {
  // `if (full)` — no throw, no skip. A user we cannot type is written with
  // type NULL and shows in the dropdown, which is the safe direction.
  assert.match(writer, /const full = await getUserFull[\s\S]{0,120}if \(full\)/);
});

// ── the envelope shape as a fallback clue ────────────────────────────
// GHL scopes an agency user's events to a COMPANY and a sub-account user's to
// a LOCATION. When no roles object arrives, that shape is the only signal —
// and it is already on the payload, so it costs no API call.
t('companyId with no locationId means agency', () =>
  assert.equal(extract({ id: 'u1', companyId: 'C1', locations: ['L1', 'L2'] }).userType, 'agency'));

t('locationId alone does NOT mean account', () => {
  // Deliberately not inferred. Absence of a company clue is not evidence of
  // being a rep, and guessing here types people we cannot actually identify.
  assert.equal(extract({ id: 'u2', locationId: 'L1' }).userType, null);
});

t('a restricted agency user carries BOTH and stays unknown', () => {
  // roles.restrictSubAccount puts an agency user on specific locations, so
  // the envelope has companyId AND locationId. Reading locationId as
  // "account" would type exactly the person this feature excludes.
  assert.equal(extract({ id: 'u3', companyId: 'C1', locationId: 'L1' }).userType, null);
});

t('a real roles object always beats the envelope', () =>
  assert.equal(extract({ id: 'u4', companyId: 'C1', roles: { type: 'account' } }).userType, 'account'));

t('the envelope rule is only in the agency direction', () =>
  assert.match(writer, /payload\.companyId && !payload\.locationId\) \? 'agency' : null/));

// ── unknown is not agency ────────────────────────────────────────────
t('type is never defaulted to account', () =>
  assert.doesNotMatch(writer, /userType\s*=\s*['"]account['"]/));

t('the dropdown lets NULL through', () =>
  assert.match(deals, /user_type IS NULL OR user_type <> 'agency'/));

t('the reason NULL passes is written down', () =>
  assert.match(deals, /unknown, not\s*\n\s*\/\/ known-agency/));

// ── the writer persists it ───────────────────────────────────────────
t('user_type is inserted', () => assert.match(writer, /user_type,?\s*active/));
t('an omitted type does not blank a known one', () =>
  assert.match(writer, /user_type\s*=\s*COALESCE\(EXCLUDED\.user_type, users\.user_type\)/));

// ── the backfill ─────────────────────────────────────────────────────
t('the backfill reads both roles shapes', () => {
  assert.match(migration, /raw_user -> 'roles' ->> 'type'/);
  assert.match(migration, /raw_user -> 'roles' -> 0 ->> 'type'/);
});
t('the backfill also repairs role', () =>
  assert.match(migration, /SET role = COALESCE/));
t('the migration is re-runnable', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS user_type/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS users_loc_rep/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
