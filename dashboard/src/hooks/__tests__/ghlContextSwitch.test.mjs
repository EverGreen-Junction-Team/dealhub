// The GHL postMessage handshake used to resolve ONCE and never update again.
//
// Reported: "showing the contacts of all contacts not respecting the
// locationId in the dropdown list". The picker's search is server-scoped
// correctly — the bug was that the JWT carried the WRONG location, because
// GHL's sidebar can switch sub-accounts without reloading this iframe, and
// the parent frame then posts a second REQUEST_USER_DATA_RESPONSE unprompted.
// resolvedRef latched after the first one, so that message was never heard
// and the session stayed authenticated for the account the rep had LEFT.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const hook = readFileSync(new URL('../useGHLContext.js', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../../context/AuthContext.jsx', import.meta.url), 'utf8')

test('the message listener is not torn down after the first response', () => {
  // The old shape bailed out of the whole effect once resolved, so a second
  // REQUEST_USER_DATA_RESPONSE had nothing listening for it.
  assert.ok(!/if \(resolvedRef\.current\) return\s*\n\s*let messageHandler/.test(hook))
})

test('a later response is applied directly, not routed through the one-shot promise', () => {
  // requestContext()'s promise can only settle once. A second response has
  // nothing awaiting it, so it must update context on its own.
  assert.match(hook, /decryptUserData\(data\.payload\)\.then\(applyContext\)/)
})

test('the very first response still goes through the timeout-guarded promise', () => {
  // The 5s CONTEXT_TIMEOUT only makes sense for the initial handshake; a
  // later switch has no such deadline to race.
  assert.match(hook, /decryptUserData\(data\.payload\)\.then\(resolve\)\.catch\(reject\)/)
  assert.match(hook, /if \(!resolvedRef\.current\) \{/)
})

test('a failed re-decrypt on a later switch does not blank a working session', () => {
  const laterBranch = hook.slice(hook.indexOf('} else {'), hook.indexOf('}\n      }\n    }'))
  assert.match(laterBranch, /\.catch\(\(\) => \{/)
})

test('AuthContext re-authenticates when the resolved location actually changes', () => {
  assert.match(auth, /const switchedLocation = session && ghlContext\.locationId !== session\.locationId/)
  assert.match(auth, /if \(\(switchedLocation \|\| !session\) && attempts\.current < MAX\)/)
})

test('a genuine switch gets a fresh attempt budget', () => {
  // The MAX-attempts cap exists to stop a retry storm against one bad
  // handshake — it must not also lock a rep out of a second account after
  // they have switched a few times in one session.
  assert.match(auth, /if \(switchedLocation\) attempts\.current = 0/)
})
