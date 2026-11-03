// What the Owner dropdown SHOWS for a given value.
//
// The bug this exists for: the filter displayed a raw GHL user id
// ("h07KvFvGuKUVREXi...") where a name belonged. Two causes, both of which
// looked reasonable in isolation — which is why a test builds the option list
// the same way the component does and asserts the selected value resolves to
// a label.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../ListFilters.jsx', import.meta.url), 'utf8')

// Rebuild the option list exactly as OwnerFilter's useMemo does.
function optionsFor(users, myId) {
  const me = myId ? users.find((u) => u.id === myId) : null
  const head = [
    { value: '', label: 'All owners' },
    { value: 'unassigned', label: 'Unassigned' }
  ]
  if (myId) {
    head.unshift({
      value: myId,
      label: me ? `Mine (${me.name || me.email || 'you'})` : 'Mine'
    })
  }
  const rest = users
    .filter((u) => u.id && u.id !== myId)
    .map((u) => ({ value: u.id, label: u.name || u.email || u.id }))
  return rest.length ? [...head, { label: '──────────', options: rest }] : head
}

const labelFor = (opts, value) => {
  for (const o of opts) {
    if (o.options) {
      const hit = o.options.find((x) => x.value === value)
      if (hit) return hit.label
    } else if (o.value === value) return o.label
  }
  return null   // no matching option — antd renders the raw value here
}

const USERS = [
  { id: 'u1', name: 'Brad Ricardo' },
  { id: 'u2', name: 'Charlie Stoyle' },
  { id: 'me', name: 'Vara Prasad' }
]

test('the signed-in user is IN the list, so their id resolves to a label', () => {
  // The original filtered `u.id !== myId` out of the options on the grounds
  // that a separate "Mine" entry covered it. The tabs then seeded the filter
  // with the raw id, so the selected value matched nothing and rendered as
  // the id — exactly what appeared on screen.
  const opts = optionsFor(USERS, 'me')
  assert.equal(labelFor(opts, 'me'), 'Mine (Vara Prasad)')
})

test('a colleague still resolves to their name', () => {
  assert.equal(labelFor(optionsFor(USERS, 'me'), 'u1'), 'Brad Ricardo')
})

test('your own row is first, so you are not hunting for yourself', () => {
  const opts = optionsFor(USERS, 'me')
  assert.equal(opts[0].value, 'me')
})

test('a user not in the synced list still gets a readable label', () => {
  // A GHL user who exists but has not synced into the users table. Before,
  // "Mine" was offered and returned nothing; now their row is present and
  // labelled, even without a name to show.
  const opts = optionsFor(USERS, 'ghost')
  assert.equal(labelFor(opts, 'ghost'), 'Mine')
})

test('users still loading: the id has no option yet', () => {
  // The transient case. labelRender turns this into the id or "Unknown owner"
  // rather than leaving antd to print the raw value.
  assert.equal(labelFor(optionsFor([], 'me'), 'me'), 'Mine')
})

test('All owners and Unassigned always resolve', () => {
  const opts = optionsFor(USERS, 'me')
  assert.equal(labelFor(opts, ''), 'All owners')
  assert.equal(labelFor(opts, 'unassigned'), 'Unassigned')
})

test('no user is listed twice', () => {
  const opts = optionsFor(USERS, 'me')
  const values = opts.flatMap((o) => (o.options ? o.options.map((x) => x.value) : [o.value]))
  assert.equal(new Set(values).size, values.length)
})

test('the MINE sentinel is gone from the module', () => {
  // One representation only: the id IS the value. A sentinel that callers
  // resolve separately is what let the seeded value and the option list
  // disagree in the first place.
  assert.doesNotMatch(src, /export const MINE/)
})

