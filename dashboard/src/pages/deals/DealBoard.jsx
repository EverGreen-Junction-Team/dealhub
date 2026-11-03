import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dealsAPI } from '../../api/deals'
import { formatMoney } from '../../utils/money'
import { Bar, SkeletonStyles, DealPill } from '../shared/ListChrome'
import { NotSet } from '../dealhub/FieldCard'

// The pipeline as a board: one column per stage, deals as cards.
//
// WHY EACH COLUMN FETCHES ITSELF. A pipeline can hold hundreds of deals and
// only a handful are on screen. Fetching everything and grouping client-side
// would mean holding the whole pipeline in memory to render one column, so
// each column asks for its own stage (`stageId`) and pages independently.
// The cost is N requests on load — N being the stage count, single digits in
// practice — which is cheaper than one request returning everything.
//
// DRAG AND DROP is the native HTML5 API, not a library. Moving a card between
// columns is the whole interaction: no sorting within a column, no nesting,
// no touch-drag requirement (the board is a desktop view). A drag library
// would be a dependency earning its keep on one gesture.

const PAGE = 25

// One labelled fact on a card: tinted label column with an icon, value beside
// it. The same shape as the Deal hub's field table at board density, so a card
// reads as a small version of the deal it opens.
function CardField({ icon, label, value, last }) {
  const empty = value == null || String(value).trim() === ''
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '108px minmax(0, 1fr)',
      borderBottom: last ? 'none' : '1px solid var(--border-default)'
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 10px', minWidth: 0,
        background: 'var(--gray-25)',
        borderRight: '1px solid var(--border-default)'
      }}>
        <span className="ms" style={{ fontSize: 15, color: 'var(--text-muted)', flex: 'none' }}>{icon}</span>
        <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      </span>
      <span style={{
        display: 'flex', alignItems: 'center',
        padding: '7px 10px', minWidth: 0
      }}>
        {/* Not set, not a dash: an unset product field is a gap in the deal
            worth fixing, and this is the chip the Deal hub uses for it. */}
        {empty
          ? <NotSet />
          : (
            <span title={String(value)} style={{
              fontSize: 'var(--text-md)', color: 'var(--text-body)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {value}
            </span>
          )}
      </span>
    </div>
  )
}

// Open tasks and notes on the deal, as one bordered group. ZERO OPEN TASKS is
// red: an open deal with nothing scheduled is the one a rep has forgotten.
function FollowUpCounts({ tasks, notes }) {
  const noTasks = tasks === 0
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      height: 30, minWidth: 0,
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)', background: 'var(--surface-card)',
      fontSize: 'var(--text-base)', color: 'var(--text-body)',
      whiteSpace: 'nowrap'
    }}>
      <span
        title={noTasks ? 'No open tasks on this deal' : undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px',
          color: noTasks ? 'var(--status-stuck-text)' : 'var(--text-body)',
          fontWeight: noTasks ? 600 : 400
        }}
      >
        <span className="ms" style={{ fontSize: 16 }}>{noTasks ? 'error' : 'task_alt'}</span>
        {tasks} {tasks === 1 ? 'task' : 'tasks'}
      </span>
      <span style={{ width: 1, height: 16, background: 'var(--border-strong)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px' }}>
        <span className="ms" style={{ fontSize: 16, color: 'var(--text-muted)' }}>sticky_note_2</span>
        {notes} {notes === 1 ? 'note' : 'notes'}
      </span>
    </span>
  )
}

