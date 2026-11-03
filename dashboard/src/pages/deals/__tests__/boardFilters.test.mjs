// The board must apply the SAME filters the toolbar above it shows.
//
// Reported as "tags not filtering on opportunities pipeline": a rep set
// Tag = "gone quiet", the count beside the heading read 0, and the columns
// underneath went on showing every deal. Two numbers on one screen
// contradicting each other.
//
// The cause was not the query. routes/deals.js has supported `tag` and
// `assignedTo` all along, and DealsTab's own count effect sends both — which
// is exactly why the count dropped to 0 while the board did not. The props
// simply never reached the columns.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const board = readFileSync(new URL('../DealBoard.jsx', import.meta.url), 'utf8')
const tab = readFileSync(new URL('../../tabs/DealsTab.jsx', import.meta.url), 'utf8')

test('a column sends the tag and owner filters with its query', () => {
  const load = board.slice(board.indexOf('const load = useCallback'), board.indexOf('useEffect(() => { load(null) })'))
  assert.match(load, /tag: tag \|\| undefined/)
  assert.match(load, /assignedTo: assignedTo \|\| undefined/)
})

test('a column refetches when either filter changes', () => {
  // Without these in the dependency list the first render would filter and
  // every later change would silently show stale rows — a worse bug than the
  // original, because it looks like it works.
  const deps = board.match(/\}, \[stage\.id, search, status[^\]]*\]\)/)
  assert.ok(deps, "the column's load callback should have a dependency list")
  assert.match(deps[0], /tag/)
  assert.match(deps[0], /assignedTo/)
})

test('both filters are threaded down the whole component chain', () => {
  // DealBoard -> PipelineBoard -> Column. A break at any level is invisible:
  // React passes undefined and the query just omits the filter.
  // Matched on the parameter LIST, not an exact signature: these components
  // gain props over time and a test that pins the full argument order fails
  // on an unrelated addition, which teaches people to edit the test rather
  // than read it.
  // Two levels now: DealBoard renders Column directly. PipelineBoard is gone
  // — it existed only to draw one grid per pipeline, which is the thing that
  // was replaced.
  for (const name of ['Column', 'DealBoard']) {
    const sig = board.match(new RegExp(`function ${name}\\(\\{([^}]*)\\}`))
    assert.ok(sig, `${name} should destructure its props`)
    assert.match(sig[1], /\btag\b/, `${name} should accept tag`)
    assert.match(sig[1], /\bassignedTo\b/, `${name} should accept assignedTo`)
  }
  // and actually passed, not just accepted
  assert.ok((board.match(/tag=\{tag\}/g) || []).length >= 1, 'tag must reach the column')
  assert.ok((board.match(/assignedTo=\{assignedTo\}/g) || []).length >= 1)
})

test('DealsTab gives the board the same filters it gives the count query', () => {
  // The count effect and the board must agree, or the heading contradicts
  // what is under it.
  assert.match(tab, /tag=\{filters\.tag \|\| undefined\}/)
  assert.match(tab, /assignedTo=\{filters\.assignedTo \|\| undefined\}/)
  assert.match(tab, /tag: filters\.tag \|\| undefined/)
  assert.match(tab, /assignedTo: filters\.assignedTo \|\| undefined/)
})

test('stage is still NOT passed to the board', () => {
  // The board's columns ARE the stages — a stageId would leave one column
  // populated and the rest empty. This is the one filter that must not pass.
  const call = tab.slice(tab.indexOf('<DealBoard'), tab.indexOf('onOpenDeal={setOpenDealId}'))
  assert.ok(!/stageId=/.test(call), 'a stage filter must not reach the board')
})

// ── ONE BOARD, EVERY PIPELINE ────────────────────────────────────────
// The board used to render a separate full-height grid PER pipeline when no
// single one was chosen: eight pipelines meant eight screens, each with its
// own scrollbar, almost all reading "No deals here".
//
// Now there is one grid. Stage names repeat across pipelines — every
// pipeline has its own "Quote Sent" with a different stage_id — so columns
// are keyed by NAME and each asks for every id sharing it.

const merge = (() => {
  const fn = board.slice(board.indexOf('function mergeStages'), board.indexOf('export default function DealBoard'))
  // eslint-disable-next-line no-new-func
  return new Function(`${fn}; return mergeStages`)()
})()

const PIPELINES = [
  { id: 'p_brad', name: 'Brad', stages: [
    { id: 's_b1', name: 'Marketing Qualified', position: 0 },
    { id: 's_b2', name: 'Quote Sent', position: 4 }] },
  { id: 'p_chris', name: 'Chris', stages: [
    { id: 's_c1', name: 'Marketing Qualified', position: 0 },
    { id: 's_c2', name: 'Quote Sent', position: 3 }] },
  { id: 'p_mkt', name: 'Marketing', stages: [
    { id: 's_m1', name: 'Marketing Qualified', position: 0 }] }
]

test('pipelines collapse into one set of columns, keyed by stage name', () => {
  const cols = merge(PIPELINES)
  assert.equal(cols.length, 2, 'three pipelines, two distinct stage names')
  assert.deepEqual(cols.map((c) => c.name), ['Marketing Qualified', 'Quote Sent'])
})

test('a merged column asks for every stage id that shares its name', () => {
  // The list form of stageId, which routes/deals.js gained for exactly this.
  const [first] = merge(PIPELINES)
  assert.equal(first.id, 's_b1,s_c1,s_m1')
})

test('a drop resolves to the stage id of the deal OWN pipeline', () => {
  // The column is one name backed by several ids. Sending the joined list as
  // a stage id would write nonsense to the CRM, and picking the first would
  // move the deal into another pipeline's stage.
  const [, quoteSent] = merge(PIPELINES)
  assert.equal(quoteSent.stageIdFor('p_brad'), 's_b2')
  assert.equal(quoteSent.stageIdFor('p_chris'), 's_c2')
  // A pipeline that does not have this stage at all has no answer, and the
  // drop is refused rather than guessed.
  assert.equal(quoteSent.stageIdFor('p_mkt'), null)
})

test('a single pipeline still yields its own plain stage ids', () => {
  assert.deepEqual(merge([PIPELINES[0]]).map((c) => c.id), ['s_b1', 's_b2'])
})

test('stage order is the earliest position any pipeline gives it', () => {
  // "Quote Sent" is 4th in one pipeline and 3rd in another; taking the
  // minimum stops a shared stage jumping around as pipelines are added.
  const [, quoteSent] = merge(PIPELINES)
  assert.equal(quoteSent.position, 3)
})

test('the deal pipeline travels with the drag', () => {
  // Without it the drop handler cannot resolve which stage id it means.
  assert.match(board, /setData\('text\/pipeline-id'/)
  assert.match(board, /getData\('text\/pipeline-id'\)/)
})

test('there is one scroll container, not one per pipeline', () => {
  // Counted inside DealBoard only. The pipeline strip above the board has its
  // own sideways scroll for its stage cells; that is one strip, not a grid
  // per pipeline, and is not what this guards.
  const main = board.slice(board.indexOf('export default function DealBoard'))
  assert.equal((main.match(/overflowX: 'auto'/g) || []).length, 1)
})