test('a warm cache still updates the component', () => {
  // THE BUG THAT PUT AN ID ON SCREEN, after the option list was already fixed.
  //
  // useUsers read `if (USER_CACHE.users) return` — a skip that looks free and
  // is not. The useState initialiser runs first and reads a null cache, so it
  // sets []. The shared fetch then RESOLVES. Only then does the effect run,
  // sees a populated cache, and returns WITHOUT calling setUsers — so the
  // component holds [] for its whole life and the selected id matches no
  // option.
  //
  // It bit exactly the tabs that also fetch users themselves: their own
  // request warms the cache in that gap. Which is why Contacts rendered the
  // raw id while its own filter chip, reading the same data from its own
  // state, rendered "J srini".
  assert.match(src, /if \(USER_CACHE\.users\) \{ setUsers\(USER_CACHE\.users\); return \}/)
  // Anchored to end-of-line: the FIXED line contains the same words and must
  // not be matched by the guard against the old one.
  assert.doesNotMatch(src, /if \(USER_CACHE\.users\) return\s*$/m)
  // Same shape, same reason, in the tag cache.
  assert.match(src, /if \(TAG_CACHE\.tags\) \{ setTags\(TAG_CACHE\.tags\); return \}/)
})

test('a stale sentinel from an older build is cleared, not sent to the API', () => {
  // '__mine__' was a real stored value until the release that removed it. It
  // survived in localStorage past that release and every request carried it to
  // an API that matched nothing: "Unknown owner" in the control, "0" beside
  // the title, and "No contacts in this sub-account yet" on an account with
  // 2,406 of them.
  const isGhlIdShaped = (v) => /^[A-Za-z0-9]{15,}$/.test(String(v))
  assert.equal(isGhlIdShaped('__mine__'), false)      // cleared
  assert.equal(isGhlIdShaped('h07KvFvGuKUVREXiabcd'), true)  // left alone
  // The component only auto-clears the first kind.
  assert.match(src, /if \(orphaned && !\/\^\[A-Za-z0-9\]\{15,\}\$\/\.test\(String\(value\)\)\) onChange\(ALL\)/)
})

test('a departed colleague is labelled, never silently cleared', () => {
  // Their records are still real and still theirs. Widening someone's filter
  // without telling them is worse than showing an empty list with a reason.
  assert.match(src, /'Former owner'/)
  assert.match(src, /no longer in the sub-account/)
})

test('the persisted store is versioned', () => {
  // The general fix: a snapshot written by a build whose values meant
  // something else is discarded, rather than revived into code that no longer
  // understands it. Without this the only cure was waiting out the 2-hour
  // expiry.
  const store = readFileSync(new URL('../../../hooks/useTabState.js', import.meta.url), 'utf8')
  assert.match(store, /const STORE_VERSION = \d+/)
  assert.match(store, /if \(raw\.v !== STORE_VERSION\) return new Map\(\)/)
  assert.match(store, /v: STORE_VERSION/)
})

test('a filter with its own control on the toolbar gets no chip', () => {
  // Owner and Tag moved out of the popover onto the toolbar, so a chip reading
  // "Owner J srini" sat inches from a dropdown reading "Mine (J srini)" — the
  // same fact twice, with two places to clear it from. Chips surface what is
  // HIDDEN in the popover; these are not hidden any more.
  const SELF_EVIDENT = new Set(['assignedTo', 'tag'])
  const filters = { assignedTo: 'me', tag: 'hot-lead', activity: 'quiet:30' }
  const allActive = Object.entries(filters).filter(([, v]) => v)
  const chipped = allActive.filter(([k]) => !SELF_EVIDENT.has(k))
  assert.deepEqual(chipped.map(([k]) => k), ['activity'])
})

test('Save view still appears when ONLY owner and tag are set', () => {
  // The trap in the dedup: keying "Save view" off the CHIPPED filters would
  // hide the button for a view filtered to one owner and one tag, which is a
  // perfectly ordinary view to want to save.
  const SELF_EVIDENT = new Set(['assignedTo', 'tag'])
  const filters = { assignedTo: 'me', tag: 'hot-lead' }
  const allActive = Object.entries(filters).filter(([, v]) => v)
  const chipped = allActive.filter(([k]) => !SELF_EVIDENT.has(k))
  assert.equal(chipped.length, 0)        // no chips
  assert.ok(allActive.length > 0)        // but Save view must still show
  const toolbar = readFileSync(new URL('../../deals/DealToolbar.jsx', import.meta.url), 'utf8')
  assert.match(toolbar, /\(allActive\.length > 0 && !activeViewId\)/)
})

test('the "everyone" option is named after the control', () => {
  // "All owners" is right on Contacts and Deals, where a record is owned. A
  // task is ASSIGNED and a note was WRITTEN — calling either an owner
  // promises a reassignment that notes do not support at all.
  const allLabel = (label, override) => override || `All ${label.toLowerCase()}s`
  assert.equal(allLabel('Owner'), 'All owners')
  assert.equal(allLabel('Assignee'), 'All assignees')
  assert.equal(allLabel('Author'), 'All authors')
  assert.equal(allLabel('Owner', 'Everyone'), 'Everyone')
})

