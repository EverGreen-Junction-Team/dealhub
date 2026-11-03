import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Select } from 'antd'
import DealBoard, { mergeStages } from '../deals/DealBoard'
import PipelineStrip from '../deals/PipelineStrip'
import DealList from '../deals/DealList'
import { useAuth } from '../../context/AuthContext'
import DealFilters from '../deals/DealFilters'
import { OwnerFilter } from '../shared/ListFilters'
import DealEditPage from '../deals/DealEditPage'
import ViewSwitch from '../shared/ViewSwitch'
import { savedViewsAPI } from '../../api/deals'
import { dealsAPI } from '../../api/deals'
import { usePagedList, useInfiniteScroll } from '../../hooks/usePagedList'
import { useTabState } from '../../hooks/useTabState'
import DealCreatePanel from '../deals/DealCreatePanel'
import DealGridCard from '../deals/DealGridCard'
import {
  Shell, SearchInput, StateMessage, DealCardsSkeleton, LoadMore, Panel
} from '../shared/ListChrome'

// Deals tab — one card per open deal, each showing the facts a rep scans for,
// the contacts on the deal, and an Edit expander.
//
// EDITING LIVES IN THE EXPANDER, not on the card face. The card used to carry
// four inline controls (value, expected close, stage, owner), of which two
// worked: the Stage picker offered only the deal's current stage because the
// list route sent no stage ids, and Owner was a read-only Input labelled
// "coming next".
//
// A rep scans this list far more often than they edit it, so the card is now
// read-only and the full field set — everything GHL's own edit modal offers —
// opens in place via DealEditPanel. That removed the half-working controls and
// made the rest actually saveable.

// The toolbar's sort choices. Only the keys the server's keyset cursor can
// anchor to — see DealTable — so every option sorts the whole list, not just
// the page that happens to be loaded.
const SORT_OPTIONS = [
  { value: 'recent', label: 'Last updated' },
  { value: 'created', label: 'Date created' },
  { value: 'value', label: 'Value' },
  { value: 'lastCustomerMessage', label: 'Last customer message' }
]

