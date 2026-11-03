// users.location_ids — every sub-account a GHL user is attached to.
//
// Run: node --test src/services/__tests__/userLocationIds.test.mjs
//
// Migration 133 promoted roles.type and repaired roles.role. This is the third
// field of the same object, and the one that answers "is this person actually
// a MEMBER of this sub-account?".
//
// The symptom it explains: backfillUsersForLocation reads
// GET /users/?locationId=…, which returns only members. An agency admin who
// OWNS the location is absent, so no row exists for them — and the Deal hub's
// Co-Pilot sidebar, which resolves the signed-in user's name against that same
// list, rendered the avatar as a bare dot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const writer = readFileSync(join(here, '..', 'userWriter.js'), 'utf8');
const script = readFileSync(join(here, '..', '..', 'scripts', 'syncUserRoles.js'), 'utf8');
const enrich = readFileSync(join(here, '..', 'ghlEnrichment.js'), 'utf8');
const deals = readFileSync(join(here, '..', '..', 'routes', 'deals.js'), 'utf8');
const migration = readFileSync(
  join(here, '..', '..', '..', 'migrations', '139_users_location_ids.sql'), 'utf8'
);

// The extraction, mirrored from userWriter so these assert behaviour.
const extract = (payload) => {
  const roles = payload?.roles;
  const obj = roles && !Array.isArray(roles) && typeof roles === 'object' ? roles : null;
  const first = Array.isArray(roles) ? roles[0] : null;
  const raw = obj?.locationIds ?? first?.locationIds ?? null;
  return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id) : null;
};

test('the object shape GHL actually sends', () => {
  // Verified against the live API: an agency admin carries the owning
  // sub-account in locationIds while an account user may not.
  assert.deepEqual(
    extract({ roles: { type: 'agency', role: 'admin', locationIds: ['a', 'b'] } }),
    ['a', 'b']
  );
});

test('the array shape an older writer expected', () => {
  // 133 handles both for the same reason — rows written before the fix.
  assert.deepEqual(extract({ roles: [{ type: 'account', locationIds: ['x'] }] }), ['x']);
});

test('a payload that says nothing stays NULL, not empty', () => {
  // "Attached to nowhere" is a different claim from "no list was sent", and
  // GHL never made the first one.
  assert.equal(extract({}), null);
  assert.equal(extract({ roles: {} }), null);
  assert.equal(extract({ roles: { locationIds: 'not-an-array' } }), null);
});

test('junk entries are dropped, not stored', () => {
  assert.deepEqual(extract({ roles: { locationIds: ['a', '', null, 7, 'b'] } }), ['a', 'b']);
});

// ---- the wiring ----------------------------------------------------------

test('the writer stores it, and never blanks a list it already holds', () => {
  assert.match(writer, /location_ids\s+= COALESCE\(EXCLUDED\.location_ids, users\.location_ids\)/);
  assert.match(writer, /const locationIds = Array\.isArray\(rawLocIds\)/);
});

test('the column is TEXT\\[\\] with a membership index', () => {
  // The question asked of it is `$1 = ANY(location_ids)`, which an array index
  // serves where JSONB containment would be heavier for no gain.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS location_ids TEXT\[\]/);
  assert.match(migration, /USING GIN \(location_ids\)/);
});

