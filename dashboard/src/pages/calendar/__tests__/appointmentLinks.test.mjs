// Linking a booking to a deal and to custom object records.
//
// Pinned by source because the behaviour lives in wiring: a menu item that
// is not threaded through one of the grids is a dead menu item, and a deal
// picker that searches the whole location lets a rep link a stranger's deal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const card = read('../AppointmentCard.jsx')
const links = read('../AppointmentLinks.jsx')
const tab = read('../../tabs/CalendarTab.jsx')
const timeGrid = read('../TimeGrid.jsx')
const board = read('../ResourceBoard.jsx')
const api = read('../../../api/appointments.js')

test('the card menu offers links first, and never on blocked time', () => {
  assert.match(card, /if \(!isBlocked && onOpenLinks\) \{/)
  assert.match(card, /'Link a deal or record…'/)
  assert.ok(card.indexOf("key: 'links'") < card.indexOf('menuActions.push(...statusActions)'))
})

test('the links act on the WHOLE booking, not a multi-day piece', () => {
  assert.match(card, /onClick: \(\) => onOpenLinks\(whole\)/)
})

test('both grids pass the handler through to the card', () => {
  for (const src of [timeGrid, board]) {
    assert.match(src, /onSetStatus, onOpenLinks, onBookAt/)
    assert.match(src, /onOpenLinks=\{onOpenLinks\}/)
  }
  assert.equal((tab.match(/onOpenLinks=\{setLinksFor\}/g) || []).length, 2)
})

test("the deal picker searches only this customer's deals", () => {
  assert.match(links, /searchDeals\(q, \{ contactId \}\)/)
})

test('records load when the dialog opens, never on hover', () => {
  assert.match(links, /useEffect\(\(\) => \{ loadRecords\(\) \}, \[loadRecords\]\)/)
  assert.ok(!/appointmentsAPI\.records/.test(read('../AppointmentDetail.jsx')))
})

test('the dialog says where a record link lands — on the customer', () => {
  assert.match(links, /so it also shows on their contact/)
})

test('a hand-made deal can be handed back to the automatic link', () => {
  assert.match(links, /saveDeal\(\{ mode: 'auto' \}\)/)
  assert.match(api, /setDeal: \(id, body\) => apiClient\.put\(`\/api\/appointments\/\$\{enc\(id\)\}\/deal`, body\)/)
})

test('a saved deal shows at once, then reloads', () => {
  assert.match(tab, /const handleDealSaved = useCallback/)
  assert.match(tab, /dealPinned: true,/)
})