// A toolbar field with its label stacked ABOVE it, the Figma row's shape.
function ToolbarField({ label, children }) {
  return (
    // .pp-filter-field: the dropdown value and chevron weights — see the
    // rule in dealhub-tokens.css.
    <span className="pp-filter-field" style={{ display: 'inline-flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      {children}
    </span>
  )
}

export default function DealsTab({ onOpenDeal, onOpenContact, onOpenBusiness, onOpenTab, initialEditDealId = null }) {
  // Which view. Persisted because it is a working preference, not a
  // navigation step: a rep who works the board should not be handed the list
  // again every time they come back to this tab.
  //
  // 'cards' is the existing expandable list and stays the default — it is the
  // only view that can EDIT a deal inline, so demoting it would take a
  // capability away from anyone who does not switch back.
  const [view, setView] = useState(() => {
    try {
      const saved = localStorage.getItem('pp.deals.view') || 'board'
      // 'cards' was retired for the Grid view; a rep who left it on Cards
      // lands on its replacement rather than on a view that no longer exists.
      return saved === 'cards' ? 'grid' : saved
    } catch { return 'board' }
  })
  useEffect(() => {
    try { localStorage.setItem('pp.deals.view', view) } catch { /* private mode */ }
  }, [view])

  // The board needs one pipeline at a time — its columns ARE that pipeline's
  // stages. Defaults to the first, which is the only one most locations have.
  // Remembered across tab switches — see useTabState.
  //
  // `view` persists in localStorage (a preference that should outlive the
  // session), but the pipeline, filters and applied view are WHERE THE REP
  // WAS. They were plain state, so stepping out to the deal hub and back
  // reset the board to its default and threw away the filters they had set.
  const [boardPipelineId, setBoardPipelineId] = useTabState('deals', 'pipelineId', null)

  // The deal open as a full page. Null = the list.
  //
  // useTabState, not plain state: this is WHERE THE REP WAS. Opening a deal
  // from the table, stepping into the Deal Hub to read it and clicking back
  // used to return to the whole list with the deal to find again.
  const [openDealId, setOpenDealId] = useTabState('deals', 'openDealId', null)

  // "Edit record" on the Deal Hub card opens THIS DEAL'S OWN PAGE.
  //
  // It used to seed `editingId`, which expands the deal's row inline — so the
  // rep landed on the Deals LIST and had to find the row that had quietly
  // opened somewhere in it. The request names one deal; the honest
  // destination is that deal's record, which is what openDealId renders
  // (DealEditPage, below). It fetches the deal when it is not in the loaded
  // page, so this works for a deal the list has never shown.
  useEffect(() => {
    if (initialEditDealId) setOpenDealId(initialEditDealId)
    // Only when the hub actually asks; otherwise the remembered position
    // stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEditDealId])

  // How many deals the CURRENT pipeline and filters resolve to.
  //
  // Not deals.length: that is the loaded page (20 rows), and on the board it
  // is not even that — each column fetches its own stage, so the tab never
  // holds a full list. The server already counts under the same WHERE as the
  // page, so one request with limit:1 gets the real number.
  const [pipelineCount, setPipelineCount] = useState(null)
  // Per-stage { stageId, count, value, currency } for the pipeline strip,
  // from the same request as the count. Null until loaded, or on a server
  // that does not support ?summary=stages — the strip is then not shown.
  const [stageTotals, setStageTotals] = useState(null)

  // Live filters. The keys match GET /api/deals's query parameters exactly,
  // so applying a saved view is "spread these onto the request" rather than a
  // translation step that can drift.
  const [filters, setFilters] = useTabState('deals', 'filters', {})

  // Owner defaults to the signed-in user and the choice sticks — see the same
  // block in ContactsTab. Seeded once, and only if nothing was chosen, so a
  // rep who switches to All owners is not put back on their own deals.
  const { session } = useAuth()
  const ownerSeeded = useRef(false)
  useEffect(() => {
    if (ownerSeeded.current) return
    if (!session?.user?.id) return
    ownerSeeded.current = true
    if (filters.assignedTo === undefined) {
      setFilters({ ...filters, assignedTo: session.user.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])
  const [views, setViews] = useState([])
  const [activeViewId, setActiveViewId] = useTabState('deals', 'activeViewId', null)
  // The id of a saved view whose filters have since been EDITED. Not the same
  // as activeViewId: the view is still the one on screen, but what it shows no
  // longer matches what was saved — so the toolbar offers "Update <name>"
  // rather than only "Save view" under a new name.
  const [dirtyView, setDirtyView] = useTabState('deals', 'dirtyView', null)



  useEffect(() => {
    let alive = true
    savedViewsAPI.list('deals')
      .then((r) => { if (alive) setViews(r?.views || []) })
      // A failed fetch leaves the tab strip with just "All open deals", which
      // is still a working page — no banner for a feature nobody invoked.
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // The table's sort column and direction. useTabState for the same reason as
  // the filters: a rep who sorts by value, opens a deal and comes back should
  // not find the list silently reordered. 'recent' is the server's default.
  const [sort, setSort] = useTabState('deals', 'sort', 'recent')
  const [sortDir, setSortDir] = useTabState('deals', 'sortDir', 'desc')

  const [q, setQ] = useTabState('deals', 'q', '')
  // Server-side: filtering only the loaded page would hide matches further
  // down the list.
  const [search, setSearch] = useTabState('deals', 'search', '')

  // Search is stored in a saved view (see saveView), so committing new text
  // edits the applied view exactly as a filter change does.
  const commitSearch = useCallback(() => {
    const next = q.trim()
    if (next === search) return
    setSearch(next)
    setDirtyView(activeViewId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, search, activeViewId])




  // The create form, above the list. Mutually exclusive with an open editor —
  // two draft forms on screen is two things to lose.
  const [creating, setCreating] = useState(false)

  // Pipelines and users, fetched ONCE for the whole tab rather than per row.
  // They are location-wide and identical for every deal; fetching them in the
  // panel would be two requests every time a row is expanded.
  //
  // Lazy: the fetch runs when the first row is expanded, not on page load, so a
  // rep who only reads the list never pays for it.
  const [refData, setRefData] = useState(null)
  const [refError, setRefError] = useState(null)

  // The count, refetched whenever what it counts changes.
  //
  // Placed AFTER filters/search/boardPipelineId are declared — `const` is not
  // hoisted, and an effect reading them from above throws on first render.
  useEffect(() => {
    let alive = true
    // An empty picker means "all" in EVERY view now, board included — the
    // board stacks one section per pipeline rather than picking the first.
    // This count and the tab badge therefore agree instead of differing by
    // whatever the unshown pipelines held.
    const pipelineId = boardPipelineId || undefined
    dealsAPI.list({
      status: filters.status || 'open',
      q: search || undefined,
      stageId: filters.stageId || undefined,
      assignedTo: filters.assignedTo || undefined,
      tag: filters.tag || undefined,
      pipelineId,
      // One row, because only the count is wanted — totalCount is computed
      // under the same WHERE regardless of the page size.
      limit: 1,
      // And the per-stage counts and values for the pipeline strip, from the
      // same request — so the strip and the count beside the heading can
      // never disagree.
      summary: 'stages'
    })
      .then((r) => {
        if (!alive) return
        setPipelineCount(typeof r?.totalCount === 'number' ? r.totalCount : null)
        setStageTotals(Array.isArray(r?.stageTotals) ? r.stageTotals : null)
      })
      .catch(() => { if (alive) { setPipelineCount(null); setStageTotals(null) } })
    return () => { alive = false }
    // `view` and `refData` were dependencies only because the board used to
    // substitute the first pipeline here. It no longer does, so refetching the
    // count on a view switch would be a request that cannot change the answer.
  }, [boardPipelineId, filters, search])

  // The Stage field's options. With a pipeline chosen, its stages. With
  // "All pipelines", every stage — names repeat across pipelines ("Won" is
  // in most), so each is qualified; the id is what filters.
  const stageOptions = useMemo(() => {
    const all = refData?.pipelines || []
    const scoped = boardPipelineId ? all.filter((p) => p.id === boardPipelineId) : all
    return scoped.flatMap((p) => (p.stages || []).map((st) => ({
      value: st.id,
      label: scoped.length > 1 ? `${p.name} — ${st.name}` : st.name
    })))
  }, [refData, boardPipelineId])

  // The List view's stage groups: the board's merged columns for the
  // pipelines in scope. Not taken from `strip`, which waits on the server's
  // stage totals — the list must still draw its groups without them.
  const listStages = useMemo(() => {
    const all = refData?.pipelines || []
    const chosen = boardPipelineId ? all.filter((p) => p.id === boardPipelineId) : all
    return mergeStages(chosen)
  }, [refData, boardPipelineId])

  // The pipeline strip's columns and figures. Null until both the pipelines
  // and the stage totals have loaded, so the strip never flashes a row of
  // zeros that are really "not fetched yet".
  const strip = useMemo(() => {
    const all = refData?.pipelines || []
    if (!all.length || !stageTotals) return null
    const chosen = boardPipelineId ? all.filter((p) => p.id === boardPipelineId) : all
    if (!chosen.length) return null
    const byId = new Map(stageTotals.map((t) => [t.stageId, t]))
    const stages = mergeStages(chosen)
    const stats = {}
    for (const st of stages) {
      // A merged column's id is its stage ids joined — sum each of them. A
      // stage with no matching deals is absent from the totals: that is a
      // real zero, not a missing figure.
      let count = 0
      let value = 0
      let currency
      for (const id of st.id.split(',')) {
        const t = byId.get(id)
        if (!t) continue
        count += t.count
        value += t.value
        currency = currency || t.currency
      }
      stats[st.id] = { count, value, currency }
    }
    return {
      label: chosen.length === 1 ? chosen[0].name : 'All pipelines',
      stages,
      stats
    }
  }, [refData, stageTotals, boardPipelineId])

  // Saved-view actions.
  //
  // DECLARED HERE, not beside the view state above, because `const` is not
  // hoisted: applyView reads setQ/setSearch and saveView reads search and
  // setRefError, all of which are declared further down. Sitting above them
  // it threw "Cannot access 'g' before initialization" on first render — a
  // temporal dead zone error that both lint and the production build accept
  // without complaint.
  const applyView = useCallback((id) => {
    setActiveViewId(id)
    // Freshly applied: what is on screen IS what was saved.
    setDirtyView(null)
    const v = views.find((x) => x.id === id)
    const f = { ...(v?.filters || {}) }
    // `view` is NOT restored. It is the layout (board / table / cards), not a
    // filter, and forcing it threw a rep out of the view they were working in:
    // saving "Hot deals" from the board and later applying it from the table
    // snapped them back to the board. Old views still carry the key, so it is
    // deleted rather than trusted.
    delete f.view
    setFilters(f)
    if (f.q !== undefined) { setQ(f.q || ''); setSearch(f.q || '') }
    // setQ/setSearch are stable useState setters; React guarantees their
    // identity, and listing them would only add noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views])

  // `withFilters`: the Filters panel saves its DRAFT and applies it in the
  // same click, and `filters` here has not caught up yet — so it passes them.
  const saveView = useCallback(async (name, withFilters) => {
    try {
      const r = await savedViewsAPI.save({
        name,
        // No `view`: a saved view is a set of FILTERS. The layout is a
        // per-rep preference that outlives any one view — see applyView.
        filters: { ...(withFilters || filters), ...(search ? { q: search } : {}) }
      })
      // Replace by id so re-saving a name updates its tab rather than adding
      // a second one — the server upserts, and the list must agree.
      setViews((prev) => {
        const rest = prev.filter((v) => v.id !== r.view.id)
        return [...rest, r.view]
      })
      setActiveViewId(r.view.id)
      setDirtyView(null)
    } catch (e) {
      setRefError(e.message || 'That view could not be saved')
    }
  }, [filters, search])

  const deleteView = useCallback(async (id) => {
    try {
      await savedViewsAPI.remove(id)
      setViews((prev) => prev.filter((v) => v.id !== id))
      if (activeViewId === id) { setActiveViewId(null); setFilters({}) }
    } catch (e) {
      setRefError(e.message || 'That view could not be deleted')
    }
  }, [activeViewId])


  useEffect(() => {
    // Also when the create form opens — it needs the pipeline list to be
    // usable at all, since a pipeline is required.
    //
    // AND on the board, whose COLUMNS are a pipeline's stages: without this
    // the board rendered nothing at all, because refData stayed null until
    // someone opened an editor.
    // Always, now: the Filters control offers Stage and Owner in EVERY view,
    // and both lists live here. Gating this on the board left the table and
    // card views with a filter popover holding only Status.
    if (refData !== null) return
    let alive = true
    Promise.all([
      dealsAPI.pipelines().catch(() => null),
      dealsAPI.users().catch(() => null)
    ]).then(([p, u]) => {
      if (!alive) return
      // A failed reference fetch does not break the panel — the text fields
      // still save. Only the affected dropdown degrades, and it says why.
      if (!p && !u) setRefError('Could not load pipelines or users')
      setRefData({ pipelines: p?.pipelines || [], users: u?.users || [] })
    })
    return () => { alive = false }
  }, [refData])

  const fetchPage = useCallback(
    ({ cursor }) => dealsAPI.list({
      status: 'open', limit: 20, cursor, q: search || undefined,
      // The table and card views were ignoring the pipeline picker entirely —
      // it only ever reached the board. Empty means "all pipelines".
      pipelineId: boardPipelineId || undefined,
      // Sorting is the SERVER's job — the cursor is anchored to the sort
      // column, so a client-side reorder would only sort the page in hand.
      sort, dir: sortDir,
      // The saved view's filters, minus `view` (display mode, stripped when
      // the view is applied) and `q` (owned by the search box above).
      ...filters
    }),
    [search, filters, boardPipelineId, sort, sortDir]
  )
  // sort/sortDir are DEPS, not just fetch arguments: changing the sort changes
  // the cursor's anchor column, so page one must be refetched. Without them
  // the new sort would not apply until some other filter happened to change.
  const { items, error, hasMore, loadingMore, loading, loadMore, patchItem, reload } =
    usePagedList({ fetchPage, key: 'deals', deps: [search, filters, boardPipelineId, sort, sortDir] })

  // After a save: refetch THAT deal and patch it in place.
  //
  // Not reload() — that resets to page one, so a rep who had scrolled to deal
  // 60 would be thrown back to the top for editing one row.
  //
  // Delayed, because our writes go to GoHighLevel and nothing is written to our
  // database until the webhook lands. An immediate refetch returns the OLD row:
  // the same race that made the Deal Hub chips read "Not set" after a
  // successful save.
  const refreshDeal = useCallback((id) => {
    window.setTimeout(() => {
      dealsAPI.get(id)
        .then((fresh) => {
          if (!fresh) return
          patchItem((it) => it.id === id, fresh)
        })
        .catch(() => {})
    }, 2500)
  }, [patchItem])
  const sentinelRef = useInfiniteScroll(loadMore, { enabled: hasMore && !loadingMore })

  // GRID VIEW — the picklists for its five custom fields, fetched the first
  // time the grid is shown (the Deal hub loads the same endpoint the same
  // way). Until they arrive the rows show their values read-only.
  const [fieldOptions, setFieldOptions] = useState(null)
  useEffect(() => {
    if (view !== 'grid' || fieldOptions !== null) return
    let alive = true
    dealsAPI.customFieldOptions()
      .then((r) => { if (alive) setFieldOptions(r?.fields || {}) })
      .catch(() => { if (alive) setFieldOptions({}) })
    return () => { alive = false }
  }, [view, fieldOptions])

  // { dealId, key } while a card is saving, so only that row spins.
  const [gridSaving, setGridSaving] = useState(null)
  const [gridError, setGridError] = useState(null)

  // One save from a grid card, in the Deal hub's two shapes:
  //   customField → { customFields: [{ id, field_value }] }
  //   assignedTo  → { assignedTo }
  // Painted first and rolled back on failure, so a pick never waits ~700ms
  // on GHL to show — and a failed one never sits there looking saved.
  const saveGridField = useCallback(async (deal, field, value) => {
    const before = deal
    setGridError(null)
    try {
      if (field === 'customField') {
        setGridSaving({ dealId: deal.id, key: value.id })
        const text = (Array.isArray(value.value) ? value.value.join(', ') : value.value) || null
        if (value.dealKey) patchItem((x) => x.id === deal.id, { [value.dealKey]: text })
        await dealsAPI.update(deal.id, {
          customFields: [{ id: value.id, field_value: value.value }]
        })
      } else if (field === 'assignedTo') {
        setGridSaving({ dealId: deal.id, key: 'assignedTo' })
        const u = (refData?.users || []).find((x) => x.id === value)
        patchItem((x) => x.id === deal.id, { assignedTo: value || null, owner: u?.name || null })
        await dealsAPI.update(deal.id, { assignedTo: value || null })
      }
    } catch (e) {
      patchItem((x) => x.id === deal.id, before)
      setGridError(e.message || 'That change could not be saved')
    } finally {
      setGridSaving(null)
    }
  }, [patchItem, refData])


  const deals = items || []

  // The remembered deal, fetched by id when it is not on the loaded page.
  //
  // Returning to this tab re-fetches page one, so a deal the rep had open may
  // simply not be in `deals` — further down the list, or filtered out. The
  // render guard below needs the row itself, not just the id.
  const [fetchedDeal, setFetchedDeal] = useState(null)
  useEffect(() => {
    if (!openDealId) { setFetchedDeal(null); return }
    // Already on the page: no request needed, and the list copy is fresher.
    if (deals.some((d) => d.id === openDealId)) { setFetchedDeal(null); return }
    let alive = true
    dealsAPI.get(openDealId)
      .then((d) => { if (alive && d) setFetchedDeal(d) })
      // A deal that 404s (deleted elsewhere) drops us back to the list, which
      // is the right outcome — better than an empty editor.
      .catch(() => { if (alive) setOpenDealId(null) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDealId, deals])

  // The deal's own page REPLACES the list, the way ContactDetail replaces the
  // contacts list. Rendered before the Shell so the shell's tab strip, Back
  // button and location name all stay on screen — a full-screen overlay hid
  // them and left this page with no way out except its own header.
  const listedDeal = openDealId ? deals.find((d) => d.id === openDealId) : null
  const openDeal = listedDeal || fetchedDeal

  if (openDealId && openDeal) {
    // The editor keeps a cap. It is a FORM, and a row of inputs stretched
    // across a 2400px screen is unreadable — unlike the lists, which are
    // scanned in rows and want the width.
    return (
      <Shell maxWidth={1240}>
        <DealEditPage
          deal={openDeal}
          pipelines={refData?.pipelines || null}
          users={refData?.users || null}
          refError={refError}
          onOpenContact={onOpenContact}
          onClose={() => setOpenDealId(null)}
          onSaved={() => refreshDeal(openDealId)}
          onDeleted={() => { setOpenDealId(null); reload() }}
          // Deliberately does NOT clear openDealId: the rep is stepping out to
          // read this deal in the hub and expects to come back to it, not to
          // the list. Closing is the editor's own Close button.
          onOpenInHub={(id) => onOpenDeal(id)}
        />
      </Shell>
    )
  }

  return (
    // The BOARD gets the full width. A kanban is read across, and 1240px
    // centred left a third of a wide screen empty while the columns scrolled
    // sideways — the one layout where a reading-width cap is exactly wrong.
    // The paged views keep the cap: a table or a card list stretched to
    // 2400px is a line of text nobody can track back from.
    // Full width in EVERY view. The cap was kept for the table and the card
    // list on the reasoning that a very wide row is hard to track back from —
    // but a nine-column table squeezed into 1240px while a third of the screen
    // sits empty is the worse problem, and the table scrolls inside its own
    // box rather than stretching its type.
    <Shell maxWidth="none">
      {/* THE FIGMA HEADER: a solid green band with the title and count, then
          ONE grey row of labelled fields — Search, Pipeline, Stage, Owner,
          Sort — with Filters, the view switch and Add deal on the right.

          Tag, Status and the saved views moved into the Filters panel: the
          design has no room for them on the row, and they are reached for
          far less often than the five fields that are there. */}
      <Panel
        icon="sell"
        title="Deals"
        accent="pine"
        solidHeader
        count={pipelineCount}
        countTitle={
          pipelineCount != null ? `${pipelineCount} deals match these filters` : undefined
        }
        toolbarBackground="var(--gray-100)"
        toolbar={
          <div style={{
            flex: 1, minWidth: 0,
            display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap',
            gap: 'var(--space-3)'
          }}>
            <ToolbarField label="Search">
              <SearchInput
                value={q}
                onChange={setQ}
                // The search text is SAVED into a view (see saveView), so
                // committing new text edits the applied view the same way a
                // filter does — and only when it actually changed.
                onKeyDown={(e) => { if (e.key === 'Enter') commitSearch() }}
                onBlur={commitSearch}
                placeholder="Search deal, contact or business"
                width={320}
              />
            </ToolbarField>

            <ToolbarField label="Pipeline">
              {/* antd Select, not a native one: a browser renders <option>
                  with the OS's own menu, which cannot be styled or searched.
                  '' is a real choice — "all pipelines" — in every view. */}
              <Select
                aria-label="Pipeline"
                value={boardPipelineId ?? ''}
                onChange={(v) => {
                  setBoardPipelineId(v)
                  // A stage belongs to one pipeline. Switching away leaves
                  // a stage filter that can match nothing.
                  if (filters.stageId) {
                    setFilters((f) => { const next = { ...f }; delete next.stageId; return next })
                  }
                }}
                options={[
                  { value: '', label: 'All pipelines' },
                  ...(refData?.pipelines || []).map((p) => ({ value: p.id, label: p.name }))
                ]}
                popupClassName="pp-menu"
                popupMatchSelectWidth={false}
                style={{ width: 180 }}
                styles={{ root: { height: 36 } }}
              />
            </ToolbarField>

            <ToolbarField label="Stage">
              <Select
                aria-label="Stage"
                value={filters.stageId || ''}
                onChange={(v) => {
                  setFilters((f) => {
                    const next = { ...f }
                    if (v) next.stageId = v
                    else delete next.stageId
                    return next
                  })
                  setDirtyView(activeViewId)
                }}
                showSearch
                optionFilterProp="label"
                options={[{ value: '', label: 'All stages' }, ...stageOptions]}
                popupClassName="pp-menu"
                popupMatchSelectWidth={false}
                style={{ width: 170 }}
                styles={{ root: { height: 36 } }}
              />
            </ToolbarField>

            <ToolbarField label="Owner">
              <OwnerFilter
                bare
                value={filters.assignedTo ?? ''}
                onChange={(v) => {
                  setFilters({ ...filters, assignedTo: v || undefined })
                  setDirtyView(activeViewId)
                }}
              />
            </ToolbarField>

            <ToolbarField label="Sort">
              {/* Server-side, and only on the keys the cursor can anchor to —
                  see DealTable. Newest / largest first. */}
              <Select
                aria-label="Sort"
                value={sort}
                onChange={(v) => { setSort(v); setSortDir('desc') }}
                options={SORT_OPTIONS}
                popupClassName="pp-menu"
                popupMatchSelectWidth={false}
                style={{ width: 170 }}
                styles={{ root: { height: 36 } }}
              />
            </ToolbarField>

            {/* Display and create, pushed right — away from everything that
                changes WHICH deals are shown. */}
            <span style={{
              marginLeft: 'auto',
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)'
            }}>
              <DealFilters
                filters={filters}
                onChange={(next) => {
                  setFilters(next)
                  // EDITED, not abandoned: keeping the view's id is what lets
                  // the panel offer "Update <name>".
                  setDirtyView(activeViewId)
                }}
                views={views}
                activeViewId={activeViewId}
                dirtyViewId={dirtyView}
                onSelectView={applyView}
                onSaveView={saveView}
                onDeleteView={deleteView}
                onUpdateView={(id) => {
                  const v = views.find((x) => x.id === id)
                  if (v) saveView(v.name)
                }}
              />
              <ViewSwitch
                value={view}
                onChange={setView}
                options={[
                  { id: 'board', icon: 'view_kanban', label: 'Board' },
                  { id: 'grid', icon: 'grid_view', label: 'Grid' },
                  // Still the table under the hood; the Figma calls it List.
                  { id: 'table', icon: 'view_list', label: 'List' }
                ]}
              />
              <button
                onClick={() => setCreating(true)}
                disabled={creating}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  flex: 'none',
                  height: 36, padding: '0 15px',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  background: creating ? 'var(--gray-200)' : 'var(--brand-primary)',
                  color: creating ? 'var(--text-faint)' : '#fff',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
                  cursor: creating ? 'default' : 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 18 }}>add</span>
                Add deal
              </button>
            </span>
          </div>
        }
      >
      {/* EVERYTHING BELOW THE HEADER LIVES INSIDE IT, on one grey ground —
          the Figma frame. The strip and the views used to be separate boxes
          stacked under a header-only panel, each with its own border and a
          16px gap: the page read as four loose cards, not one panel. */}
      <div style={{
        display: 'grid', gap: 'var(--space-3)',
        // ONE COLUMN, NO WIDER THAN THE PANEL. An implicit `auto` column
        // grows to its widest child's content — and with every pipeline in
        // scope the strip and the board carry fifteen-odd stages, so it grew
        // past the screen and pushed the whole page sideways (the nav was cut
        // off on the left). minmax(0, 1fr) caps it; the strip and the board
        // each scroll sideways inside their own box instead.
        gridTemplateColumns: 'minmax(0, 1fr)',
        padding: 'var(--space-3)',
        background: 'var(--gray-100)',
        minWidth: 0
      }}>

      {creating && (
        <DealCreatePanel
          pipelines={refData?.pipelines || null}
          users={refData?.users || null}
          refError={refError}
          onClose={() => setCreating(false)}
          // A new deal is not in the loaded page, and it may not be on page one
          // either, so this is a full reload rather than a patch. The delay is
          // the webhook race: our POST goes to GHL and our row is written when
          // the webhook lands, so an immediate refetch would not include it.
          onCreated={() => {
            setCreating(false)
            window.setTimeout(() => reload(), 2500)
          }}
        />
      )}

      {/* PIPELINE VALUE, above every view. Its stages are the board's merged
          columns (one per stage NAME across the pipelines in scope), and
          each one's total sums every stage id that shares the name. */}
      {strip && !error && (
        <PipelineStrip label={strip.label} stages={strip.stages} stats={strip.stats} />
      )}

      {/* Cards, not rows — so the loading state mirrors the card shape
          rather than the generic row skeleton. */}
      {/* Card-shaped, so only for the card and table views. The board has its
          own "Loading pipeline…" and each column reports its own emptiness —
          three card skeletons above a board was the blank area with no
          explanation. */}
      {view === 'grid' && loading && <DealCardsSkeleton cards={3} />}

      {/* An ERROR is worth showing everywhere; an empty page only matters to
          the paged views, since a board with no deals says so per column. */}
      {(error || (view === 'grid' && !loading && deals.length === 0)) && (
        <div
          style={{
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            background: '#fff', overflow: 'hidden'
          }}
        >
          <StateMessage
            error={error}
            empty={!loading && deals.length === 0}
            emptyText={
              search
                ? 'No deals match — clear the search to see everything.'
                : 'No open deals in this sub-account.'
            }
          />
        </div>
      )}

      {/* BOARD — one pipeline's stages as columns. Each column fetches its own
          stage, so this deliberately does not read `deals` above. */}


      {/* The board waits on the PIPELINE list, not the deal page — its columns
          are stages. Without this it rendered an empty area with no
          explanation while that request was in flight. */}
      {view === 'board' && !error && refData === null && <BoardSkeleton />}

      {view === 'board' && !error && refData !== null
        && !(refData.pipelines || []).length && (
        <p style={{
          margin: 0, padding: 'var(--space-5)', textAlign: 'center',
          fontSize: 'var(--text-md)', color: 'var(--text-muted)'
        }}>
          {refError || 'No pipelines found in this sub-account.'}
        </p>
      )}

      {view === 'board' && !error && (refData?.pipelines || []).length > 0 && (
        <DealBoard
          // No pipeline chosen means ALL of them, stacked — not "the first
          // one". Silently narrowing to the first showed a rep one deal while
          // the tab badge beside it still read the true total, with nothing on
          // screen accounting for the difference.
          pipeline={(refData?.pipelines || []).find((p) => p.id === boardPipelineId) || null}
          pipelines={boardPipelineId ? null : (refData?.pipelines || [])}
          search={search}
          // The board's columns ARE the stages, so a stage filter would leave
          // one column populated and the rest empty — it is applied by the
          // board's own column scoping instead. Status does pass through.
          status={filters.status || 'open'}
          // Tag and Owner DO apply here, and were not being passed at all —
          // so the toolbar's two pickers did nothing on the board while the
          // count beside the heading (which does send them) dropped to 0.
          // The screen showed "Deals 0" above columns full of deals.
          tag={filters.tag || undefined}
          assignedTo={filters.assignedTo || undefined}
          sort={sort}
          dir={sortDir}
          // The toolbar's Stage narrows the board to that one column rather
          // than being sent as a filter — the columns ARE the stages.
          focusColumn={filters.stageId || undefined}
          // A card opens the deal's own page. It used to jump straight to the
          // deal hub, which is a different question — the hub is the record's
          // activity, this is the record itself. The hub is one button away
          // from there.
          onOpenDeal={setOpenDealId}
          // The card face opens the deal's page; this icon is the hub, the
          // same pairing the table rows use.
          onOpenInHub={onOpenDeal}
        />
      )}

      {/* LIST — the Figma List view: grouped by stage, each group loading
          its own deals like a board column, so it deliberately does not read
          the paged `deals` above. The id stays 'table' so a saved preference
          still lands here. */}
      {/* Its groups are stages, so it waits on the pipeline list. */}
      {view === 'table' && !error && refData === null && <DealCardsSkeleton cards={2} />}
      {view === 'table' && !error && listStages.length > 0 && (
        <DealList
          stages={listStages}
          stats={strip?.stats || null}
          search={search}
          status={filters.status || 'open'}
          tag={filters.tag || undefined}
          assignedTo={filters.assignedTo || undefined}
          sort={sort}
          dir={sortDir}
          focusStage={filters.stageId || undefined}
          // The row opens the deal's own page; the chips' menus carry the
          // ways to the hub, the contact and the business.
          onOpenDeal={setOpenDealId}
          onOpenInHub={onOpenDeal}
          onOpenContact={onOpenContact}
          onOpenBusiness={onOpenBusiness}
          onOpenTab={onOpenTab}
        />
      )}

      {/* GRID — the Figma card, three across. Replaces the old Cards view
          and its inline Edit form: each field edits in place here with the
          Deal hub's own pickers, and the deal's page still has every field. */}
      {view === 'grid' && !error && deals.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap: 'var(--space-3)',
          alignItems: 'start'
        }}>
          {deals.map((d) => (
            <DealGridCard
              key={d.id}
              deal={d}
              fieldOptions={fieldOptions}
              users={refData?.users || null}
              saving={gridSaving}
              onSaveField={saveGridField}
              onTagsChanged={(deal, next) => patchItem((x) => x.id === deal.id, { contactTags: next })}
              onOpenInHub={onOpenDeal}
              onOpenContact={onOpenContact}
              onOpenBusiness={onOpenBusiness}
            />
          ))}
        </div>
      )}
      {view === 'grid' && gridError && (
        <p role="alert" style={{
          margin: 0, padding: 'var(--space-2) var(--space-3)',
          background: 'var(--tint-rose)', border: '1px solid var(--status-stuck)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)'
        }}>
          {gridError}
        </p>
      )}

      {/* Not on the board: this paginates the card/table list, and each board
          column pages itself. Shown there it read as the board's own total —
          "5 deals — that's everything" under a board holding far more. */}
      {view === 'grid' && !loading && deals.length > 0 && (
        <LoadMore
          sentinelRef={sentinelRef}
          hasMore={hasMore}
          loadingMore={loadingMore}
          count={deals.length}
          noun="deal"
        />
      )}
      </div>
      </Panel>
    </Shell>
  )
}

// The board, while its pipeline loads.
//
// It was the words "Loading pipeline…" centred on an empty page — which says
// nothing about what is coming and leaves the viewport blank for as long as
// the request takes. Columns in outline hold the shape, so the real board
// arrives into the layout the rep is already looking at rather than replacing
// a paragraph of text.
function BoardSkeleton() {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', overflow: 'hidden' }}>
      {[0, 1, 2, 3].map((i) => (
        <section
          key={i}
          aria-hidden="true"
          style={{
            flex: 'none', width: 320,
            height: 'calc(100vh - 260px)', minHeight: 380,
            background: 'var(--gray-100)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden'
          }}
        >
          <div style={{
            padding: '12px 14px',
            background: 'var(--surface-card)',
            borderBottom: '2px solid var(--border-strong)',
            display: 'grid', gap: 6
          }}>
            <span className="pp-sk" style={{ height: 14, width: '62%' }} />
            <span className="pp-sk" style={{ height: 11, width: '34%' }} />
          </div>
          {/* Fewer placeholder cards in later columns: a board is rarely even,
              and four identical columns reads as a loading GRID rather than a
              pipeline. */}
          <div style={{ padding: 'var(--space-2)', display: 'grid', gap: 'var(--space-2)' }}>
            {Array.from({ length: Math.max(1, 3 - i) }).map((_, c) => (
              <div
                key={c}
                style={{
                  background: 'var(--surface-card)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  display: 'grid', gap: 8
                }}
              >
                <span className="pp-sk" style={{ height: 13, width: '72%' }} />
                <span className="pp-sk" style={{ height: 11, width: '48%' }} />
                <span className="pp-sk" style={{ height: 12, width: '36%' }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
