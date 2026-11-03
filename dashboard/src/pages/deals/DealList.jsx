import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { dealsAPI } from '../../api/deals'
import { tasksAPI } from '../../api/tasks'
import { notesAPI } from '../../api/notes'
import { formatMoney } from '../../utils/money'
import { RecordPill, relativeTime, formatDate } from '../shared/ListChrome'
import { MenuChip, MenuHeading, MenuNote, TOOL_BUTTON, ColumnsMenu, TagsChip } from '../shared/MenuChip'
import { contactsAPI } from '../../api/contacts'
import { useTags } from '../shared/ListFilters'
import { viewNoteInTab, viewTaskInTab } from '../shared/viewInTab'
import { useOpenSet, useLazy, ExpandChip, ExpandRow, ExpandGroup, ExpandItem, ExpandNote, MoreItem, noteLabel } from '../shared/RowExpand'

// The deals as a LIST, grouped by stage — the Figma List view (Oct 2026):
//
//   8 deals · £121,100 open                  [Collapse all] [Columns · 10 of 10]
//   ☐ DEAL | STAGE | VALUE | CONTACT | BUSINESS | OWNER | PRODUCT | TASKS | NOTES | UPDATED
//   ▾ Marketing Qualified (1)                                        TOTAL £9,750
//   ☐ 🏷 New Build Curtain Walling | … | [👤 Casey ▾] | [🏢 Cedarstone ▾] | …
//
// EACH STAGE GROUP LOADS ITS OWN DEALS, the way a board column does. One
// paged list sorted by "last updated" would scatter every page across every
// group, so the groups would grow and reshuffle as the rep scrolled. Per
// group, a stage shows its own deals and its own "Load more".
//
// The ▾ chips open a small menu with the detail behind them rather than
// navigating straight away — the row is for scanning, the menu for the one
// question ("which tasks?", "who else is on it?") before deciding to leave.

const PAGE = 25

// Every column but Deal can be hidden from the Columns menu.
const COLUMNS = [
  { key: 'stage', label: 'Stage' },
  { key: 'value', label: 'Value', align: 'right' },
  { key: 'contact', label: 'Contact' },
  { key: 'business', label: 'Business' },
  { key: 'owner', label: 'Owner' },
  { key: 'product', label: 'Product / details' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'notes', label: 'Notes' },
  // The contact's tags (editable) and the deal's own (locked), as one chip
  // like Tasks and Notes — the client asked for Deals and Contacts both.
  { key: 'tags', label: 'Tags' },
  { key: 'updated', label: 'Updated', align: 'right' }
]
const HIDDEN_KEY = 'pp.deals.listHiddenColumns'

const TH = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 'var(--text-sm)', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.05em',
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border-strong)',
  background: 'var(--gray-25)',
  whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 1
}
const TD = {
  padding: '9px 12px',
  fontSize: 'var(--text-md)',
  color: 'var(--text-body)',
  borderBottom: '1px solid var(--border-default)',
  borderRight: '1px solid var(--border-default)',
  verticalAlign: 'middle'
}

function readHidden() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}

