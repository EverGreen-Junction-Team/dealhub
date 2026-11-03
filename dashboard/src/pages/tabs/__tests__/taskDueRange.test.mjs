// The custom due-date range on the Tasks tab, and the server filter behind it.
//
// Run: node --test src/pages/tabs/__tests__/taskDueRange.test.mjs
//
// Every assertion here guards something that fails SILENTLY — a wrong range
// still renders a plausible list of tasks, just not the right one.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const tab = readFileSync(new URL('../TasksTab.jsx', import.meta.url), 'utf8')
const route = readFileSync(
  new URL('../../../../../pipelinePulse/server/src/routes/tasks.js', import.meta.url),
  'utf8'
)

test('the range picker is portalled into the house calendar theme', () => {
  // antd renders the panel to document.body, outside [data-dealhub], so every
  // design token falls back to nothing without this class — the same trap
  // .pp-menu and .pp-cal exist for.
  assert.match(tab, /popupClassName="pp-cal"/)
})

test('the range is stored as strings, not dayjs objects', () => {
  // useTabState persists through localStorage. A dayjs instance does not
  // survive JSON: it returns as a plain object and throws on .format().
  assert.match(tab, /format\('YYYY-MM-DD'\)/)
  assert.match(tab, /useTabState\('tasks', 'dueRange', null\)/)
})

test('changing the range refetches page one', () => {
  // Without dueRange in the deps, picking a new range while already on
  // 'custom' leaves dueFilter unchanged and the list keeps the old rows.
  assert.match(tab, /deps: \[[^\]]*\bdueRange\b[^\]]*\]/)
})

test('the bounds are only sent with the custom filter', () => {
  assert.match(tab, /dueFrom: dueFilter === 'custom'/)
  assert.match(tab, /dueTo: dueFilter === 'custom'/)
})

test('the end date covers the whole final day', () => {
  // `due_at <= '12 Oct'` compares against midnight and silently drops a task
  // due 12 Oct at 10:00 — the single most likely bug in a date range.
  assert.match(route, /INTERVAL '1 day'/)
  assert.doesNotMatch(route, /t\.due_at <= \$\{params\.length\}::date/)
})

test('a malformed bound is rejected rather than reaching Postgres', () => {
  // The values are query parameters, so this is not injection — but an
  // invalid date literal makes Postgres throw, turning a typo into a 500.
  assert.match(route, /const DATE_RE = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//)
})

test('a dated range does not imply an open status', () => {
  // The presets filter to open tasks; a range must not. "What was due in
  // March" includes what was completed in March.
  const custom = route.slice(route.indexOf("due === 'custom'"))
  const clause = custom.slice(0, custom.indexOf('}\n'))
  assert.doesNotMatch(clause, /status = 'open'/)
})
