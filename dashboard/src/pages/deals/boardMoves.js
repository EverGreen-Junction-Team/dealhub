// boardMoves.js — the Deals board's moves in flight.
//
// What a column shows while the server catches up.
//
// Reported from a screen recording: a deal dragged into "Sales Qualified"
// left its old column and never arrived — the new column still read "No
// deals here" until the page was reloaded. Two causes, both fixed here:
//
//   1. The board refreshed the target column by the deal's real stage id,
//      but a merged column (All pipelines) is registered under the JOINED
//      list of ids. The lookup missed, so the target never refetched.
//   2. Even refetched, it can be too early. A stage change is written to
//      GHL and our copy follows when GHL's webhook lands (api/deals.js says
//      why) — a second or two, sometimes more. A refetch before then
//      returns the deal in its OLD stage.
//
// So the move is shown at once and held: `pending` (dealId → { deal,
// column, from }) overlays every column's server rows — the deal is hidden
// wherever else it appears and shown at the top of the column it was
// dropped on — until that column's own server rows contain it.
export function applyPending(serverDeals, pending, columnId) {
  const list = serverDeals || []
  if (!pending || !pending.size) return { deals: list, countDelta: 0, valueDelta: 0 }
  const here = new Set(list.map((d) => d.id))
  let countDelta = 0
  let valueDelta = 0
  const kept = list.filter((d) => {
    const p = pending.get(d.id)
    if (!p || p.column === columnId) return true
    countDelta -= 1
    valueDelta -= Number(d.monetaryValue) || 0
    return false
  })
  const incoming = []
  for (const p of pending.values()) {
    if (p.column !== columnId || here.has(p.deal.id)) continue
    incoming.push(p.deal)
    countDelta += 1
    valueDelta += Number(p.deal.monetaryValue) || 0
  }
  return { deals: [...incoming, ...kept], countDelta, valueDelta }
}
