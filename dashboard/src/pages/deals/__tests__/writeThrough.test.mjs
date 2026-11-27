// Deal changes show at once when the server has written them through.
//
// Reported as "deals page changes are not reflecting immediately". Every deal
// screen re-read the deal on a 2.5 s timer — a guess at GHL's webhook round
// trip — and showed the OLD deal whenever the webhook was slower. The server
// now writes GHL's copy into our database before it answers and says so with
// `mirrored: true` (server: services/dealWriteThrough.js), so the screens
// re-read at once and fall back to the wait only when it is false.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const api = read('../../../api/deals.js')
const hub = read('../../tabs/DealHubTab.jsx')
const tab = read('../../tabs/DealsTab.jsx')
const edit = read('../DealEditPanel.jsx')
const create = read('../DealCreatePanel.jsx')
const board = read('../DealBoard.jsx')

test('settleDelay: nothing when mirrored, the webhook wait when not', () => {
  // Evaluated from source: api/deals.js imports the HTTP client, which needs
  // the browser build.
  const body = api.slice(api.indexOf('export const WEBHOOK_WAIT_MS'), api.indexOf('export const dealsAPI'))
  const fn = new Function(`${body.replace(/export /g, '')}; return { WEBHOOK_WAIT_MS, settleDelay }`)()
  assert.equal(fn.settleDelay({ mirrored: true }), 0)
  assert.equal(fn.settleDelay({ mirrored: false }), fn.WEBHOOK_WAIT_MS)
  assert.equal(fn.settleDelay(undefined), fn.WEBHOOK_WAIT_MS)
  assert.ok(fn.WEBHOOK_WAIT_MS > 0)
})

test('the Deal hub re-reads on settleDelay, not a fixed 2.5 s', () => {
  // The custom-field reconcile and the stage/status/pipeline one. (Linking a
  // business or a person still waits: those land by relation webhooks, which
  // the deal write-through does not cover.)
  assert.equal((hub.match(/settleDelay\(res\)/g) || []).length, 2)
  // The status branch hands its response on, so its `mirrored` counts.
  assert.match(hub, /const r = await dealsAPI\.setStatus[\s\S]{0,200}res = r/)
})

test('the Deals tab refreshes a saved or created deal on settleDelay', () => {
  assert.match(tab, /const refreshDeal = useCallback\(\(id, result\)/)
  assert.match(tab, /settleDelay\(result\)\)/)
  assert.match(tab, /onSaved=\{\(result\) => refreshDeal\(openDealId, result\)\}/)
  assert.match(tab, /onCreated=\{\(_opp, result\)/)
})

test('the edit and create panels pass the write-through result up', () => {
  assert.match(edit, /onSaved\(\{ mirrored \}\)/)
  assert.match(edit, /track\(await dealsAPI\.update\(deal\.id, dealPatch\)\)/)
  assert.match(edit, /track\(await dealsAPI\.setStatus/)
  assert.match(create, /onCreated\(res\?\.opportunity \|\| null, \{ mirrored: !!res\?\.mirrored \}\)/)
})

test('the stage strip refetches after a change, the board included', () => {
  // It loaded once per filter change: a moved card left the strip wrong.
  assert.match(tab, /\}, \[boardPipelineId, filters, search, stripTick\]\)/)
  assert.match(tab, /onChanged=\{bumpStrip\}/)
  const move = board.slice(board.indexOf('const move = useCallback'), board.indexOf('// Every pipeline in scope'))
  assert.match(move, /onChanged\?\.\(\)/)
})