const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function Row({ deal, hidden, selected, onToggleSelect, onOpenDeal, onOpenInHub, onOpenContact, onOpenBusiness, onOpenTab, catalogue, onPatch }) {
  // Tag writes go to the CONTACT (GHL's tags are contact-scoped): painted
  // first, rolled back if the CRM refuses.
  const contactTags = Array.isArray(deal.contactTags) ? deal.contactTags : []
  const writeTags = async (next, call) => {
    onPatch(deal.id, { contactTags: next })
    try { await call() } catch { onPatch(deal.id, { contactTags }) }
  }
  const name = deal.dealTag || deal.opportunityName || 'Untitled deal'
  const value = Number(deal.monetaryValue)
  const contactName = deal.contact
    ? `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim()
    : ''
  const businessName = deal.businessName || deal.contact?.business || ''
  const people = deal.people?.length ? deal.people : (deal.contact ? [{ ...deal.contact, primary: true }] : [])
  const show = (k) => !hidden.has(k)
  const faint = <span style={{ color: 'var(--text-faint)' }}>—</span>

  // THE ROW EXPANDS IN PLACE (the October list design — see RowExpand).
  // Contact, business, tasks and notes each toggle a group in a full-width
  // row under the deal; tasks and notes load the first time they open.
  const [open, toggle] = useOpenSet()
  const taskCount = deal.openTaskCount ?? 0
  const noteCount = deal.noteCount ?? 0
  const fetchTasks = useCallback(
    () => tasksAPI.list({ dealId: deal.id, status: 'open', limit: 5 }).then((r) => r?.tasks || []),
    [deal.id]
  )
  const fetchNotes = useCallback(
    () => notesAPI.list({ dealId: deal.id, limit: 5 }).then((r) => r?.notes || []),
    [deal.id]
  )
  const [taskState, loadTasks] = useLazy(fetchTasks)
  const [noteState, loadNotes] = useLazy(fetchNotes)
  const openGroup = (kind) => {
    if (kind === 'tasks') loadTasks()
    if (kind === 'notes') loadNotes()
    toggle(kind)
  }
  const toHub = onOpenInHub ? () => onOpenInHub(deal.id) : undefined

  return (
    <>
    <tr
      onClick={() => onOpenDeal && onOpenDeal(deal.id)}
      style={{ cursor: 'pointer', background: selected ? 'var(--tint-pine)' : 'var(--surface-card)' }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--gray-25)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? 'var(--tint-pine)' : 'var(--surface-card)' }}
    >
      <td style={{ ...TD, width: 44, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(deal.id)}
          aria-label={`Select ${name}`}
          style={{ width: 17, height: 17, accentColor: 'var(--brand-primary)', cursor: 'pointer' }}
        />
      </td>
      <td style={{ ...TD, minWidth: 200, maxWidth: 260 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, flex: 'none',
            borderRadius: 'var(--radius-sm)', background: 'var(--tint-pine)'
          }}>
            <span className="ms" style={{ fontSize: 17, color: 'var(--green-600)' }}>sell</span>
          </span>
          {/* Two lines, then an ellipsis: a deal name is what a rep reads down
              the column, and one line cut most of them off mid-word. */}
          <span title={name} style={{
            fontWeight: 600, color: 'var(--text-heading)', lineHeight: 1.3,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}>
            {name}
          </span>
        </span>
      </td>
      {show('stage') && (
        <td style={{ ...TD, maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={deal.stage || ''}>
          {deal.stage || faint}
        </td>
      )}
      {show('value') && (
        <td style={{
          ...TD, textAlign: 'right', whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: value > 0 ? 'var(--text-heading)' : 'var(--text-faint)'
        }}>
          {value > 0 ? formatMoney(value, deal.currency) : '—'}
        </td>
      )}
      {show('contact') && (
        <td style={TD}>
          {contactName ? (
            <ExpandChip
              icon="person"
              tone="contact"
              label={contactName}
              open={open.has('contact')}
              onToggle={() => openGroup('contact')}
            />
          ) : faint}
        </td>
      )}
      {show('business') && (
        <td style={TD}>
          {businessName ? (
            <ExpandChip
              icon="domain"
              tone="business"
              label={businessName}
              open={open.has('business')}
              onToggle={() => openGroup('business')}
            />
          ) : faint}
        </td>
      )}
      {show('owner') && (
        <td style={{ ...TD, maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={deal.owner || ''}>
          {deal.owner || <span style={{ color: 'var(--text-faint)' }}>Unassigned</span>}
        </td>
      )}
      {show('product') && (
        <td style={TD}>
          {deal.product ? (
            <MenuChip
              icon="category"
              label={deal.product}
              maxWidth={160}
              menu={
                <>
                  <MenuHeading>Product</MenuHeading>
                  <MenuNote>System: <b style={{ color: 'var(--text-heading)' }}>{deal.productSystem || 'Not set'}</b></MenuNote>
                  <MenuNote>Type: <b style={{ color: 'var(--text-heading)' }}>{deal.productType || 'Not set'}</b></MenuNote>
                </>
              }
            />
          ) : faint}
        </td>
      )}
      {show('tasks') && (
        <td style={TD}>
          <ExpandChip
            icon={taskCount ? 'task_alt' : 'error'}
            tone={taskCount ? 'tasks' : 'noTasks'}
            label={`${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`}
            title={taskCount ? `${taskCount} open ${taskCount === 1 ? 'task' : 'tasks'}` : 'No open tasks on this deal'}
            open={open.has('tasks')}
            onToggle={() => openGroup('tasks')}
          />
        </td>
      )}
      {show('notes') && (
        <td style={TD}>
          <ExpandChip
            icon="sticky_note_2"
            tone={noteCount ? 'notes' : 'muted'}
            label={`${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`}
            open={open.has('notes')}
            onToggle={() => openGroup('notes')}
          />
        </td>
      )}
      {show('tags') && (
        <td style={TD}>
          <TagsChip
            tags={contactTags}
            lockedTags={Array.isArray(deal.tags) ? deal.tags : []}
            catalogue={catalogue}
            // No contact, nothing to tag — the chip is read-only.
            onAdd={deal.contact?.id ? (tag) => writeTags([...contactTags, tag], () => contactsAPI.addTags(deal.contact.id, [tag])) : undefined}
            onRemove={deal.contact?.id ? (tag) => writeTags(contactTags.filter((t) => t !== tag), () => contactsAPI.removeTags(deal.contact.id, [tag])) : undefined}
          />
        </td>
      )}
      {show('updated') && (
        <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--text-body)', borderRight: 'none' }}>
          {capitalise(relativeTime(deal.updatedAt)) || '—'}
        </td>
      )}
    </tr>

    {open.size > 0 && (
      <ExpandRow>
        {/* Fixed order, the design's: who, where, what is owed, what was
            written — whatever was clicked first. */}
        {open.has('contact') && (
          <ExpandGroup>
            {people.map((p) => {
              const pn = `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.email || p.phone || 'Unnamed contact'
              return (
                <ExpandItem
                  key={p.id}
                  icon="person" iconColour="var(--accent-sky)"
                  name={p.primary && people.length > 1 ? `${pn} · Primary` : pn}
                  a={p.email || faint}
                  b={p.phone || faint}
                  view={<RecordPill kind="CONTACT" name={pn} onClick={onOpenContact ? () => onOpenContact(p.id) : undefined} />}
                />
              )
            })}
          </ExpandGroup>
        )}
        {open.has('business') && businessName && (
          <ExpandGroup>
            <ExpandItem
              icon="business" iconColour="var(--accent-plum)"
              name={businessName}
              // City and the business's deal count are not on the list's
              // payload yet.
              a={faint}
              b={faint}
              // Only a real business RECORD opens; the free-text company on
              // the contact has nowhere to go.
              view={<RecordPill kind="BUSINESS" name={businessName} onClick={onOpenBusiness && deal.businessId ? () => onOpenBusiness(deal.businessId) : undefined} />}
            />
          </ExpandGroup>
        )}
        {open.has('tasks') && (
          <ExpandGroup>
            {taskState.items === null && !taskState.error && <ExpandNote>Loading…</ExpandNote>}
            {taskState.error && <ExpandNote danger>{taskState.error}</ExpandNote>}
            {taskState.items && !taskState.error && taskState.items.length === 0 && <ExpandNote>No open tasks.</ExpandNote>}
            {(taskState.items || []).map((t) => {
              const overdue = t.dueAt && new Date(t.dueAt) < new Date()
              return (
                <ExpandItem
                  key={t.id}
                  icon="task_alt" iconColour="var(--accent-clay)"
                  name={t.title || 'Untitled task'}
                  a={t.dueAt
                    ? <span style={{ color: overdue ? 'var(--status-stuck-text)' : undefined }}>{formatDate(t.dueAt, false)}{overdue ? ' (overdue)' : ''}</span>
                    : faint}
                  view={<RecordPill kind="TASK" name={t.title} onClick={onOpenTab ? () => viewTaskInTab(onOpenTab, { dealId: deal.id }, t.id) : toHub} />}
                />
              )
            })}
            {taskState.items && taskCount > taskState.items.length && (
              <MoreItem label={`+${taskCount - taskState.items.length} more — open in Deal hub`} onClick={toHub} />
            )}
          </ExpandGroup>
        )}
        {open.has('notes') && (
          <ExpandGroup>
            {noteState.items === null && !noteState.error && <ExpandNote>Loading…</ExpandNote>}
            {noteState.error && <ExpandNote danger>{noteState.error}</ExpandNote>}
            {noteState.items && !noteState.error && noteState.items.length === 0 && <ExpandNote>No notes yet.</ExpandNote>}
            {(noteState.items || []).map((n) => (
              <ExpandItem
                key={n.id}
                icon="sticky_note_2" iconColour="var(--accent-brown)"
                name={noteLabel(n)}
                a={n.createdAt ? relativeTime(n.createdAt) : null}
                view={<RecordPill kind="NOTE" name={noteLabel(n)} onClick={onOpenTab ? () => viewNoteInTab(onOpenTab, { dealId: deal.id }, n.id) : toHub} />}
              />
            ))}
            {noteState.items && noteCount > noteState.items.length && (
              <MoreItem label={`+${noteCount - noteState.items.length} more — open in Deal hub`} onClick={toHub} />
            )}
          </ExpandGroup>
        )}
      </ExpandRow>
    )}
    </>
  )
}

