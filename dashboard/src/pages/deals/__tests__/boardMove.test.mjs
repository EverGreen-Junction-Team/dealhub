// A deal dragged across the Deals board must arrive.
//
// Reported from a screen recording: with All pipelines showing, "Helen File"
// was dragged from Waiting on Details into Sales Qualified. It left its old
// column and never arrived — Sales Qualified still read "No deals here" (0)
// until the page was reloaded. The move HAD saved.
//
// Cause 1: the board refreshed the target by the deal's single stage id; a
// merged column is registered under the joined list, so the lookup missed.
// Cause 2: our copy of the deal only changes when GHL's webhook lands, so an
// immediate refetch can still return the old stage. Hence the overlay.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyPending } from '../boardMoves.js'

const board = readFileSync(new URL('../DealBoard.jsx', import.meta.url), 'utf8')

const helen = { id: 'd1', name: 'Helen File', monetaryValue: 1200 }
const jen = { id: 'd2', name: 'Jennifer Badham', monetaryValue: 300 }
const WAITING = 's-wait-a,s-wait-b'
const QUALIFIED = 's-qual-a,s-qual-b'
const moving = new Map([['d1', { deal: { ...helen, pipelineStageId: 's-qual-a' }, column: QUALIFIED, from: WAITING }]])

test('with no moves in flight a column shows exactly the server rows', () => {
  const r = applyPending([helen, jen], new Map(), WAITING)
  assert.deepEqual(r.deals.map((d) => d.id), ['d1', 'd2'])
  assert.equal(r.countDelta, 0)
  assert.equal(r.valueDelta, 0)
})

test('the column a deal left stops showing it at once, count and value with it', () => {
  // The server still has Helen in Waiting on Details — the webhook has not landed.
  const r = applyPending([helen, jen], moving, WAITING)
  assert.deepEqual(r.deals.map((d) => d.id), ['d2'])
  assert.equal(r.countDelta, -1)
  assert.equal(r.valueDelta, -1200)
})

test('the column it was dropped on shows it at once — the bug in the recording', () => {
  const r = applyPending([], moving, QUALIFIED)
  assert.deepEqual(r.deals.map((d) => d.name), ['Helen File'])
  assert.equal(r.deals[0].pipelineStageId, 's-qual-a')
  assert.equal(r.countDelta, 1)
  assert.equal(r.valueDelta, 1200)
})

test('once the server has it there, it is not drawn twice or counted twice', () => {
  const r = applyPending([helen], moving, QUALIFIED)
  assert.deepEqual(r.deals.map((d) => d.id), ['d1'])
  assert.equal(r.countDelta, 0)
})

test('other columns are untouched', () => {
  const r = applyPending([jen], moving, 's-quote')
  assert.deepEqual(r.deals.map((d) => d.id), ['d2'])
  assert.equal(r.countDelta, 0)
})

test('the board refreshes columns by their COLUMN id, not a single stage id', () => {
  const move = board.slice(board.indexOf('const move = useCallback'), board.indexOf('// Every pipeline in scope'))
  assert.match(move, /reload\(toColumn\)/)
  assert.match(move, /reload\(fromColumn\)/)
  // The old lookup by the real stage id is what missed merged columns.
  assert.doesNotMatch(move, /reloaders\.current\.get\(toStage/)
  assert.match(board, /registerReload\(stage\.id,/)
})

test('a drop names the column it landed on and the one real stage id', () => {
  const drop = board.slice(board.indexOf('onDrop={(e) => {'), board.indexOf('style={{', board.indexOf('onDrop={(e) => {')))
  assert.match(drop, /toColumn: stage\.id/)
  assert.match(drop, /toStageId: to \|\| null/)
  // Same column is compared as columns.
  assert.match(drop, /from === stage\.id/)
  // A pipeline with no such stage must not fall back to the joined id list.
  const code = drop.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /\?\? stage\.id/)
})

test('the move is held until the target column’s own rows contain the deal', () => {
  assert.match(board, /onConfirmed\(id, p\)/)
  assert.match(board, /applyPending\(serverDeals, pending, stage\.id\)/)
  // and a failed save puts the card back
  const move = board.slice(board.indexOf('const move = useCallback'), board.indexOf('// Every pipeline in scope'))
  assert.match(move, /catch \(e\) \{[\s\S]*dropPending\(dealId, entry\)/)
})

test('a column keeps only the newest answer — a fast search cannot settle on an older word', () => {
  const load = board.slice(board.indexOf('const load = useCallback'), board.indexOf('useEffect(() => { load(null) }'))
  assert.match(load, /const token = nextCursor \? latest\.current : \+\+latest\.current/)
  assert.match(load, /if \(token !== latest\.current\) return\n\s+setServerDeals/)
})

// "That stage belongs to a different pipeline than this deal" — reported from
// the board with All pipelines showing.
import { mergeStages } from '../boardMoves.js'

const PIPES = [
  { id: 'sales', stages: [{ id: 's-new', name: 'New lead', position: 0 }, { id: 's-qual', name: 'Sales Qualified', position: 1 }] },
  { id: 'remedial', stages: [{ id: 'r-new', name: 'New lead', position: 0 }, { id: 'r-book', name: 'Ready to book', position: 1 }] }
]
const col = (name) => mergeStages(PIPES).find((c) => c.name === name)

test('a stage only another pipeline has is never chosen for a deal', () => {
  // Only "sales" has Sales Qualified. A remedial deal dropped there used to
  // be sent s-qual, which GHL's pipeline check refuses.
  assert.equal(col('Sales Qualified').stageIdFor('remedial'), null)
  assert.equal(col('Ready to book').stageIdFor('sales'), null)
})

test('a deal gets its OWN pipeline\'s stage in a shared column', () => {
  assert.equal(col('New lead').stageIdFor('sales'), 's-new')
  assert.equal(col('New lead').stageIdFor('remedial'), 'r-new')
  assert.equal(col('Sales Qualified').stageIdFor('sales'), 's-qual')
})

test('only a deal with NO known pipeline falls back to a single-stage column', () => {
  assert.equal(col('Sales Qualified').stageIdFor(''), 's-qual')
  assert.equal(col('New lead').stageIdFor(''), null, 'two candidates: no guess')
})

test('while dragging, a column the deal cannot go into refuses the drop', () => {
  assert.match(board, /const blocked = dragPipeline !== null && !!stage\.stageIdFor && !stage\.stageIdFor\(dragPipeline\)/)
  assert.match(board, /if \(blocked\) \{ e\.dataTransfer\.dropEffect = 'none'; return \}/)
  assert.match(board, /opacity: blocked \? 0\.45 : 1/)
  assert.match(board, /onDragEnd=\{\(\) => onDragDeal\?\.\(null\)\}/)
})