// A card: title band, value and owner, the deal's four facts, then its
// follow-up counts beside the way into the hub.
function DealCard({ deal, onOpen, onOpenInHub, onDragStart, dragging }) {
  const value = Number(deal.monetaryValue)
  const name = deal.dealTag || deal.opportunityName || 'Untitled deal'
  const contact = deal.contact
    ? `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim()
    : ''
  return (
    <article
      draggable
      onDragStart={(e) => onDragStart(e, deal)}
      onClick={() => onOpen && onOpen(deal.id)}
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        cursor: 'grab',
        // The card being dragged fades rather than disappears: a gap where a
        // card was reads as "it moved already", which it has not yet.
        opacity: dragging ? 0.4 : 1,
        transition: 'box-shadow 120ms ease, opacity 120ms ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 6px rgba(0,0,0,0.08)'
      }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none' }}
    >
      {/* The title gets its own band: it is the one thing scanned down a
          column, and the rule under it separates "which deal" from "what
          about it". */}
      <h4 title={name} style={{
        margin: 0, padding: '12px 14px',
        borderBottom: '1px solid var(--border-default)',
        fontSize: 15, fontWeight: 600,
        color: 'var(--text-heading)', lineHeight: 1.3,
        letterSpacing: '-0.01em',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>
        {name}
      </h4>

      <div style={{ display: 'grid', gap: 10, padding: '12px 14px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 'var(--space-2)'
        }}>
          {/* A priced deal leads with its value; an unpriced one says so rather
              than printing £0, which reads as "worth nothing" instead of
              "not yet quoted". */}
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-lg)', fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: value > 0 ? 'var(--text-heading)' : 'var(--text-faint)'
          }}>
            {value > 0 ? formatMoney(value, deal.currency) : 'Not priced'}
          </span>
          {deal.owner && (
            <span
              title={`Owner: ${deal.owner}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
                fontSize: 'var(--text-base)', color: 'var(--text-muted)'
              }}
            >
              <span className="ms" style={{ fontSize: 16, flex: 'none' }}>account_circle</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                {deal.owner}
              </span>
            </span>
          )}
        </div>

        <div style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)', overflow: 'hidden'
        }}>
          <CardField icon="category" label="System" value={deal.productSystem} />
          <CardField icon="grid_view" label="Type" value={deal.productType} />
          <CardField icon="person" label="Contact" value={contact} />
          {/* The contact's business record, falling back to the free-text
              company GHL holds on the contact. */}
          <CardField
            icon="domain"
            label="Business"
            value={deal.businessName || deal.contact?.business}
            last
          />
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 'var(--space-2)'
        }}>
          <FollowUpCounts tasks={deal.openTaskCount ?? 0} notes={deal.noteCount ?? 0} />
          {/* The card body opens the deal's editor; this chip goes straight
              to the hub. The two drag guards are NOT optional: the card is
              draggable, and a button inside a draggable element starts its
              own drag on mousedown, which cancels the click. */}
          {onOpenInHub && (
            <DealPill
              compact
              name={name}
              onClick={(e) => {
                // Without this the card's own onClick fires underneath and the
                // rep lands in the editor they were trying to skip.
                e.stopPropagation()
                onOpenInHub(deal.id)
              }}
              draggable={false}
              onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
            />
          )}
        </div>
      </div>
    </article>
  )
}

