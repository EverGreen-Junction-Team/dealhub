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

// MERGED COLUMNS — the board is ONE grid, whatever the pipeline picker says.
//
// It used to render a separate full-height board per pipeline when no single
// one was chosen. Eight pipelines meant eight grids, each with its own
// horizontal scrollbar, almost all of them reading "No deals here" — the
// board stopped being a board.
//
// Stage NAMES repeat across pipelines: every pipeline here has its own
// "Quote Sent", each with a different stage_id. So the columns are keyed by
// name and a column asks for every id that shares it (the list form of
// stageId, added in routes/deals.js for exactly this). One grid, one scroll,
// and picking a pipeline narrows the same grid instead of changing its shape.
export function mergeStages(pipelines) {
  const byName = new Map()
  for (const p of pipelines) {
    for (const st of p.stages || []) {
      const key = (st.name || '').trim().toLowerCase()
      if (!key) continue
      if (!byName.has(key)) {
        byName.set(key, { name: st.name, ids: [], byPipeline: new Map(), position: st.position ?? 0 })
      }
      const slot = byName.get(key)
      slot.ids.push(st.id)
      slot.byPipeline.set(p.id, st.id)
      // The earliest position any pipeline gives this stage. Pipelines order
      // their shared stages the same way in practice, and taking the minimum
      // keeps a stage that is 3rd in one and 4th in another from jumping.
      slot.position = Math.min(slot.position, st.position ?? 0)
    }
  }
  return [...byName.values()]
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    // `id` is what Column keys and registers reloaders by; the joined list is
    // also exactly what the query sends, so the two cannot drift.
    .map((s) => ({
      id: s.ids.join(','),
      name: s.name,
      position: s.position,
      // pipelineId -> the stage id this column means in THAT pipeline. A drop
      // writes one real stage id, never the joined list.
      //
      // NO FALLBACK FOR A KNOWN PIPELINE. This used to fall back to the
      // column's only id whenever the deal's pipeline had no stage of this
      // name — so with All pipelines, a deal dropped on a stage only ANOTHER
      // pipeline has was sent that pipeline's stage, and the server refused
      // it: "That stage belongs to a different pipeline than this deal". The
      // single-id fallback is for a deal whose pipeline we do not know.
      stageIdFor: (pipelineId) => (pipelineId
        ? (s.byPipeline.get(pipelineId) || null)
        : (s.ids.length === 1 ? s.ids[0] : null))
    }))
}
