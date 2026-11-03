// The Insights tab: card data, chart adapters, and the contract between the
// client and the API.
//
// Ported from the InsightsHub prototype, which read Supabase from the browser
// with a service-role key and filtered on a brand decoded inside each view.
// Neither survived: the key would be a standing grant over every table, and
// the brand decode hardcoded four sub-accounts, so a fifth returned nothing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CHARTS } from '../charts.js'

const CARDS = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url), 'utf8'))
const ROUTE = readFileSync(
  new URL('../../../../../pipelinePulse/server/src/routes/insights.js', import.meta.url), 'utf8'
)

// ── The client/server contract ───────────────────────────────────────
// Both registries were derived from the prototype independently. A mismatch
// means a chart reads the wrong view — which draws a confident, wrong chart
// rather than failing, so nothing else would catch it.
const serverMap = (() => {
  const m = {}
  for (const [, k, v] of ROUTE.matchAll(/^\s+(c\w+): \[([^\]]*)\],/gm)) {
    m[k] = v.split(',').map((s) => s.trim().replace(/"/g, ''))
  }
  return m
})()

test('every chart the client knows, the server serves', () => {
  assert.deepEqual(Object.keys(CHARTS).sort(), Object.keys(serverMap).sort())
})

test('and they agree on which views feed each chart', () => {
  for (const k of Object.keys(CHARTS)) {
    assert.deepEqual(CHARTS[k].views, serverMap[k], `chart ${k} reads different views`)
  }
})

test('every view is one migration 135 creates', () => {
  const sql = readFileSync(
    new URL('../../../../../pipelinePulse/server/migrations/135_insight_views.sql', import.meta.url),
    'utf8'
  )
  for (const v of new Set(Object.values(CHARTS).flatMap((s) => s.views))) {
    assert.ok(
      new RegExp(`create or replace view public\\.${v}\\b`, 'i').test(sql),
      `${v} is read by a chart but not created by 135`
    )
  }
})

// ── The cards ────────────────────────────────────────────────────────
test('only live cards shipped — blocked insights are left out', () => {
  assert.equal(CARDS.length, 24)
  assert.ok(CARDS.every((c) => !c.not_ready), 'a not_ready card reached the build')
})

test('a chart key with no adapter is handled, not crashed on', () => {
  // Cards 3.6 and 9.4 name keys the prototype never wrote adapters for
  // (c36, c94a, c94b). They are live in the tracker, so the copy shipped,
  // but nothing turns their rows into bars. ChartBlock says so rather than
  // showing a failed fetch, which would send someone hunting a database
  // problem that does not exist.
  const unwired = []
  for (const c of CARDS) {
    for (const b of c.blocks || []) {
      if (b.kind === 'chart' && !CHARTS[b.key]) unwired.push(`${c.card_id}/${b.key}`)
    }
  }
  // 8.3/c83b is the gap the prototype's README names: 8.3's stored query only
  // covers the score distribution, so Part B was never recorded. The other
  // three are cards whose adapters were simply never written.
  assert.deepEqual(unwired.sort(), ['3.6/c36', '8.3/c83b', '9.4/c94a', '9.4/c94b'])

  const block = readFileSync(new URL('../ChartBlock.jsx', import.meta.url), 'utf8')
  assert.match(block, /if \(!CHARTS\[block\.key\]\)/)
  assert.match(block, /This chart is not built yet/)
})

test('the signed-off copy is carried, not paraphrased', () => {
  // The handoff is explicit that the wording is deliberate. These are the
  // fields a rewrite would quietly drop.
  const withCopy = CARDS.filter((c) => c.title && c.question)
  assert.ok(withCopy.length >= 20, 'most cards should carry title + question')
  assert.ok(CARDS.some((c) => c.footer?.learns && c.footer?.does), 'Learns/Does should survive')
})

// ── The adapters ─────────────────────────────────────────────────────
test('every adapter is pure and runs on empty input', () => {
  // A view returning no rows is an ANSWER (this account has none), not an
  // error — so an adapter must not throw on it.
  for (const [k, spec] of Object.entries(CHARTS)) {
    const empty = spec.views.map(() => [])
    assert.doesNotThrow(() => spec.build(empty), `${k} threw on empty rows`)
    assert.ok(Array.isArray(spec.build(empty)), `${k} did not return bars`)
  }
})

test('bar widths stay within the track', () => {
  const rows = CHARTS.c11.build([[
    { stage_name: 'Quote Sent', lost: 12, abandoned: 3 },
    { stage_name: 'Survey', lost: 4, abandoned: 9 }
  ]])
  for (const r of rows) {
    const total = r.segments.reduce((a, s) => a + s.widthPct, 0)
    assert.ok(total <= 100.5, `segments sum to ${total}%`)
  }
})

// ── The tenant boundary ──────────────────────────────────────────────
test('the location is never sent by the client', () => {
  // It comes from the session JWT server-side. A client-supplied location
  // would let anyone read another sub-account's figures.
  const api = readFileSync(new URL('../../../api/insights.js', import.meta.url), 'utf8')
  assert.ok(!/locationId/.test(api), 'the client must not send a location')
  assert.match(ROUTE, /const locationId = req\.locationId/)
  assert.match(ROUTE, /WHERE location_id = \$1/)
})