// One stage. Owns its own deals, count and paging.
function Column({ stage, search, status, tag, assignedTo, sort, dir, onOpen, onOpenInHub, onMoved, registerReload }) {
  const [deals, setDeals] = useState([])
  const [total, setTotal] = useState(null)
  // The STAGE's value from the server (sum over every matching deal), not the
  // loaded page's. Null until the first load, or on a server that predates
  // totalValue — the header then falls back to the loaded sum, labelled.
  const [totalValue, setTotalValue] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [over, setOver] = useState(false)

  const load = useCallback(async (nextCursor = null) => {
    setLoading(true)
    setError(null)
    try {
      const r = await dealsAPI.list({
        stageId: stage.id,
        status,
        limit: PAGE,
        cursor: nextCursor || undefined,
        q: search || undefined,
        // TAG AND OWNER. Both were absent, so the toolbar's pickers did
        // nothing on the board: a rep set Tag to "gone quiet", the count
        // beside the heading dropped to 0 (that query DOES send them — see
        // DealsTab's pipelineCount effect), and the columns underneath went
        // on showing every deal. The two numbers on screen contradicted each
        // other and the filter looked broken because it was.
        //
        // The server has supported both all along (routes/deals.js) — they
        // simply never left the browser on this view.
        tag: tag || undefined,
        assignedTo: assignedTo || undefined,
        // The toolbar's Sort, so a column orders its cards the way the list
        // views do. Omitted means the server default (last updated).
        sort: sort || undefined,
        dir: sort ? (dir || 'desc') : undefined
      })
      setDeals((prev) => (nextCursor ? [...prev, ...(r.deals || [])] : (r.deals || [])))
      setCursor(r.nextCursor || null)
      setHasMore(!!r.hasMore)
      if (typeof r.totalCount === 'number') setTotal(r.totalCount)
      if (typeof r.totalValue === 'number') setTotalValue(r.totalValue)
    } catch (e) {
      setError(e.message || 'Could not load this stage')
    } finally {
      setLoading(false)
    }
  }, [stage.id, search, status, tag, assignedTo, sort, dir])

  useEffect(() => { load(null) }, [load])

  // The parent moves a card optimistically, then tells both affected columns
  // to refetch so the counts and totals come from the server rather than
  // being recomputed in two places.
  useEffect(() => registerReload(stage.id, () => load(null)), [registerReload, stage.id, load])

  // Column value: the sum of what is LOADED, labelled as such when more
  // remains. Printing a partial sum as if it were the stage total would be a
  // number a manager could act on and be wrong about.
  const loadedValue = useMemo(
    () => deals.reduce((n, d) => n + (Number(d.monetaryValue) || 0), 0),
    [deals]
  )
  // A partial sum only when the server gave no total AND more deals remain.
  const stageValue = totalValue ?? loadedValue
  const partial = totalValue == null && hasMore
  const currency = deals[0]?.currency


  return (
    <section
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const id = e.dataTransfer.getData('text/deal-id')
        const from = e.dataTransfer.getData('text/stage-id')
        const fromPipeline = e.dataTransfer.getData('text/pipeline-id')
        // WHICH stage id this column means for THIS deal. The column is one
        // merged stage name backed by several ids — one per pipeline — and
        // sending the joined list as a stage id would write nonsense to the
        // CRM. stageIdFor resolves it against the deal's own pipeline.
        const to = stage.stageIdFor?.(fromPipeline) ?? stage.id
        if (id && to && from !== to) onMoved(id, from, to)
      }}
      style={{
        // 360, not 320: the cards now carry a four-row field table, and at 320
        // its values truncated after a dozen characters.
        flex: 'none', width: 360,
        display: 'flex', flexDirection: 'column',
        // A fixed height, not maxHeight: every column ends at the same line
        // whether it holds ten cards or none, so the board reads as a grid.
        // Without it, an empty column collapsed to its header and the row of
        // headers sat at different depths.
        // A fixed height, not maxHeight: every column ends at the same line
        // whether it holds ten cards or none, so the board reads as a grid.
        // There is only ever ONE grid now — the pipelines are merged into it
        // — so this no longer multiplies into a screen per pipeline.
        height: 'calc(100vh - 260px)', minHeight: 380,
        // gray-100, not gray-50: against a white header and white cards, 50 is
        // a 1.02:1 difference — the header did not read as a header and the
        // cards floated with no visible column behind them.
        background: over ? 'var(--tint-pine)' : 'var(--gray-100)',
        border: `1px ${over ? 'dashed' : 'solid'} ${over ? 'var(--green-300)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        transition: 'background 120ms ease'
      }}
    >
      {/* Its own band, tinted pine like the design: the stage and its count
          on the left, the stage TOTAL in its own cell on the right. The
          total used to sit under the name in small grey text, where it read
          as a caption rather than the column's headline number. */}
      <header style={{
        flex: 'none',
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto',
        background: 'var(--tint-pine)',
        // A real edge, not a hairline: this is the line between "what stage
        // is this" and "which deals are in it".
        borderBottom: '1px solid var(--border-strong)'
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
          padding: '14px 14px'
        }}>
          <h3 title={stage.name} style={{
            margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600,
            color: 'var(--text-heading)', letterSpacing: '-0.01em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {stage.name}
          </h3>
          {/* A pill, not loose digits: it is a count of the column below it
              and needed a shape to say so. White on the pine band. */}
          <span style={{
            flex: 'none',
            minWidth: 22, height: 22, padding: '0 7px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-card)',
            fontSize: 'var(--text-base)', fontWeight: 600,
            fontVariantNumeric: 'tabular-nums', color: 'var(--text-body)'
          }}>
            {total ?? deals.length}
          </span>
        </div>
        <div
          title={partial ? 'Only the deals loaded so far — scroll to load the rest' : undefined}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
            justifyContent: 'center', gap: 2,
            padding: '8px 14px',
            borderLeft: '1px solid var(--border-strong)'
          }}
        >
          <span className="pp-label" style={{ marginBottom: 0 }}>
            {partial ? 'Loaded' : 'Total'}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-lg)', fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: stageValue > 0 ? 'var(--text-heading)' : 'var(--text-faint)'
          }}>
            {formatMoney(stageValue, currency)}
          </span>
        </div>
      </header>

      <div style={{
        flex: 1, overflowY: 'auto', minHeight: 80,
        padding: 'var(--space-2)', display: 'grid', gap: 'var(--space-2)',
        alignContent: 'start',
        // EVERY CARD AT ITS FULL HEIGHT; the column scrolls instead.
        //
        // Without this the rows are `auto` inside a fixed-height column, and
        // a card with overflow:hidden has a minimum height of zero — so when
        // a column held more cards than fit, the grid SHRANK each card to
        // share the height out, cutting them off after two field rows.
        gridAutoRows: 'max-content'
      }}>
        {error && (
          <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--status-stuck-text)' }}>
            {error}
          </p>
        )}
        {deals.map((d) => (
          <DealCard
            key={d.id}
            deal={d}
            onOpen={onOpen}
            onOpenInHub={onOpenInHub}
            dragging={false}
            onDragStart={(e, deal) => {
              e.dataTransfer.setData('text/deal-id', deal.id)
              e.dataTransfer.setData('text/stage-id', stage.id)
              // The deal's OWN pipeline. A merged column holds one stage id
              // per pipeline, so the drop target has to pick the right one —
              // and a deal dragged between columns stays in its pipeline.
              e.dataTransfer.setData('text/pipeline-id', deal.pipelineId || '')
              e.dataTransfer.effectAllowed = 'move'
            }}
          />
        ))}
        {/* An empty column is also a DROP TARGET, and the old state said
            nothing about that: one line of grey text pinned to the top of a
            600px void. A dashed outline is the same shape a card would take
            if one were dragged here, so the column reads as "put one here"
            rather than "broken".

            Vertically centred, not top-aligned — text at the top of a tall
            empty box looks like content that failed to load. */}
        {loading && (
          <div style={{ display: 'grid', gap: 8 }}>
            <SkeletonStyles />
            {[0, 1].map((i) => (
              <div
                key={i}
                style={{
                  display: 'grid', gap: 8,
                  padding: 'var(--space-3)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-card)'
                }}
              >
                <Bar w="70%" h={13} />
                <Bar w="45%" h={11} />
              </div>
            ))}
          </div>
        )}

        {!loading && !deals.length && !error && (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 8, minHeight: 140, padding: 'var(--space-4)',
            // Answers the drag too. The column already tints on hover, but
            // the placeholder inside it stayed grey — so the one element a
            // rep is aiming at was the one that did not react.
            border: `1px dashed ${over ? 'var(--green-300)' : 'var(--border-strong)'}`,
            borderRadius: 'var(--radius-md)',
            // A shade lighter than the column, so the outline reads as an
            // opening in it rather than another card.
            background: over ? 'transparent' : 'var(--gray-50)',
            transition: 'border-color 120ms ease'
          }}>
            <span className="ms" style={{
              fontSize: 26,
              color: over ? 'var(--green-600)' : 'var(--text-faint)'
            }}>
              {over ? 'move_down' : 'inbox'}
            </span>
            <p style={{
              margin: 0, textAlign: 'center',
              fontSize: 'var(--text-md)', fontWeight: 500,
              color: 'var(--text-muted)'
            }}>
              No deals here
            </p>
            <p style={{
              margin: 0, textAlign: 'center',
              fontSize: 'var(--text-base)', color: 'var(--text-faint)',
              lineHeight: 1.4
            }}>
              Drag a deal across to move it into {stage.name}
            </p>
          </div>
        )}
        {hasMore && (
          <button
            onClick={() => load(cursor)}
            disabled={loading}
            style={{
              height: 30, border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)', background: 'var(--surface-card)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
              color: 'var(--text-body)', cursor: 'pointer'
            }}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  )
}

// One pipeline's columns. Split out of DealBoard so the board can render
// several pipelines stacked when no single one is chosen — each keeps its own
// stage columns rather than merging stage lists, which would not be a board.
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
      stageIdFor: (pipelineId) => s.byPipeline.get(pipelineId) || (s.ids.length === 1 ? s.ids[0] : null)
    }))
}

export default function DealBoard({
  pipeline, pipelines, search, status = 'open', tag, assignedTo, onOpenDeal, onOpenInHub,
  sort, dir,
  // A stage id picked in the toolbar's Stage field. The board then shows only
  // the column that holds it — the rest would be columns of deals the filter
  // just excluded.
  focusColumn
}) {
  const [moveError, setMoveError] = useState(null)
  // stageId -> reload fn, so a move can refresh exactly the two columns it
  // touched rather than the whole board.
  const reloaders = useRef(new Map())

  const registerReload = useCallback((stageId, fn) => {
    reloaders.current.set(stageId, fn)
    return () => reloaders.current.delete(stageId)
  }, [])

  const move = useCallback(async (dealId, fromStage, toStage) => {
    setMoveError(null)
    try {
      await dealsAPI.update(dealId, { pipelineStageId: toStage })
      // Refetch BOTH columns rather than moving the card locally: the stage
      // change also updates the deal's timestamps and its position in the
      // sort, and a locally-inserted card would sit in the wrong place until
      // the next load.
      reloaders.current.get(fromStage)?.()
      reloaders.current.get(toStage)?.()
    } catch (e) {
      setMoveError(e.message || 'That deal could not be moved')
      // Put the card back where it was — the move did not happen.
      reloaders.current.get(fromStage)?.()
    }
  }, [])

  // Every pipeline in scope — the chosen one, or all of them — merged into
  // one set of columns. Built INSIDE the memo: a `list` computed outside is a
  // new array on every render, so the memo would recompute each time and
  // hand Column a new `stage` object, refetching the whole board on any
  // parent re-render.
  const stages = useMemo(
    () => mergeStages(
      Array.isArray(pipelines) && pipelines.length > 0
        ? pipelines
        : (pipeline ? [pipeline] : [])
    ),
    [pipelines, pipeline]
  )

  if (!stages.length) return null

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', minHeight: 0 }}>
      {moveError && (
        <p style={{
          margin: 0, padding: 'var(--space-2) var(--space-3)',
          background: 'var(--tint-rose)',
          border: '1px solid var(--status-stuck)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)'
        }}>
          {moveError}
        </p>
      )}
      {/* Horizontal scroll lives HERE, not on the page: the board is wider
          than the viewport by design and the rest of the page must not move
          sideways. ONE scrollbar now, not one per pipeline. */}
      <div style={{
        display: 'flex', gap: 'var(--space-3)',
        overflowX: 'auto', overflowY: 'hidden',
        paddingBottom: 'var(--space-2)',
        minHeight: 420
      }}>
        {stages.filter((st) => !focusColumn || st.id.split(',').includes(focusColumn)).map((st) => (
          <Column
            key={st.id}
            stage={st}
            search={search}
            status={status}
            tag={tag}
            assignedTo={assignedTo}
            sort={sort}
            dir={dir}
            onOpen={onOpenDeal}
            onOpenInHub={onOpenInHub}
            onMoved={move}
            registerReload={registerReload}
          />
        ))}
      </div>
    </div>
  )
}
