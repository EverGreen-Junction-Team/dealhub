import React, { useCallback, useEffect, useRef, useState } from 'react'
import { businessesAPI } from '../../api/businesses'
import { formatMoney } from '../../utils/money'
import { DealPill, RecordPill, relativeTime, formatDate } from '../shared/ListChrome'
import { ColumnsMenu } from '../shared/MenuChip'
import { useOpenSet, useLazy, ExpandChip, ExpandRow, ExpandGroup, ExpandItem, ExpandNote, MoreItem } from '../shared/RowExpand'
import { tasksAPI } from '../../api/tasks'

// The businesses as a LIST — the Figma Businesses List view (Oct 2026):
//
//   6 businesses                                     [Columns · 10 of 10]
//   ☐ NAME | TYPE | LOCATION | CONTACTS | WEBSITE | OWNER | TASKS | NOTES |
//     DEALS · PIPELINE | LAST ACTIVITY
//   ☐ [HR] Harborview Retail… | Commercial | Manchester, UK | [👤 1 contact ▾] | …
//
// The same chips and Columns menu as the Deals List (shared/MenuChip).
// Type, Owner, Tasks and Notes have no API yet: their columns are drawn and
// read "—", and fill in when the list endpoint sends type / owner /
// openTaskCount / noteCount. The Contacts and Deals menus read the business's
// detail the first time one is opened.

const COLUMNS = [
  { key: 'type', label: 'Type' },
  { key: 'location', label: 'Location' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'website', label: 'Website' },
  { key: 'owner', label: 'Owner' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'notes', label: 'Notes' },
  { key: 'deals', label: 'Deals · pipeline' },
  { key: 'activity', label: 'Last activity' }
]
const HIDDEN_KEY = 'pp.businesses.listHiddenColumns'

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
  verticalAlign: 'middle',
  whiteSpace: 'nowrap'
}
const DASH = <span style={{ color: 'var(--text-faint)' }}>—</span>

function readHidden() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}

// "Harborview Retail Fit-Out" → "HR". One word → its first two letters.
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// The business's contacts and deals, fetched the first time either menu
// opens — and once for both, since one detail read carries the two.
function useDetailOnOpen(id) {
  const [state, setState] = useState({ data: null, error: null })
  const started = useRef(false)
  const load = useCallback(() => {
    if (started.current) return
    started.current = true
    businessesAPI.get(id)
      .then((d) => setState({ data: { contacts: d?.contacts || [], deals: d?.deals || [] }, error: null }))
      .catch((e) => setState({ data: null, error: e.message || 'Could not load' }))
  }, [id])
  return [state, load]
}

// The website, with "…. ✎" to add one in place when it is empty — the only
// cell the design edits inline.
function WebsiteCell({ business: b, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const save = async () => {
    const next = draft.trim()
    if (!next) { setEditing(false); setError(null); return }
    setSaving(true)
    setError(null)
    try {
      await businessesAPI.update(b.id, { website: next })
      setEditing(false)
      onSaved && onSaved({ website: next })
    } catch (e) {
      setError(e.message || 'Could not save that')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <span style={{ display: 'grid', gap: 2 }} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') { setEditing(false); setError(null) }
          }}
          onBlur={() => { if (!saving) save() }}
          disabled={saving}
          placeholder="www.example.com"
          aria-label="Website"
          style={{
            width: 170, height: 28, padding: '0 8px',
            border: `1px solid ${error ? 'var(--status-stuck)' : 'var(--brand-primary)'}`,
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', outline: 'none'
          }}
        />
        {error && <span role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)' }}>{error}</span>}
      </span>
    )
  }
  if (b.website) {
    return (
      <span title={b.website} style={{ display: 'inline-block', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {b.website}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setDraft(''); setEditing(true) }}
      title="Add a website"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0,
        border: 'none', background: 'none', cursor: 'pointer',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-faint)'
      }}
    >
      ….
      <span className="ms" style={{ fontSize: 15, color: 'var(--text-muted)' }}>edit</span>
    </button>
  )
}