// One stage: its header row and its deals. Owns its own fetch and paging.
function StageGroup({
  stage, colSpan, collapsed, onToggle, stats, query, hidden,
  selected, onToggleSelect, onLoaded, rowHandlers
}) {
  const [deals, setDeals] = useState([])
  // One row changed in place — a tag added or removed from its chip.
  const patchDeal = useCallback((id, p) => {
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, ...p } : d)))
  }, [])
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [total, setTotal] = useState(null)
  const [totalValue, setTotalValue] = useState(null)

  const load = useCallback(async (next = null) => {
    setLoading(true)
    setError(null)
    try {
      const r = await dealsAPI.list({
        stageId: stage.id,
        limit: PAGE,
        cursor: next || undefined,
        ...query
      })
      setDeals((prev) => (next ? [...prev, ...(r.deals || [])] : (r.deals || [])))
      setCursor(r.nextCursor || null)
      setHasMore(!!r.hasMore)
      if (typeof r.totalCount === 'number') setTotal(r.totalCount)
      if (typeof r.totalValue === 'number') setTotalValue(r.totalValue)
    } catch (e) {
      setError(e.message || 'Could not load this stage')
    } finally {
      setLoading(false)
    }
  // `query` is memoised by the caller; its identity changes only when a
  // filter does.
  }, [stage.id, query])

  useEffect(() => { load(null) }, [load])

  // The ids on screen, for the header's select-all.
  useEffect(() => { onLoaded(stage.id, deals.map((d) => d.id)) }, [onLoaded, stage.id, deals])

  const count = stats?.count ?? total ?? deals.length
  const value = stats?.value ?? totalValue ?? deals.reduce((n, d) => n + (Number(d.monetaryValue) || 0), 0)
  const currency = stats?.currency || deals[0]?.currency

  // A stage with nothing in it under these filters is not drawn. With every
  // pipeline in scope there are dozens of stages, and a header per empty one
  // buried the few that held deals.
  if (!loading && !error && count === 0) return null

  return (
    <tbody>
      <tr>
        <td colSpan={colSpan} style={{
          padding: 0, background: 'var(--gray-50)',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px' }}>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={collapsed ? `Expand ${stage.name}` : `Collapse ${stage.name}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: 0, border: 'none', background: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-sans)'
              }}
            >
              <span className="ms" style={{ fontSize: 20, color: 'var(--text-muted)' }}>
                {collapsed ? 'chevron_right' : 'expand_more'}
              </span>
              <span style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-heading)' }}>
                {stage.name}
              </span>
            </button>
            <span style={{
              minWidth: 20, height: 20, padding: '0 6px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-pill)', background: 'var(--gray-100)',
              fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)'
            }}>
              {count}
            </span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
              <span className="pp-label" style={{ marginBottom: 0 }}>Total</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)', fontWeight: 600,
                fontVariantNumeric: 'tabular-nums', color: 'var(--text-heading)'
              }}>
                {formatMoney(value || 0, currency)}
              </span>
            </span>
          </div>
        </td>
      </tr>

      {!collapsed && deals.map((d) => (
        <Row
          key={d.id}
          deal={d}
          hidden={hidden}
          selected={selected.has(d.id)}
          onToggleSelect={onToggleSelect}
          onPatch={patchDeal}
          {...rowHandlers}
        />
      ))}

      {!collapsed && (loading || error || hasMore) && (
        <tr>
          <td colSpan={colSpan} style={{
            padding: '8px 12px', textAlign: 'center',
            borderBottom: '1px solid var(--border-default)', background: 'var(--surface-card)'
          }}>
            {error ? (
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)' }}>{error}</span>
            ) : loading ? (
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>Loading…</span>
            ) : (
              <button
                type="button"
                onClick={() => load(cursor)}
                style={{
                  height: 28, padding: '0 12px',
                  border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-card)', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-body)'
                }}
              >
                Load more in {stage.name}
              </button>
            )}
          </td>
        </tr>
      )}
    </tbody>
  )
}

