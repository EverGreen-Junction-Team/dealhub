import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The segmented controls, and the two-scope rule they depend on.
//
// These options were reported as too light twice. The first fix was
// contrast — real, measured, and not what was being reported. Contrast is
// not weight: at 400, at this size, under the app's 85% zoom, a label is
// thin before it is pale.
//
// The scope half of this matters more than the weight half. Tokens and
// overrides in this file apply to [data-dealhub] (the app tree) and
// .pp-portal (anything createPortal puts on <body>). A rule carrying only
// one does nothing at all for the other half, silently — it has already
// cost this app its Material Symbols icons in portals and an entire
// text-size setting.

const CSS = readFileSync(new URL('../styles/dealhub-tokens.css', import.meta.url), 'utf8')
const THEME = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')

test('segmented labels are heavier than regular', () => {
  assert.match(CSS, /\.ant-segmented-item-label\s*\{[^}]*font-weight: var\(--weight-medium\)/,
    'the unselected options are back at 400')
})

test('the selected option still wins', () => {
  // It has a white pill and a darker colour already; the weight step has
  // to stay a full step or selection stops being obvious at a glance.
  assert.match(
    CSS,
    /\.ant-segmented-item-selected \.ant-segmented-item-label\s*\{[^}]*font-weight: var\(--weight-semibold\)/,
    'the selected option is no longer heavier than the rest'
  )
})

test('both segmented rules carry BOTH scopes', () => {
  // The failure this guards is silent: the rule works everywhere you
  // happen to look and does nothing in portals.
  const blocks = CSS.split('}').filter((b) => b.includes('.ant-segmented-item-label'))
  assert.ok(blocks.length >= 2, 'the segmented rules are gone')
  for (const b of blocks) {
    assert.ok(b.includes('[data-dealhub]'), `rule missing [data-dealhub]: ${b.trim().slice(0, 60)}`)
    assert.ok(b.includes('.pp-portal'), `rule missing .pp-portal: ${b.trim().slice(0, 60)}`)
  }
})

test('the weights it names are actually defined, in that same scope', () => {
  // var(--weight-medium) resolves to nothing if the token lives under a
  // selector the control never matches.
  const tokenBlock = CSS.slice(CSS.indexOf('[data-dealhub],'), CSS.indexOf('--space-8'))
  for (const t of ['--weight-medium', '--weight-semibold']) {
    assert.ok(tokenBlock.includes(t), `${t} is not defined in the [data-dealhub]/.pp-portal block`)
  }
})

test('the contrast fix is still there too — weight replaces nothing', () => {
  // antd draws unselected options at colorTextLabel, ~3.98:1 on the track.
  // The weight change does not make that acceptable again.
  assert.match(THEME, /itemColor: '#676f7c'/, 'the segmented contrast fix was dropped')
})