function Row({ business: b, hidden, onOpen, onOpenContact, onOpenDeal, onSaved }) {
  const [{ data, error }, load] = useDetailOnOpen(b.id)
  const show = (k) => !hidden.has(k)
  const location = [b.city, b.country].filter(Boolean).join(', ')
  const contacts = b.contactCount || 0
  const dealCount = b.dealCount || 0
  // OPEN pipeline when the API sends it; until then every deal's value.
  const pipeline = b.openPipelineValue ?? b.totalValue

  // THE ROW EXPANDS IN PLACE (the October list design — see RowExpand).
  // Contacts, tasks, notes and deals each toggle a group in a full-width row
  // under the business. Contacts and deals come from one detail read, made
  // the first time either opens; tasks from the task list's business filter.
  const [open, toggle] = useOpenSet()
  const fetchTasks = useCallback(
    () => tasksAPI.list({ businessId: b.id, status: 'open', limit: 5 })
      // A server without the filter ignores it and returns the whole
      // account's tasks — it echoes businessId only when it applied it.
      .then((r) => (r?.businessId === b.id ? (r.tasks || []) : 'unsupported')),
    [b.id]
  )
  const [taskState, loadTasks] = useLazy(fetchTasks)
  const openGroup = (kind) => {
    if (kind === 'contacts' || kind === 'deals') load()
    if (kind === 'tasks') loadTasks()
    toggle(kind)
  }
  const pending = !data && !error ? <ExpandNote>Loading…</ExpandNote> : null
  const failed = error ? <ExpandNote danger>{error}</ExpandNote> : null

  return (
    <>
    <tr
      onClick={onOpen}
      style={{ cursor: 'pointer', background: 'var(--surface-card)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-25)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-card)' }}
    >
      <td style={{ ...TD, maxWidth: 240 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, flex: 'none',
            borderRadius: 'var(--radius-sm)', background: 'var(--tint-plum)',
            fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--accent-plum-text)'
          }}>
            {initials(b.name)}
          </span>
          <span title={b.name} style={{
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            fontWeight: 600,
            color: b.hasName ? 'var(--accent-plum-text)' : 'var(--text-faint)',
            fontStyle: b.hasName ? 'normal' : 'italic'
          }}>
            {b.name}
          </span>
        </span>
      </td>
      {show('type') && <td style={TD}>{b.type || DASH}</td>}
      {show('location') && <td style={TD}>{location || DASH}</td>}
      {show('contacts') && (
        <td style={TD}>
          <ExpandChip
            icon="group"
            tone={contacts ? 'contact' : 'muted'}
            label={contacts ? plural(contacts, 'contact', 'contacts') : 'No contacts'}
            open={open.has('contacts')}
            onToggle={() => openGroup('contacts')}
          />
        </td>
      )}
      {show('website') && <td style={TD}><WebsiteCell business={b} onSaved={onSaved} /></td>}
      {show('owner') && <td style={TD}>{b.owner || DASH}</td>}
      {/* The design's chips, "No tasks ▾" / "No notes ▾" included. Until the
          list endpoint sends openTaskCount / noteCount there is no count, and
          the grey chip stands in; its menu points to the business page, where
          the Tasks panel lists them. */}
      {show('tasks') && (
        <td style={TD}>
          <ExpandChip
            icon="task_alt"
            tone={b.openTaskCount ? 'tasks' : 'muted'}
            label={b.openTaskCount ? plural(b.openTaskCount, 'task', 'tasks') : 'No tasks'}
            open={open.has('tasks')}
            onToggle={() => openGroup('tasks')}
          />
        </td>
      )}
      {show('notes') && (
        <td style={TD}>
          <ExpandChip
            icon="sticky_note_2"
            tone={b.noteCount ? 'notes' : 'muted'}
            label={b.noteCount ? plural(b.noteCount, 'note', 'notes') : 'No notes'}
            open={open.has('notes')}
            onToggle={() => openGroup('notes')}
          />
        </td>
      )}
      {show('deals') && (
        <td style={TD}>
          <ExpandChip
            icon="sell"
            tone={dealCount ? 'deals' : 'muted'}
            label={dealCount ? `${dealCount} · ${formatMoney(pipeline || 0)}` : 'No deals'}
            title={dealCount && b.openPipelineValue == null ? 'Value of every deal on this business, including closed ones' : undefined}
            open={open.has('deals')}
            onToggle={() => openGroup('deals')}
          />
        </td>
      )}
      {show('activity') && (
        <td style={{ ...TD, borderRight: 'none' }}>
          {(() => {
            const t = relativeTime(b.lastActivityAt)
            return t ? t.charAt(0).toUpperCase() + t.slice(1) : DASH
          })()}
        </td>
      )}
    </tr>

    {open.size > 0 && (
      <ExpandRow>
        {/* Fixed order, the design's: who, what is owed, what was written,
            the money. */}
        {open.has('contacts') && (
          <ExpandGroup>
            {pending}{failed}
            {data && data.contacts.length === 0 && <ExpandNote>No contacts are linked to this business yet.</ExpandNote>}
            {data && data.contacts.map((c) => (
              <ExpandItem
                key={c.id}
                icon="person" iconColour="var(--accent-sky)"
                name={c.name}
                a={c.email || DASH}
                b={c.phone || DASH}
                view={<RecordPill kind="CONTACT" name={c.name} onClick={onOpenContact ? () => onOpenContact(c.id) : undefined} />}
              />
            ))}
          </ExpandGroup>
        )}
        {open.has('tasks') && (
          <ExpandGroup>
            {taskState.items === null && !taskState.error && <ExpandNote>Loading…</ExpandNote>}
            {taskState.error && <ExpandNote danger>{taskState.error}</ExpandNote>}
            {taskState.items === 'unsupported' && (
              <MoreItem label="Open the business to see its tasks" onClick={onOpen} />
            )}
            {Array.isArray(taskState.items) && taskState.items.length === 0 && <ExpandNote>No open tasks.</ExpandNote>}
            {Array.isArray(taskState.items) && taskState.items.map((t) => {
              const overdue = t.dueAt && new Date(t.dueAt) < new Date()
              return (
                <ExpandItem
                  key={t.id}
                  icon="task_alt" iconColour="var(--accent-clay)"
                  name={t.title || 'Untitled task'}
                  a={t.dueAt
                    ? <span style={{ color: overdue ? 'var(--status-stuck-text)' : undefined }}>{formatDate(t.dueAt, false)}{overdue ? ' (overdue)' : ''}</span>
                    : DASH}
                  // The business page's Tasks panel is where they are worked.
                  view={<RecordPill kind="TASK" name={t.title} onClick={onOpen} />}
                />
              )
            })}
            {Array.isArray(taskState.items) && (b.openTaskCount || 0) > taskState.items.length && (
              <MoreItem label={`+${b.openTaskCount - taskState.items.length} more — open the business`} onClick={onOpen} />
            )}
          </ExpandGroup>
        )}
        {open.has('notes') && (
          <ExpandGroup>
            {/* No business-wide note list exists yet — notes hang off each
                contact and deal. */}
            <ExpandNote>Notes are kept on each contact and deal.</ExpandNote>
            <MoreItem label="Open the business" onClick={onOpen} />
          </ExpandGroup>
        )}
        {open.has('deals') && (
          <ExpandGroup>
            {pending}{failed}
            {data && data.deals.length === 0 && <ExpandNote>No deals at this business yet.</ExpandNote>}
            {data && data.deals.map((d) => (
              <ExpandItem
                key={d.id}
                icon="sell" iconColour="var(--green-600)"
                name={d.name}
                a={d.value ? <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-heading)' }}>{formatMoney(d.value)}</span> : DASH}
                b={d.stage || DASH}
                view={<DealPill compact name={d.name} onClick={onOpenDeal ? () => onOpenDeal(d.id) : undefined} />}
              />
            ))}
          </ExpandGroup>
        )}
      </ExpandRow>
    )}
    </>
  )
}

export default function BusinessList({
  items = [],
  onOpen, onOpenContact, onOpenDeal, onSaved
}) {
  const [hidden, setHidden] = useState(readHidden)
  useEffect(() => {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])) } catch { /* private mode */ }
  }, [hidden])

  const visible = COLUMNS.filter((c) => !hidden.has(c.key))

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
          {plural(items.length, 'business', 'businesses')}
        </span>
        <span style={{ marginLeft: 'auto' }}>
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

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)' }}>
          <thead>
            <tr>
              {/* No selection column — businesses have no bulk actions, so
                  the checkboxes were removed (Oct 2026, client request). */}
              <th style={TH}>Name</th>
              {visible.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <Row
                key={b.id}
                business={b}
                hidden={hidden}
                onOpen={() => onOpen(b.id)}
                onOpenContact={onOpenContact}
                onOpenDeal={onOpenDeal}
                onSaved={(patch) => onSaved(b.id, patch)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
