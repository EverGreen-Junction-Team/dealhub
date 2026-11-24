// Recovering from a lost session — api/client.js.
//
// Run: node --test src/api/__tests__/lostSession.test.mjs
//
// ── WHAT A REP SAW ───────────────────────────────────────────────────
//
// A filled-in New task dialog, and under it: "Missing bearer token".
//
// That is requireSession's own string, written for whoever reads the
// server log, shown verbatim to a salesperson. It names nothing they can
// do. And it was not recoverable: the interceptor reloaded on
// TOKEN_EXPIRED only, so NO_TOKEN — sessionStorage holding no token at all
// — left the tab permanently unable to write while looking completely
// healthy. React keeps `session` in memory, so every page still renders
// and every name still resolves from data already fetched; only new
// requests fail.
//
// Partitioned storage inside the GHL iframe makes that ordinary rather
// than exotic: a browser can evict it mid-session without reloading the
// frame, and the app has no way to notice until the next request.
//
// ── AND WHY THE RELOAD IS BOUNDED ────────────────────────────────────
//
// Reloading re-runs the GHL handshake and mints a fresh token, which is
// exactly right when the token was simply lost — and an infinite reload
// loop when the handshake itself is what is failing. Hence the
// /auth/verify exclusion below, which is the half most easily dropped.

import test from 'node:test';
import assert from 'node:assert/strict';

// Imported from the real module — the same one client.js uses, so this
// cannot drift from the code the way a re-declared copy would.
const { isLostSession } = await import('../lostSession.js');

test('an expired token is recoverable', () => {
  assert.equal(
    isLostSession({ status: 401, code: 'TOKEN_EXPIRED', url: '/api/tasks' }),
    true
  );
});

test('no token at all is recoverable — this is the bug', () => {
  // The case that was missed. Without it the tab is stuck for good.
  assert.equal(
    isLostSession({ status: 401, code: 'NO_TOKEN', url: '/api/tasks' }),
    true
  );
});

test('a malformed token is recoverable', () => {
  // A token from a previous deploy, or one truncated in storage. Same
  // cause from the rep's side, same fix.
  assert.equal(
    isLostSession({ status: 401, code: 'INVALID_TOKEN', url: '/api/tasks' }),
    true
  );
});

test('a failure of verify itself is NOT recoverable', () => {
  // THE LOOP GUARD. verify is the handshake; reloading when it fails
  // reloads straight back into the same failure, for ever, and the rep
  // watches the page flicker.
  for (const code of ['TOKEN_EXPIRED', 'NO_TOKEN', 'INVALID_TOKEN']) {
    assert.equal(
      isLostSession({ status: 401, code, url: '/auth/verify' }),
      false,
      `${code} on verify must not trigger a reload`
    );
  }
});

test('a 401 from somewhere else is left alone', () => {
  // An authorisation failure that is not about our session — a GHL refusal
  // relayed through us, say. Reloading would throw away the rep's work to
  // fix something a reload cannot fix.
  assert.equal(
    isLostSession({ status: 401, code: 'GHL_SCOPE_MISSING', url: '/api/tasks' }),
    false
  );
  assert.equal(isLostSession({ status: 401, code: undefined, url: '/api/tasks' }), false);
});

test('other statuses are left alone', () => {
  // A 403, a 422 or a 500 is not a lost session, whatever else it is.
  for (const status of [400, 403, 404, 422, 500, 502]) {
    assert.equal(
      isLostSession({ status, code: 'NO_TOKEN', url: '/api/tasks' }),
      false,
      `${status} must not be treated as a lost session`
    );
  }
});

test('a missing url does not crash the check', () => {
  // error.config can be absent on a request that never went out.
  assert.equal(isLostSession({ status: 401, code: 'NO_TOKEN' }), true);
});