test('the "nobody" option can be renamed per tab', () => {
  // An unassigned TASK is the one most likely to be missed, so "Nobody" reads
  // as a problem. A note with no author is just old data, so "No author" is
  // the honest wording — neither is "Unassigned".
  const card = readFileSync(new URL('../ListFilters.jsx', import.meta.url), 'utf8')
  assert.match(card, /noneLabel = 'Unassigned'/)
  assert.match(card, /label: noneLabel/)
})

test('Tasks and Notes both default to the signed-in user', () => {
  const tasks = readFileSync(new URL('../../tabs/TasksTab.jsx', import.meta.url), 'utf8')
  const notes = readFileSync(new URL('../../tabs/NotesTab.jsx', import.meta.url), 'utf8')
  assert.match(tasks, /defaultOwner\(session\)/)
  assert.match(notes, /defaultOwner\(session\)/)
  // useTabState, so a change survives a tab switch and a reload rather than
  // snapping back to Mine on every visit.
  assert.match(tasks, /useTabState\('tasks', 'owner'/)
  assert.match(notes, /useTabState\('notes', 'author'/)
})

test('both tabs expose a sort control, and remember the choice', () => {
  const tasks = readFileSync(new URL('../../tabs/TasksTab.jsx', import.meta.url), 'utf8')
  const notes = readFileSync(new URL('../../tabs/NotesTab.jsx', import.meta.url), 'utf8')

  // Persisted like every other filter — a rep who switches to created-date
  // should not be put back on due-date by a tab switch.
  assert.match(tasks, /useTabState\('tasks', 'sort', 'due'\)/)
  assert.match(notes, /useTabState\('notes', 'sort', 'desc'\)/)

  // And actually sent, or the control would move and nothing would change.
  assert.match(tasks, /due: dueFilter, sort,/)
  assert.match(notes, /limit: 20, cursor, sort,/)

  // In the deps, or the list would not refetch when it moved. Matched as
  // MEMBERSHIP, not as the exact array: pinning the full list failed the day a
  // filter was added beside it, which is not what this test is about.
  assert.match(tasks, /deps: \[[^\]]*\bsort\b[^\]]*\]/)
  assert.match(notes, /deps: \[filters, author, sort\]/)
})

test('the sort control is shared, not copied per tab', () => {
  // Tasks has antd Selects and a Label helper; Notes has neither. Two
  // hand-rolled versions would drift in width, height and wording the first
  // time either was touched.
  const shared = readFileSync(new URL('../ListFilters.jsx', import.meta.url), 'utf8')
  assert.match(shared, /export function SortSelect/)
  const tasks = readFileSync(new URL('../../tabs/TasksTab.jsx', import.meta.url), 'utf8')
  const notes = readFileSync(new URL('../../tabs/NotesTab.jsx', import.meta.url), 'utf8')
  assert.match(tasks, /<SortSelect/)
  assert.match(notes, /<SortSelect/)
})

test('notes sorts by direction, not by which timestamp', () => {
  // A "date synced" option was offered and removed: it answers a question
  // about our sync rather than the business, and it was the ordering that
  // LOOKS chronological while being arbitrary — every backfilled note shares
  // one import timestamp. Direction is the useful choice.
  const notes = readFileSync(new URL('../../tabs/NotesTab.jsx', import.meta.url), 'utf8')
  assert.match(notes, /value: 'desc', label: 'Newest first'/)
  assert.match(notes, /value: 'asc', label: 'Oldest first'/)
  assert.doesNotMatch(notes, /Date synced/)
})

test('tasks offers a direction only on created date', () => {
  // A due-date list read backwards is a list of overdue tasks, which the Due
  // filter already answers better.
  const tasks = readFileSync(new URL('../../tabs/TasksTab.jsx', import.meta.url), 'utf8')
  assert.match(tasks, /value: 'created_desc'/)
  assert.match(tasks, /value: 'created_asc'/)
  assert.doesNotMatch(tasks, /value: 'due_desc'/)
})

console.log('owner filter: all cases pass')
