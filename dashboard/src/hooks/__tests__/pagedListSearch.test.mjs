// A search typed quickly must search for what was typed.
//
// Reported with a screenshot: Tasks' search box read "sdg" and the request
// carried q=s. usePagedList skipped every load while one was in flight — the
// "load more" guard applied to new lists too — so "d" and "g" were dropped
// and the "s" results were shown under "sdg". Contacts, Deals, Notes and
// Businesses use the same hook.
//
// Rendered for real (React + jsdom), not read as source.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { usePagedList } = await import('../usePagedList.js')

// A fake server: each request waits until the test answers it.
function fakeServer() {
  const pending = []
  const fetchPage = ({ cursor }) => new Promise((resolve) => {
    pending.push({ q: fetchPage.q, cursor, answer: (rows, nextCursor = null) => resolve({ tasks: rows, nextCursor }) })
  })
  return { pending, fetchPage }
}

function mount(server, q) {
  let latest
  function Probe({ q }) {
    server.fetchPage.q = q
    latest = usePagedList({ fetchPage: server.fetchPage, key: 'tasks', deps: [q] })
    return null
  }
  const root = createRoot(document.getElementById('root'))
  act(() => root.render(React.createElement(Probe, { q })))
  return {
    type: (next) => act(() => root.render(React.createElement(Probe, { q: next }))),
    get: () => latest,
    unmount: () => act(() => root.unmount())
  }
}

test('every keystroke sends its own query, even while one is loading', async () => {
  const server = fakeServer()
  const ui = mount(server, 's')
  ui.type('sd')
  ui.type('sdg')
  // The bug: one request, q=s.
  assert.deepEqual(server.pending.map((r) => r.q), ['s', 'sd', 'sdg'])
  ui.unmount()
})

test('the list shows the LAST search, whatever order the answers arrive in', async () => {
  const server = fakeServer()
  const ui = mount(server, 's')
  ui.type('sd')
  ui.type('sdg')
  const [s, sd, sdg] = server.pending
  await act(async () => { sdg.answer([{ id: 'match-sdg' }]) })
  await act(async () => { s.answer([{ id: 'match-s' }]) })
  await act(async () => { sd.answer([{ id: 'match-sd' }]) })
  assert.deepEqual(ui.get().items.map((x) => x.id), ['match-sdg'])
  ui.unmount()
})

test('a late answer for an old search does not unlock "load more" early', async () => {
  const server = fakeServer()
  const ui = mount(server, 'a')
  const first = server.pending[0]
  await act(async () => { first.answer([{ id: 1 }], 'cursor-2') })
  // Scrolling starts page two of "a"...
  act(() => ui.get().loadMore())
  assert.equal(server.pending.length, 2)
  // ...and the search changes while it is loading.
  ui.type('ab')
  assert.equal(server.pending.length, 3)
  // The superseded page-two answer arrives; it must neither show nor free the
  // guard while "ab" is still loading.
  await act(async () => { server.pending[1].answer([{ id: 'stale' }], 'cursor-3') })
  assert.equal(ui.get().items, null, 'still loading the new search')
  act(() => ui.get().loadMore())
  assert.equal(server.pending.length, 3, 'no load-more against a list being replaced')
  await act(async () => { server.pending[2].answer([{ id: 'ab-1' }]) })
  assert.deepEqual(ui.get().items.map((x) => x.id), ['ab-1'])
  ui.unmount()
})

test('load more still refuses to run twice at once', async () => {
  const server = fakeServer()
  const ui = mount(server, 'x')
  await act(async () => { server.pending[0].answer([{ id: 1 }], 'c2') })
  act(() => { ui.get().loadMore(); ui.get().loadMore() })
  assert.equal(server.pending.length, 2)
  await act(async () => { server.pending[1].answer([{ id: 2 }]) })
  assert.deepEqual(ui.get().items.map((x) => x.id), [1, 2])
  ui.unmount()
})