test('the script UPSERTS, because the row may not exist', () => {
  // A user absent from the location's own list has no row yet — that absence
  // is the whole problem, so an UPDATE would write nothing.
  assert.match(script, /INSERT INTO users \(/);
  assert.match(script, /ON CONFLICT \(location_id, user_id\) DO UPDATE SET/);
});

test('the script fetches by ID, not the member list', () => {
  // GET /users/?locationId=… omits non-members, which is exactly who this is
  // for. GET /users/{id} answers for anyone the token can see.
  assert.match(script, /url: `\/users\/\$\{encodeURIComponent\(userId\)\}`/);
  // The member-list path survives in a COMMENT explaining why it is wrong
  // here — check the call, not the file.
  assert.doesNotMatch(script, /url: `\/users\/\?locationId=/);
});

test('with no location it sweeps every active install', () => {
  // The roles payload is per USER, not per location: an agency admin attached
  // to four sub-accounts is missing from all four user lists, so fixing one by
  // hand leaves the other three with the same blank avatar.
  assert.match(script, /SELECT location_id FROM installs/);
  assert.match(script, /WHERE uninstalled_at IS NULL/);
});

test('one location failing does not abandon the rest', () => {
  // A dead token on an old sub-account would otherwise stop the whole sweep.
  const loop = script.slice(script.indexOf('for (const locationId of locations)'));
  assert.match(loop, /try \{/);
  assert.match(loop, /catch \(err\) \{/);
});

test('the installing user is included even with no row', () => {
  // They are the case this exists for — absent from the location's own list,
  // so nothing in our database can answer "what is this person called?".
  assert.match(script, /if \(install\.user_id && !ids\.includes\(install\.user_id\)\) ids\.push/);
});

// ---- users deleted in GHL -------------------------------------------------

test('a 404 marks the user inactive rather than failing', () => {
  // "The user does not exist." — deleted in GHL, still in our table.
  assert.match(script, /err\?\.response\?\.status === 404/);
  assert.match(script, /SET active = false/);
});

test('it is a SOFT delete, matching the webhook', () => {
  // Opportunities, tasks and notes still carry assigned_to pointing at this
  // id; the owner name on a closed deal should not go blank because the rep
  // has since left. /deals/users filters on active = true, so they drop out
  // of the dropdowns either way.
  assert.match(script, /deleted_at = COALESCE\(deleted_at, now\(\)\)/);
  assert.doesNotMatch(script, /DELETE FROM users/);
});

test('a non-404 error is still reported, not swallowed', () => {
  // A dead token or a rate limit is not a deletion, and treating it as one
  // would quietly deactivate every user on the location.
  const branch = script.slice(script.indexOf('err?.response?.status === 404'));
  assert.match(branch, /failed\+\+/);
  assert.match(branch, /logger\.warn/);
});

// ---- the webhook path -----------------------------------------------------
//
// The script repairs history; the webhook is what keeps it repaired. Every
// UserCreate/UserUpdate fetches the API record, because the webhook payload
// carries id/name/email and an event `type` ("UserUpdate") — not roles.

test('the fetch is skipped only when the event has the FULL roles object', () => {
  // A payload carrying a bare role string ("admin") satisfied the old
  // `!event.role` check and skipped the fetch — but a string has no
  // locationIds, so that column stayed NULL for exactly the users whose
  // membership matters most.
  assert.match(writer, /Array\.isArray\(eventRoles\.locationIds\)/);
  assert.match(writer, /if \(!eventHasFullRoles\) \{/);
  assert.doesNotMatch(writer, /if \(!event\.roles && !event\.role\) \{/);
});

test('a 404 during the webhook soft-deletes, like UserDelete', () => {
  // The user was removed between the event being queued and us reading it.
  // Writing them back as active would resurrect a row the next sweep has to
  // clean up again.
  assert.match(writer, /if \(full\?\.__notFound\) \{/);
  assert.match(writer, /upsertUser\(locationId, fromEvent, \{ markInactive: true \}\)/);
});

test('getUserFull tells "does not exist" apart from "fetch failed"', () => {
  // One means delete the row, the other means try again later. Returning null
  // for both made them indistinguishable.
  assert.match(enrich, /if \(err\?\.response\?\.status === 404\)/);
  assert.match(enrich, /return \{ __notFound: true \}/);
});

test('the not-found marker never reaches a stored row', () => {
  // It is a signal, not a user. An early return keeps it out of
  // pickUserFields and therefore out of raw_user.
  const branch = writer.slice(writer.indexOf('if (full?.__notFound) {'));
  const ret = branch.indexOf('return;');
  const pick = branch.indexOf('pickUserFields');
  assert.ok(ret > -1 && ret < pick, 'the marker can reach pickUserFields');
});

// ---- the owner dropdown ---------------------------------------------------

test('the dropdown shows ACTIVE ACCOUNT users only', () => {
  // NULL used to pass: a row with no type was "unknown, not known-agency",
  // and hiding a real rep was judged worse than showing one extra name. That
  // was right while nothing could reliably fill the column.
  const q = deals.slice(deals.indexOf('SELECT user_id, name, email, role, user_type'));
  assert.match(q, /AND active = true/);
  assert.match(q, /AND deleted_at IS NULL/);
  assert.match(q, /AND user_type = 'account'/);
  assert.doesNotMatch(
    q.slice(0, q.indexOf('ORDER BY')),
    /user_type IS NULL OR/,
    'NULL passes again — an agency user can reappear in the dropdown'
  );
});

test('the nightly sync can actually fill the column it exists for', () => {
  // usersSync calls backfillUsersForLocation, which reads the LIST endpoint —
  // and that payload has no `roles`. Without a per-user fetch the nightly job
  // rewrote every row and left user_type exactly as it found it, so a rep
  // stuck at NULL would now silently vanish from the dropdown.
  const fn = writer.slice(writer.indexOf('export async function backfillUsersForLocation'));
  assert.match(fn, /if \(!raw\.roles\) \{/);
  assert.match(fn, /await getUserFull\(install, u\.userId\)/);
  assert.match(fn, /full && !full\.__notFound/);
});

test('the dropdown shows only users attached to THIS sub-account', () => {
  // The row's own location_id is not proof of membership: every path that
  // writes a user stamps it with whichever location was being synced. One
  // user in the live account is attached to six sub-accounts and would
  // otherwise be a "rep" in all six.
  const q = deals.slice(deals.indexOf('SELECT user_id, name, email, role, user_type'));
  assert.match(q, /AND \(location_ids IS NULL OR \$1 = ANY\(location_ids\)\)/);
});

test('a missing list passes, unlike a missing type', () => {
  // The asymmetry is deliberate. user_type is a scalar every payload carries;
  // locationIds is a list an older raw_user may simply not hold. Treating a
  // missing list as "belongs nowhere" would EMPTY the dropdown on any install
  // whose rows predate the sync — much louder than one extra name.
  const q = deals.slice(deals.indexOf('SELECT user_id, name, email, role, user_type'));
  const where = q.slice(0, q.indexOf('ORDER BY'));
  assert.match(where, /location_ids IS NULL OR/);
  assert.match(where, /user_type = 'account'/);
  assert.doesNotMatch(where, /user_type IS NULL OR/);
});

test('the filter behaves correctly for every list shape', () => {
  // Mirrors `location_ids IS NULL OR $1 = ANY(location_ids)`.
  const visible = (ids, loc) => ids === null || ids.includes(loc);
  assert.equal(visible(null, 'L1'), true, 'pre-sync rows must stay visible');
  assert.equal(visible(['L1', 'L2'], 'L1'), true, 'a real member must show');
  assert.equal(visible(['L2', 'L3'], 'L1'), false, 'another location\'s user must not');
  assert.equal(visible([], 'L1'), false, 'GHL saying "belongs nowhere" must hide');
});
