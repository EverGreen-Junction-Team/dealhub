// Two sub-accounts open in two browser tabs must not share a session.
//
// WHAT HAPPENED. Open location A in one tab and location B in another.
// Refresh tab B — it authenticates and gets B's data. Switch back to tab A
// and click anything: it now fetches B's data. Then refresh tab A, go back
// to tab B, click — B fetches A's. Whichever tab authenticated LAST won for
// ALL of them.
//
// THE CAUSE. The JWT, the active location and the tab-state snapshot all
// lived in localStorage, which is shared by EVERY tab of the same origin.
// Each tab's React state was correct and isolated; but the API client read
// the token from storage on every request, not from React — so a refresh in
// tab B overwrote the one key tab A was about to read.
//
// THE FIX. sessionStorage: same API, same origin rules, scoped to ONE tab.
// Per-user view preferences (pp.deals.view etc.) are genuinely user-wide and
// stay in localStorage.
//
// Asserted against the source. Two real browser tabs cannot be driven from
// here, and the bug was a storage-scope choice that no test of the hooks'
// exported behaviour would ever surface.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const auth    = read('../../context/AuthContext.jsx')
const client  = read('../../api/client.js')
const control = read('../../api/control.js')
const tabs    = read('../useTabState.js')

// The three per-session keys. Any of these in localStorage reintroduces
// the cross-tab leak.
const SESSION_KEYS = ['sessionToken', 'pp.activeLocation', 'pp.tabstate']

test('no per-session key is ever written to localStorage', () => {
  for (const [name, src] of [['AuthContext', auth], ['client', client], ['control', control], ['useTabState', tabs]]) {
    for (const key of SESSION_KEYS) {
      const re = new RegExp(`localStorage\\.(set|get|remove)Item\\(\\s*['"]${key.replace('.', '\\.')}['"]`)
      assert.ok(!re.test(src), `${name} still touches localStorage for ${key}`)
    }
  }
})

test('the JWT is written AND read from sessionStorage', () => {
  assert.match(auth,   /sessionStorage\.setItem\('sessionToken'/)
  assert.match(client, /sessionStorage\.getItem\('sessionToken'\)/)
  // The download path builds its own fetch and bypasses the axios
  // interceptor — a second reader that would have kept leaking on its own.
  assert.match(control, /sessionStorage\.getItem\('sessionToken'\)/)
})

test('the active location is per-tab too', () => {
  // useTabState keys its snapshot on this. Shared across tabs it would
  // decide tab A's snapshot "matched" tab B's location and keep A's filters
  // and chat history on screen under B's name.
  assert.match(auth, /sessionStorage\.setItem\('pp\.activeLocation'/)
  assert.match(tabs, /sessionStorage\.getItem\('pp\.activeLocation'\)/)
})

test('the tab-state snapshot store is per-tab', () => {
  const persist = tabs.slice(tabs.indexOf('function persist()'), tabs.indexOf('/**\n * Like useState'))
  assert.match(persist, /sessionStorage\.setItem\(/)
  assert.ok(!/localStorage/.test(persist), 'persist() must not write to localStorage')
})

test('logout clears all three from sessionStorage', () => {
  const logout = auth.slice(auth.indexOf('const logout = '), auth.indexOf('setSession(null)'))
  for (const key of SESSION_KEYS) {
    assert.match(logout, new RegExp(`sessionStorage\\.removeItem\\('${key.replace('.', '\\.')}'\\)`),
      `logout should clear ${key}`)
  }
})

test('user-wide view preferences deliberately STAY in localStorage', () => {
  // These are "I prefer the board view", not "which account am I in". A
  // preference that reset every time a tab was opened would be a regression
  // dressed up as a fix.
  const deals = read('../../pages/tabs/DealsTab.jsx')
  assert.match(deals, /localStorage\.getItem\('pp\.deals\.view'\)/)
})
