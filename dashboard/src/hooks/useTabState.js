import { useCallback, useState } from 'react'

// State that survives leaving a tab and coming back.
//
// The shell renders tabs as `{activeTab === 'tasks' && <TasksTab/>}`, so
// switching away UNMOUNTS the component and every useState resets. A rep who
// filtered to "Due next 30 days", clicked a task through to its deal, and came
// back found the filter cleared and their place lost.
//
// The store is module-level rather than React state on purpose: it must outlive
// the component, and putting it in the shell would mean threading a prop for
// every filter on every page. Keyed by page, so two pages can both hold a `q`
// without colliding.
//
// Persisted, but with an EXPIRY.
//
// It was memory-only, which covered tab switches (the common case) but not a
// reload — and this app is an iframe inside GHL, where a reload is a routine
// thing rather than a rare one. A rep who filtered the deals list, opened a
// deal in the hub and hit refresh came back to a default list.
//
// sessionStorage, NOT localStorage. localStorage is shared by every tab of
// this origin: with two sub-accounts open side by side, the stored location
// and snapshot were whichever tab wrote last, so tab A's filters and chat
// history appeared under tab B's name. sessionStorage is scoped to one tab,
// which is exactly the lifetime a "where was I" snapshot should have.
//
// Not plain persistence though: coming back TOMORROW to yesterday's filter
// still applied, with no visible reason, is worse than a clean page. So the
// snapshot expires — long enough to survive a reload and a detour through
// another tab, short enough that a new session starts clean.
const STORE_KEY = 'pp.tabstate'
// Bumped whenever a stored VALUE changes meaning, not merely when a new key is
// added. A snapshot from an older build is then dropped rather than revived
// into code that no longer understands it.
//
// v2: the owner filter briefly stored a '__mine__' sentinel that the tabs
// resolved to a user id at request time. That sentinel is gone — the id IS the
// value now — but a snapshot written by the old build kept sending '__mine__'
// to the API, which matched no user and returned nothing. On screen: "Unknown
// owner" and an empty list, on an account with 2,406 contacts. The two-hour
// expiry would have cleared it eventually, which is no comfort to whoever hits
// it first.
const STORE_VERSION = 2
const MAX_AGE_MS = 2 * 60 * 60 * 1000   // 2 hours — a working session, not a day

// The sub-account this snapshot belongs to. A saved view id or a pipeline id
// from one sub-account is meaningless in another — and showing a rep another
// location's filters would look like a data leak even though the LIST is
// always fetched for the current location.
//
// Read from the shell's own stored position, which is already location-keyed,
// rather than threading a prop through every useTabState call site.
function currentLocationId() {
  try {
    // Written by AuthContext on every successful verify, so it is the location
    // the SESSION is for — not a guess.
    //
    // This used to scan for a `pp.position.*` key and return the first match.
    // That key is written per sub-account, so after a rep had visited two, the
    // scan returned whichever Object.keys happened to list first. Switching
    // location then compared the new snapshot against the OLD id, decided it
    // matched, and kept the previous account's Insights AI history and Recents
    // on screen under the new account's name. It looked like a data leak. It
    // was a scan returning the wrong answer.
    return sessionStorage.getItem('pp.activeLocation') || null
  } catch { /* storage blocked */ }
  return null
}

function load() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return new Map()
    // A stale snapshot is discarded wholesale rather than per key: the values
    // describe one moment together, and reviving half of them would leave a
    // filter applied with the view that produced it gone.
    if (!raw.at || Date.now() - raw.at > MAX_AGE_MS) return new Map()
    // Written by a build whose values meant something else. Same treatment as
    // a stale one: discard the lot.
    if (raw.v !== STORE_VERSION) return new Map()
    // Same reasoning for a different sub-account: drop it all.
    const loc = currentLocationId()
    if (loc && raw.loc && raw.loc !== loc) return new Map()
    return new Map(Object.entries(raw.values || {}))
  } catch {
    // Private mode, disabled storage, or a shape we no longer understand.
    return new Map()
  }
}

// The location this in-memory store was loaded for. A module-level `store`
// is created ONCE per page load, but a sub-account switch inside GHL does not
// reload the iframe — so without this the store kept serving the previous
// location's values for the rest of the session, no matter what load() would
// have decided had it run again.
let storeLoc = currentLocationId()
let store = load()

// Drop everything if the sub-account has changed since the store was built.
// Called on every read and write rather than on a listener: there is no event
// for "GHL switched location", and a check that costs one sessionStorage read is
// cheaper than being wrong.
function ensureCurrentLocation() {
  const loc = currentLocationId()
  if (loc !== storeLoc) {
    storeLoc = loc
    store = new Map()
    try { sessionStorage.removeItem(STORE_KEY) } catch { /* storage blocked */ }
  }
}

function persist() {
  try {
    sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        v: STORE_VERSION,
        at: Date.now(),
        loc: currentLocationId(),
        values: Object.fromEntries(store)
      })
    )
  } catch {
    // Storage full or disabled. Losing the snapshot costs a rep their place;
    // throwing here would cost them the page.
  }
}

/**
 * Like useState, but the value is remembered per (page, key) for the lifetime
 * of the session.
 *
 * @param {string} page  e.g. 'tasks' — namespaces the key
 * @param {string} key   e.g. 'dueFilter'
 * @param {*} initial    used only when nothing has been remembered yet
 */
export function useTabState(page, key, initial) {
  const id = `${page}:${key}`
  const [value, setValue] = useState(() => {
    ensureCurrentLocation()
    return store.has(id) ? store.get(id) : initial
  })

  const set = useCallback((next) => {
    setValue((prev) => {
      // Support the updater form, or callers can't do setX(v => !v).
      const resolved = typeof next === 'function' ? next(prev) : next
      ensureCurrentLocation()
      store.set(id, resolved)
      persist()
      return resolved
    })
  }, [id])

  return [value, set]
}

/**
 * Set a page's remembered value from OUTSIDE it — before switching to that
 * tab, so it mounts already showing it. The Contacts list's "View note" uses
 * this to open Notes filtered to the contact with the note in the reader.
 */
export function setTabState(page, key, value) {
  ensureCurrentLocation()
  store.set(`${page}:${key}`, value)
  persist()
}

/**
 * Forget a page's remembered state.
 *
 * Used when a deliberate reset should stick — clearing a search, say — so the
 * next visit starts clean rather than restoring what was just cleared.
 */
export function clearTabState(page) {
  for (const id of [...store.keys()]) {
    if (id.startsWith(`${page}:`)) store.delete(id)
  }
  persist()
}
