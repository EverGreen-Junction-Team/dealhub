// The contact record's panel order, asked for directly:
//
//   Details · Deals · All messages · Do not disturb · Custom fields
//
// It had been Details, Custom fields, Do not disturb, Deals, All messages.
// The new order reads as the order a rep works in — who they are, what they
// are buying, what has been said — with the two panels that are settings and
// reference last.
//
// Asserted on the SOURCE's render order: these are siblings in one JSX
// block, so their sequence in the file IS the sequence on screen, and no
// test of rendered output would be clearer about which moved.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../ContactDetail.jsx', import.meta.url), 'utf8')

const EXPECTED = ['Details', 'Deals', 'AllMessages', 'DoNotDisturb', 'CustomFields']

test('the panels render in the requested order', () => {
  const rendered = [...src.matchAll(/^ {6}<(Details|Deals|AllMessages|DoNotDisturb|CustomFields)\b/gm)]
    .map((m) => m[1])
  assert.deepEqual(rendered, EXPECTED)
})

test('every panel is still rendered exactly once', () => {
  // A reorder done by hand is one stray paste away from dropping or
  // duplicating a panel.
  for (const name of EXPECTED) {
    const hits = [...src.matchAll(new RegExp(`^ {6}<${name}\\b`, 'gm'))]
    assert.equal(hits.length, 1, `${name} should render exactly once`)
  }
})

test('the file header documents the order it actually renders', () => {
  // The header is a map of the page. Left stale it describes a layout that
  // no longer exists, which is worse than no map.
  const header = src.slice(0, src.indexOf('function labelFor'))
  const documented = EXPECTED.map((n) => (n === 'AllMessages' ? 'All messages' : n === 'DoNotDisturb' ? 'Do not disturb' : n === 'CustomFields' ? 'Custom fields' : n))
  let cursor = -1
  for (const label of documented) {
    const at = header.indexOf(label, cursor + 1)
    assert.ok(at > cursor, `header should list ${label} after the previous panel`)
    cursor = at
  }
})