export default function DealList({
  // The board's merged columns: one per stage NAME in the pipelines in scope.
  stages = [],
  // stageId -> { count, value, currency } from ?summary=stages, or null.
  stats = null,
  // Filters, sent with every group's request.
  search, status = 'open', tag, assignedTo, sort, dir,
  // A stage id from the toolbar's Stage field — only its group is shown.
  focusStage,
  onOpenDeal, onOpenInHub, onOpenContact, onOpenBusiness, onOpenTab
}) {
  const [hidden, setHidden] = useState(readHidden)
  useEffect(() => {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])) } catch { /* private mode */ }
  }, [hidden])

  const [collapsed, setCollapsed] = useState(() => new Set())
  const [selected, setSelected] = useState(() => new Set())
  // stageId -> ids loaded in that group, for select-all.
  const [loadedIds, setLoadedIds] = useState({})
  const onLoaded = useCallback((id, ids) => {
    setLoadedIds((prev) => {
      const was = prev[id] || []
      if (was.length === ids.length && was.every((x, i) => x === ids[i])) return prev
      return { ...prev, [id]: ids }
    })
  }, [])

  // The stages to draw. One, if the toolbar picked one. And none the server's
  // totals already say are empty — they would render nothing anyway, and
  // skipping them saves a request per empty stage.
  const groups = useMemo(
    () => stages.filter((st) => (!focusStage || st.id.split(',').includes(focusStage))
      && !(stats && (stats[st.id]?.count ?? 0) === 0)),
    [stages, focusStage, stats]
  )

  const query = useMemo(() => ({
    status,
    q: search || undefined,
    tag: tag || undefined,
    assignedTo: assignedTo || undefined,
    sort: sort || undefined,
    dir: sort ? (dir || 'desc') : undefined
  }), [status, search, tag, assignedTo, sort, dir])

  const visibleCols = COLUMNS.filter((c) => !hidden.has(c.key))
  // Checkbox + Deal + the visible optional columns.
  const colSpan = 2 + visibleCols.length

  const allIds = groups.flatMap((g) => loadedIds[g.id] || [])
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
  const someSelected = !allSelected && allIds.some((id) => selected.has(id))

  const totals = stats
    ? groups.reduce((acc, g) => {
      const s = stats[g.id]
      if (s) { acc.count += s.count; acc.value += s.value; acc.currency = acc.currency || s.currency }
      return acc
    }, { count: 0, value: 0, currency: null })
    : null

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.id))

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  // The account's tag catalogue, for the Tags chip's add box. Cached and
  // shared with the Tag filter.
  const catalogue = useTags()
  const rowHandlers = { onOpenDeal, onOpenInHub, onOpenContact, onOpenBusiness, onOpenTab, catalogue }

  return (
    <section style={{
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden'
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
        padding: '10px 14px', borderBottom: '1px solid var(--border-default)'
      }}>
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-body)' }}>
          {totals
            ? `${totals.count} ${totals.count === 1 ? 'deal' : 'deals'} · ${formatMoney(totals.value, totals.currency)} ${status === 'all' ? '' : status}`.trim()
            : `${groups.length} ${groups.length === 1 ? 'stage' : 'stages'}`}
          {selected.size > 0 && (
            <span style={{ marginLeft: 10, fontWeight: 600, color: 'var(--green-600)' }}>
              {selected.size} selected
            </span>
          )}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--space-2)' }}>
          <button
            type="button"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.id)))}
            style={TOOL_BUTTON}
          >
            <span className="ms" style={{ fontSize: 17 }}>{allCollapsed ? 'unfold_more' : 'unfold_less'}</span>
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
          <ColumnsMenu
            columns={COLUMNS}
            hidden={hidden}
            onToggle={(key) => setHidden((prev) => {
              const next = new Set(prev)
              if (next.has(key)) next.delete(key); else next.add(key)
              return next
            })}
          />
        </span>
      </header>

      {/* Scrolls sideways inside its own box; the page must not. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)' }}>
          <thead>
            <tr>
              <th style={{ ...TH, width: 44, textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected }}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(allIds))}
                  aria-label="Select all deals shown"
                  style={{ width: 17, height: 17, accentColor: 'var(--brand-primary)', cursor: 'pointer' }}
                />
              </th>
              <th style={TH}>Deal</th>
              {visibleCols.map((c) => (
                <th key={c.key} style={{ ...TH, textAlign: c.align || 'left' }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <StageGroup
              key={g.id}
              stage={g}
              colSpan={colSpan}
              collapsed={collapsed.has(g.id)}
              onToggle={() => setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(g.id)) next.delete(g.id); else next.add(g.id)
                return next
              })}
              stats={stats ? (stats[g.id] || { count: 0, value: 0 }) : null}
              query={query}
              hidden={hidden}
              selected={selected}
              onToggleSelect={toggleSelect}
              onLoaded={onLoaded}
              rowHandlers={rowHandlers}
            />
          ))}
        </table>
      </div>
    </section>
  )
}
