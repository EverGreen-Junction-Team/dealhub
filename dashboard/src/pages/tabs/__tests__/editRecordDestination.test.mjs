// "Edit record" must open the DEAL'S OWN PAGE, not the Deals list.
//
// Reported: clicking it "just links to the 'deals' tab". It did carry the
// deal id, but seeded `editingId` — the state that expands a deal's row
// INLINE in the list. So the rep landed on the list with a row quietly open
// somewhere in it and had to go find it.
//
// `openDealId` is the full record page (DealEditPage), and it fetches the
// deal when the loaded page does not contain it — so it works for a deal the
// list has never shown.
//
// Asserted against the source: the destination is a choice of which state a
// prop seeds, which no test of rendered output would distinguish.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const deals   = read('../DealsTab.jsx')
const shell   = read('../../DealHubShell.jsx')
const section = read('../../dealhub/DealSection.jsx')
// The header band — and the Edit record button on it — live in the tab now.
const tab = read('../DealHubTab.jsx')

test('the hub request opens the record page, not an inline row', () => {
  assert.match(deals, /if \(initialEditDealId\) setOpenDealId\(initialEditDealId\)/)
  assert.ok(
    !/if \(initialEditDealId\) setEditingId\(initialEditDealId\)/.test(deals),
    'seeding editingId reopens the inline row in the list — the reported bug'
  )
})

test('openDealId is declared before the effect that seeds it', () => {
  // `const` is not hoisted, and this file has thrown a temporal-dead-zone
  // error on exactly this before.
  assert.ok(
    deals.indexOf("const [openDealId, setOpenDealId]") < deals.indexOf('if (initialEditDealId) setOpenDealId'),
    'the seeding effect must come after the declaration'
  )
})

test('the list edits in place through the grid card, not an expanding row', () => {
  // The old Cards view's expand-a-row editor was retired (Oct 2026) for the
  // Figma Grid view, whose fields edit in place with the Deal hub's pickers.
  // In-list editing must still exist — it just lives on the grid card now.
  assert.match(deals, /<DealGridCard/)
  assert.match(deals, /onSaveField=\{saveGridField\}/)
  assert.ok(!/expanded=\{editingId === d\.id\}/.test(deals), 'the retired inline row editor is back')
})

test('the request is still one-shot', () => {
  // Without this, navigating to Deals later for any other reason would
  // reopen the record of a deal the rep had finished with.
  assert.match(shell, /if \(to\.tab !== 'deals'\) setEditDealId\(null\)/)
})

test('the deal id still travels from the hub', () => {
  assert.match(shell, /onEditDealRecord=\{\(id\) => \{ setEditDealId\(id\); navigate\(\{ tab: 'deals' \}\) \}\}/)
  assert.match(deals, /initialEditDealId/)
})

test('the button comment no longer describes the old destination', () => {
  // A comment promising the list behaviour would send the next reader
  // looking for a bug that is not there.
  //
  // The button moved with the header band into DealHubTab — the card's
  // <section> is owned by the tab now, so that one wrapper can hold the
  // header, the toolbar and whichever rail is showing.
  assert.ok(!/editor already expanded/.test(tab))
  assert.match(tab, /OWN RECORD PAGE/)
})
