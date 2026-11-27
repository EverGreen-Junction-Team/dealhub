// A Refresh button for every page, so a rep never needs the browser's reload.
//
// Asked for after a search showed stale results: Chrome's reload inside GHL
// reloads GHL as well and loses your place. The shell's Refresh remounts the
// page area (<main key={refreshKey}>), so the open page fetches everything
// again — and what you had chosen stays, because filters live in useTabState.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const shell = readFileSync(new URL('../DealHubShell.jsx', import.meta.url), 'utf8')

test('one Refresh button in the shared header, so every page has it', () => {
  assert.match(shell, /onClick=\{refreshPage\}/)
  assert.match(shell, /aria-label="Refresh this page"/)
  // In the header, not inside one tab.
  const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'))
  assert.match(header, /onClick=\{refreshPage\}/)
})

test('Refresh remounts the page area and refetches the tab counts', () => {
  assert.match(shell, /<main key=\{refreshKey\}>/)
  assert.match(shell, /setRefreshKey\(\(k\) => k \+ 1\)/)
  const counts = shell.slice(shell.indexOf('summaryAPI.counts()') - 200, shell.indexOf('summaryAPI.counts()') + 300)
  assert.match(counts, /\}, \[refreshKey\]\)/)
})

test('a remount keeps the filters and search the rep had set', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://dash.test/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: dom.window.sessionStorage, configurable: true })

  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useTabState } = await import('../../hooks/useTabState.js')

  let seen
  let setQ
  function TasksPage() {
    const [q, set] = useTabState('tasks', 'q', '')
    seen = q
    setQ = set
    return null
  }
  const root = createRoot(document.getElementById('root'))
  const render = (key) => act(() => root.render(React.createElement(TasksPage, { key })))
  render(0)
  act(() => setQ('sdg'))
  assert.equal(seen, 'sdg')
  render(1) // what Refresh does: a new key, a fresh mount
  assert.equal(seen, 'sdg', 'the search survives Refresh')
  act(() => root.unmount())
})
