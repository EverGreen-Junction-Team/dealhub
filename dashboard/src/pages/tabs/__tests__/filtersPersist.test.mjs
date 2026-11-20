// Leaving a page and coming back must put you where you were.
//
// THE SHELL UNMOUNTS TABS. It renders them as
// `{activeTab === 'deals' && <DealsTab/>}`, so switching away destroys the
// component and every plain useState in it resets. That is the whole reason
// useTabState exists — and the reason this keeps regressing: a new filter
// added with useState works perfectly until somebody navigates away, which
// is not something you notice while building the filter itself.
//
// So this pins the rule rather than any one bug: anything that describes
// WHERE THE REP WAS — a view, a stage, a filter, a sort, a search — is
// remembered, on every page that has one.
//
// Source-parsed, because the alternative is mounting five tabs against a
// live API and a GHL session to assert a thing that is visible in one line
// of each file.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const tabs = (name) => readFileSync(join(here, '..', name), 'utf8')

const deals = tabs('DealsTab.jsx')
const contacts = tabs('ContactsTab.jsx')
const tasksTab = tabs('TasksTab.jsx')
const notes = tabs('NotesTab.jsx')
const businesses = tabs('BusinessesTab.jsx')
const hub = tabs('DealHubTab.jsx')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }

// `const [x, setX] = useTabState(` for a given state name.
const remembered = (src, name) =>
  new RegExp(`\\[\\s*${name}\\s*,[^\\]]*\\]\\s*=\\s*useTabState\\(`).test(src)

const plainState = (src, name) =>
  new RegExp(`\\[\\s*${name}\\s*,[^\\]]*\\]\\s*=\\s*useState\\(`).test(src)

console.log('the list pages — filters, sorts and searches')

t('Deals remembers its filters, stage, pipeline, sort and search', () => {
  // filters carries status, stageId, tag and assignedTo — the toolbar's
  // whole row, including the stage the board is narrowed to.
  assert.ok(remembered(deals, 'filters'), 'deals filters')
  assert.ok(remembered(deals, 'boardPipelineId'), 'deals board pipeline')
  assert.ok(remembered(deals, 'sort'), 'deals sort')
  assert.ok(remembered(deals, 'sortDir'), 'deals sort direction')
  assert.ok(remembered(deals, 'search'), 'deals search')
  assert.ok(remembered(deals, 'activeViewId'), 'deals saved view')
})

t('Contacts remembers its filters, saved view and search', () => {
  assert.ok(remembered(contacts, 'filters'), 'contacts filters')
  assert.ok(remembered(contacts, 'activeViewId'), 'contacts saved view')
  assert.ok(remembered(contacts, 'search'), 'contacts search')
})

t('Tasks remembers due, status, owner, sort and search', () => {
  // The case the hook's own comment was written about: filtered to "Due next
  // 30 days", clicked a task through to its deal, came back to a cleared
  // filter.
  assert.ok(remembered(tasksTab, 'dueFilter'), 'tasks due filter')
  assert.ok(remembered(tasksTab, 'dueRange'), 'tasks due range')
  assert.ok(remembered(tasksTab, 'status'), 'tasks status')
  assert.ok(remembered(tasksTab, 'owner'), 'tasks owner')
  assert.ok(remembered(tasksTab, 'sort'), 'tasks sort')
})

t('Notes remembers its author, sort and search', () => {
  assert.ok(remembered(notes, 'author'), 'notes author')
  assert.ok(remembered(notes, 'sort'), 'notes sort')
  assert.ok(remembered(notes, 'q'), 'notes search')
})

t('Businesses remembers its sort and search', () => {
  assert.ok(remembered(businesses, 'sort'), 'businesses sort')
  assert.ok(remembered(businesses, 'q'), 'businesses search')
})

console.log('the view switchers')

t('every list page persists which view it was left on', () => {
  // localStorage rather than useTabState, and deliberately: which layout you
  // prefer is a standing preference, not part of one session's "where was
  // I". What matters here is only that it IS persisted somewhere — a plain
  // useState would send every rep back to the default view on every visit.
  for (const [name, src] of [
    ['deals', deals], ['contacts', contacts], ['tasks', tasksTab],
    ['notes', notes], ['businesses', businesses]
  ]) {
    assert.match(src, new RegExp(`localStorage\\.getItem\\('pp\\.${name}\\.view'`),
      `${name} view is not restored`)
    assert.match(src, new RegExp(`localStorage\\.setItem\\('pp\\.${name}\\.view'`),
      `${name} view is not saved`)
  }
})

console.log('the Deal hub')

t('the Deal / People / Media rail is remembered', () => {
  // THE ONE THAT WAS BROKEN. Reading Media, stepping into Tasks and coming
  // back put you on Deal. Not per deal: which rail you read is a habit.
  assert.ok(remembered(hub, 'leftRail'), 'hub left rail')
  assert.ok(!plainState(hub, 'leftRail'), 'hub left rail must not be plain state')
})

t('the timeline filters are remembered PER DEAL', () => {
  // Scope matters here in a way it does not elsewhere: a people filter is a
  // list of this deal's contacts, so restoring it onto another deal would
  // filter by people who are not on it and show an empty timeline.
  assert.match(hub, /useTabState\('hub',\s*'timelineFilters'/)
  assert.match(hub, /filterSnapshot\.dealId === dealId/)
})

t('a remount of the same deal does not wipe the restored filters', () => {
  // The subtle half. The deal fetch runs on every mount and used to clear
  // the filters unconditionally, so the restore above would be undone a few
  // hundred milliseconds after it happened — which looks exactly like "the
  // filters were never saved".
  assert.match(hub, /filtersBelongTo\.current !== d\.id/)
  const reset = hub.slice(hub.indexOf('filtersBelongTo.current !== d.id'))
  assert.match(reset.slice(0, 220), /setChannelFilter\(\[\]\)/)
  assert.match(reset.slice(0, 220), /setPeopleFilter\(\[\]\)/)
})

t('switching to a different deal still starts clean', () => {
  // The guard must compare against the LOADED deal, not merely exist — a
  // guard that always passes would carry one deal's people filter onto the
  // next, which is the bug the per-deal scoping exists to prevent.
  assert.match(hub, /const filtersBelongTo = useRef\(dealId\)/)
})

console.log(`\n${n} passed, 0 failed`)
