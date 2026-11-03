import React, { useEffect, useRef, useState } from 'react'
import { Truncate, relativeTime, formatDate, RecordPill, DealPill } from '../shared/ListChrome'
import BusinessPickerModal from '../shared/BusinessPickerModal'
import { contactsAPI } from '../../api/contacts'
import { TagsChip } from '../shared/MenuChip'
import { ExpandGroup, ExpandItem, ExpandNote, MoreItem, SmallIcon } from '../shared/RowExpand'

// The contacts list as a table — the October 2026 list design.
//
//   NAME · TYPE · EMAIL · PHONE · BUSINESS · ADDRESS · TAGS · TASKS · NOTES · DEALS
//
// Name opens the record. Business, address and tags are worked on in place,
// each writing straight to the CRM. Tasks, notes and deals are pills with a
// count; deals opens a menu of the contact's deals. Every column but Name can
// be hidden from the toolbar's Columns control — see CONTACT_COLUMNS.
//
// SORTING IS NOT HERE. The server orders by "recently updated" and pages with
// a keyset cursor anchored to that order, so a sort control could only
// reorder the page already loaded — which looks like sorting and is not.

// The hideable columns, in order. Name always shows — a row you cannot name
// is a row you cannot read.
export const CONTACT_COLUMNS = [
  { key: 'type', label: 'Type' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'business', label: 'Business' },
  { key: 'address', label: 'Address' },
  { key: 'tags', label: 'Tags' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'notes', label: 'Notes' },
  { key: 'deals', label: 'Deals' }
]

const TH = {
  textAlign: 'left',
  padding: '12px 14px',
  fontSize: 11, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.05em',
  color: '#4a515c',
  borderBottom: '1px solid var(--border-strong)',
  borderRight: '1px solid var(--border-default)',
  whiteSpace: 'nowrap',
  background: 'var(--surface-sunken)',
  // The header stays put while the body scrolls: a 20-row page is taller than
  // most screens and a column you cannot name is a column you cannot read.
  position: 'sticky', top: 0, zIndex: 1
}

const TD = {
  padding: '10px 14px',
  fontSize: 'var(--text-md)',
  color: 'var(--text-body)',
  borderBottom: '1px solid var(--border-default)',
  borderRight: '1px solid var(--border-default)',
  verticalAlign: 'middle'
}

const TYPE_LABEL = { lead: 'Lead', customer: 'Customer' }

const PILL_TONES = {
  // A contact with no open tasks is the one to chase — red, as the design has.
  tasksNone: { line: 'var(--status-stuck)', fg: 'var(--status-stuck-text)', icon: 'task_alt' },
  tasks: { line: 'var(--accent-clay)', fg: 'var(--accent-clay-text)', icon: 'task_alt' },
  notes: { line: 'var(--accent-brown)', fg: 'var(--accent-brown-text)', icon: 'sticky_note_2' },
  deals: { line: 'var(--green-500)', fg: 'var(--green-600)', icon: 'sell' },
  none: { line: 'var(--border-strong)', fg: 'var(--text-muted)' }
}

export default function ContactTable({
  contacts = [], columns, tagList = [],
  onOpen, onOpenDeal, onOpenBusiness, onPatch,
  // (contactId, note) — View on a note opens it in the Notes tab.
  onViewNote,
  // (contactId, task) — View on a task opens it in the Tasks tab.
  onViewTask,
  // Selection, for bulk actions — owned by the tab so the cards and the list
  // share one selection.
  selected = new Set(), onToggleSelected, onToggleAll
}) {
  if (!contacts.length) return null
  // undefined = every column; the toolbar hands an explicit list once a rep
  // has hidden one.
  const show = (key) => !columns || columns.includes(key)
  const allOn = contacts.every((c) => selected.has(c.id))
  const someOn = !allOn && contacts.some((c) => selected.has(c.id))

  return (
    // Scrolls sideways inside its own box — without this the page body scrolls
    // and the navigation goes with it.
    <div style={{
      width: '100%', overflowX: 'auto',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)'
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontFamily: 'var(--font-sans)'
      }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 44, textAlign: 'center' }}>
              <input
                type="checkbox"
                className="pp-check"
                checked={allOn}
                // Indeterminate when some, not all, are ticked — set on the
                // element, since React has no prop for it.
                ref={(el) => { if (el) el.indeterminate = someOn }}
                onChange={() => onToggleAll && onToggleAll(!allOn)}
                aria-label="Select every contact shown"
              />
            </th>
            <th style={TH}>Name</th>
            {CONTACT_COLUMNS.filter((col) => show(col.key)).map((col) => (
              <th key={col.key} style={TH}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <ContactRow
              key={c.id}
              c={c}
              show={show}
              tagList={tagList}
              onOpen={onOpen}
              onOpenDeal={onOpenDeal}
              onOpenBusiness={onOpenBusiness}
              onViewNote={onViewNote}
              onViewTask={onViewTask}
              onPatch={onPatch}
              selected={selected.has(c.id)}
              onToggleSelected={() => onToggleSelected && onToggleSelected(c.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ContactRow({
  c, show, tagList, onOpen, onOpenDeal, onOpenBusiness, onViewNote, onViewTask, onPatch, selected, onToggleSelected
}) {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState(null)
  const patch = (p) => onPatch && onPatch(c.id, p)
  const businessName = c.businessName || c.business || null
  const deals = c.deals || []
  const tasks = c.openTaskCount || 0
  const notes = c.noteCount || 0
  const hasTasks = tasks > 0 && Array.isArray(c.tasks) && c.tasks.length > 0
  const hasNotes = notes > 0 && Array.isArray(c.notes) && c.notes.length > 0
  // EMPTY PILLS EXPAND TOO (the design): "0 tasks ▾" opens a group saying
  // "No open tasks" rather than jumping to the record. Only a count the list
  // has no items for (an older server) still opens the record.
  const expandTasks = tasks === 0 || hasTasks
  const expandNotes = notes === 0 || hasNotes
  // Which pills have their group open under the row. Several at once.
  const [open, setOpen] = useState(() => new Set())
  const toggle = (kind) => setOpen((cur) => {
    const next = new Set(cur)
    if (next.has(kind)) next.delete(kind); else next.add(kind)
    return next
  })

  // A write from a cell: run it, patch the row on success, say why on failure.
  const write = async (call, onDone) => {
    setError(null)
    try {
      const res = await call()
      onDone(res)
    } catch (err) {
      setError(err?.message || 'Could not save that — try again')
    }
  }

  return (
    <>
      <tr
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-25)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      >
        <td style={{ ...TD, textAlign: 'center' }}>
          <input
            type="checkbox"
            className="pp-check"
            checked={!!selected}
            onChange={onToggleSelected}
            aria-label={`Select ${c.name || 'this contact'}`}
          />
        </td>
        <td style={{ ...TD, maxWidth: 260 }}>
          <button
            onClick={() => onOpen && onOpen(c.id)}
            title="Open the full contact record"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 10, maxWidth: '100%',
              border: 'none', background: 'none', padding: 0,
              fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left'
            }}
          >
            <Avatar name={c.name} />
            <Truncate style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-heading)' }}>
              {c.name || 'Unknown contact'}
            </Truncate>
          </button>
        </td>

        {show('type') && (
          <td style={{ ...TD, whiteSpace: 'nowrap' }}>
            {TYPE_LABEL[String(c.contactType || '').toLowerCase()] || c.contactType || <Faint>—</Faint>}
          </td>
        )}

        {show('email') && (
          <td style={{ ...TD, maxWidth: 200 }}>
            <Truncate style={{ display: 'block' }} title={c.email || undefined}>
              {c.email || <Faint>—</Faint>}
            </Truncate>
          </td>
        )}

        {show('phone') && (
          <td style={{ ...TD, whiteSpace: 'nowrap' }}>
            {c.phone || <Faint>—</Faint>}
          </td>
        )}

        {/* BUSINESS, TASKS, NOTES, DEALS — pills that EXPAND A SECTION UNDER
            THE ROW, the October design. They were floating dropdowns: one at
            a time, over the rows below. Now each pill toggles its own group
            in the row's expansion, several can be open at once, and each
            item carries a View pill to its record. */}
        {show('business') && (
          <td style={{ ...TD, maxWidth: 190 }}>
            {businessName && c.businessId ? (
              <ExpandPill
                label={businessName}
                icon="business"
                tone={{ line: 'var(--accent-plum)', fg: 'var(--accent-plum-text)', fill: 'var(--tint-plum)' }}
                open={open.has('business')}
                onToggle={() => toggle('business')}
              />
            ) : (
              <EmptyEdit title="Link a business" onClick={() => setPicking(true)} />
            )}
          </td>
        )}

        {show('address') && (
          <td style={{ ...TD, maxWidth: 200 }}>
            <AddressCell
              value={c.address}
              onSave={(address) => write(
                () => contactsAPI.update(c.id, { address }),
                (res) => patch({ address: res?.contact?.address1 ?? res?.contact?.address ?? address })
              )}
            />
          </td>
        )}

        {show('tags') && (
          <td style={{ ...TD, maxWidth: 200 }}>
            {/* One chip, like Tasks and Notes beside it — see TagsChip. */}
            <TagsChip
              tags={Array.isArray(c.tags) ? c.tags : []}
              catalogue={tagList}
              onAdd={(tag) => {
                const now = Array.isArray(c.tags) ? c.tags : []
                write(() => contactsAPI.addTags(c.id, [tag]), () => patch({ tags: [...now, tag] }))
              }}
              onRemove={(tag) => {
                const now = Array.isArray(c.tags) ? c.tags : []
                write(() => contactsAPI.removeTags(c.id, [tag]), () => patch({ tags: now.filter((x) => x !== tag) }))
              }}
            />
          </td>
        )}

        {/* The list carries the first five tasks and notes; a count-only pill,
            opening the record, remains for an older server or a contact with
            none. */}
        {show('tasks') && (
          <td style={{ ...TD, whiteSpace: 'nowrap' }}>
            {expandTasks ? (
              <ExpandPill
                label={`${tasks} task${tasks === 1 ? '' : 's'}`}
                icon="task_alt"
                tone={tasks ? { ...PILL_TONES.tasks, fill: 'var(--tint-clay)' } : PILL_TONES.tasksNone}
                open={open.has('tasks')}
                onToggle={() => toggle('tasks')}
              />
            ) : (
              <CountPill
                tone={tasks ? PILL_TONES.tasks : PILL_TONES.tasksNone}
                label={`${tasks} task${tasks === 1 ? '' : 's'}`}
                title="Open this contact to see their tasks"
                onClick={() => onOpen && onOpen(c.id)}
              />
            )}
          </td>
        )}

        {show('notes') && (
          <td style={{ ...TD, whiteSpace: 'nowrap' }}>
            {expandNotes ? (
              <ExpandPill
                label={notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'No notes'}
                icon="sticky_note_2"
                tone={notes ? { ...PILL_TONES.notes, fill: 'var(--tint-brown)' } : PILL_TONES.none}
                open={open.has('notes')}
                onToggle={() => toggle('notes')}
              />
            ) : (
              <CountPill
                tone={notes ? PILL_TONES.notes : { ...PILL_TONES.none, icon: 'sticky_note_2' }}
                label={notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'No notes'}
                title="Open this contact to see their notes"
                onClick={() => onOpen && onOpen(c.id)}
              />
            )}
          </td>
        )}

        {/* DEALS — "2 · £15,550". */}
        {show('deals') && (
          <td style={{ ...TD, whiteSpace: 'nowrap', borderRight: 'none' }}>
            <ExpandPill
              label={deals.length ? dealsLabel(deals) : 'No deals'}
              icon="sell"
              tone={deals.length ? { ...PILL_TONES.deals, fill: 'var(--tint-pine)' } : PILL_TONES.none}
              open={open.has('deals')}
              onToggle={() => toggle('deals')}
            />
          </td>
        )}
      </tr>

      {open.size > 0 && (
        <tr>
          <td colSpan={99} style={{ ...TD, borderRight: 'none', padding: 0, background: 'var(--gray-25)' }}>
            {/* Fixed order whatever was clicked first, as the design has it:
                who they work for, what is owed, what was written, the money. */}
            {open.has('business') && businessName && c.businessId && (
              <ExpandGroup>
                <ExpandItem
                  icon="business" iconColour="var(--accent-plum)"
                  name={businessName}
                  // City and the business's deal count are not on the
                  // contact list's payload yet.
                  a={<Faint>—</Faint>}
                  b={<Faint>—</Faint>}
                  view={(
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <RecordPill
                        kind="BUSINESS"
                        name={businessName}
                        onClick={onOpenBusiness ? () => onOpenBusiness(c.businessId) : undefined}
                      />
                      <SmallIcon icon="swap_horiz" title="Change business" onClick={() => setPicking(true)} />
                      <SmallIcon
                        icon="link_off" title="Unlink this business" danger
                        onClick={() => write(
                          () => contactsAPI.update(c.id, { businessId: null }),
                          () => { patch({ businessId: null, businessName: null }); toggle('business') }
                        )}
                      />
                    </span>
                  )}
                />
              </ExpandGroup>
            )}
            {open.has('tasks') && expandTasks && (
              <ExpandGroup>
                {!hasTasks && <ExpandNote>No open tasks</ExpandNote>}
                {hasTasks && c.tasks.map((t, i) => {
                  const overdue = t.dueAt && new Date(t.dueAt) < new Date()
                  return (
                    <ExpandItem
                      key={t.id || i}
                      icon="task_alt" iconColour="var(--accent-clay)"
                      name={t.title || '(untitled task)'}
                      a={t.dueAt
                        ? <span style={{ color: overdue ? 'var(--status-stuck-text)' : undefined }}>{formatDate(t.dueAt, false)}</span>
                        : <Faint>No due date</Faint>}
                      view={<RecordPill kind="TASK" name={t.title} onClick={onViewTask ? () => onViewTask(c.id, t) : (onOpen ? () => onOpen(c.id) : undefined)} />}
                    />
                  )
                })}
                {hasTasks && tasks > c.tasks.length && (
                  <MoreItem label={`+${tasks - c.tasks.length} more task${tasks - c.tasks.length === 1 ? '' : 's'} — open the contact`} onClick={onOpen ? () => onOpen(c.id) : undefined} />
                )}
              </ExpandGroup>
            )}
            {open.has('notes') && expandNotes && (
              <ExpandGroup>
                {!hasNotes && <ExpandNote>No notes yet</ExpandNote>}
                {hasNotes && c.notes.map((n, i) => {
                  const text = n.title || String(n.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty note)'
                  return (
                    <ExpandItem
                      key={n.id || i}
                      icon="sticky_note_2" iconColour="var(--accent-brown)"
                      name={text}
                      a={n.createdAt ? relativeTime(n.createdAt) : null}
                      view={(
                        <RecordPill
                          kind="NOTE" name={text}
                          // The Notes tab, filtered to this contact, with the
                          // note open — not the contact record.
                          onClick={onViewNote ? () => onViewNote(c.id, n) : (onOpen ? () => onOpen(c.id) : undefined)}
                        />
                      )}
                    />
                  )
                })}
                {hasNotes && notes > c.notes.length && (
                  <MoreItem label={`+${notes - c.notes.length} more note${notes - c.notes.length === 1 ? '' : 's'} — open the contact`} onClick={onOpen ? () => onOpen(c.id) : undefined} />
                )}
              </ExpandGroup>
            )}
            {open.has('deals') && (
              <ExpandGroup>
                {deals.length === 0 && <ExpandNote>No deals yet</ExpandNote>}
                {deals.map((d) => (
                  <ExpandItem
                    key={d.id}
                    icon="sell" iconColour="var(--green-600)"
                    name={d.name || 'Untitled deal'}
                    a={d.value != null ? money(d.value) : <Faint>—</Faint>}
                    b={[d.stage, d.primary && 'Primary'].filter(Boolean).join(' · ') || null}
                    view={(
                      <DealPill
                        name={d.name}
                        onClick={onOpenDeal ? () => onOpenDeal(d.id) : undefined}
                        compact
                      />
                    )}
                  />
                ))}
              </ExpandGroup>
            )}
          </td>
        </tr>
      )}

      {error && (
        <tr>
          <td colSpan={99} style={{
            ...TD, borderRight: 'none', padding: '6px 14px',
            fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)',
            background: 'var(--tint-rose)'
          }}>
            {c.name || 'This contact'}: {error}
          </td>
        </tr>
      )}

      {picking && (
        <BusinessPickerModal
          contact={c}
          blurb="Type a name to search the businesses in this sub-account."
          onClose={() => setPicking(false)}
          onLinked={(business) => {
            setPicking(false)
            patch({ businessId: business.id, businessName: business.name })
          }}
        />
      )}
    </>
  )
}

function dealsLabel(deals) {
  const total = deals.reduce((sum, d) => sum + (Number(d.value) || 0), 0)
  return total > 0
    ? `${deals.length} · ${money(total)}`
    : `${deals.length} deal${deals.length === 1 ? '' : 's'}`
}

function money(v) {
  return `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

function Faint({ children }) {
  return <span style={{ color: 'var(--text-faint)' }}>{children}</span>
}

// Initials on a pale blue square, as the list design draws them.
function Avatar({ name }) {
  const initials = String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]?.toUpperCase()).join('') || '?'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, flex: 'none',
      borderRadius: 'var(--radius-sm)', background: 'var(--tint-sky)',
      fontSize: 11, fontWeight: 700, color: 'var(--accent-sky-text)'
    }}>
      {initials}
    </span>
  )
}

// "…. ✎" — an empty field that can be filled from here.
function EmptyEdit({ onClick, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        border: 'none', background: 'none', padding: 0,
        fontFamily: 'inherit', fontSize: 'var(--text-md)',
        color: 'var(--text-faint)', cursor: 'pointer'
      }}
    >
      ….
      <span className="ms" style={{ fontSize: 14 }}>edit</span>
    </button>
  )
}

// A one-line text input for a cell. Enter or blur saves, Escape abandons.
function CellInput({ initial = '', placeholder, list, onDone, onCancel }) {
  const [draft, setDraft] = useState(initial)
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <input
      ref={ref}
      className="pp-cc-input"
      value={draft}
      list={list}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onDone(draft.trim()) }
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
      style={{ width: '100%', minWidth: 120, height: 28 }}
    />
  )
}

function AddressCell({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <CellInput
        initial={value || ''}
        placeholder="Add an address"
        onCancel={() => setEditing(false)}
        onDone={(next) => {
          setEditing(false)
          if (next !== (value || '')) onSave(next)
        }}
      />
    )
  }
  if (!value) return <EmptyEdit title="Add an address" onClick={() => setEditing(true)} />
  return (
    <button
      onClick={() => setEditing(true)}
      title={`${value} — click to edit`}
      style={{
        display: 'block', maxWidth: '100%',
        border: 'none', background: 'none', padding: 0, textAlign: 'left',
        fontFamily: 'inherit', fontSize: 'var(--text-md)', color: 'var(--text-body)',
        cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}
    >
      {value}
    </button>
  )
}

// Tags as stacked chips, removable on hover, with a quiet + to add one. The
// tag endpoints are ADDITIVE — see contactsAPI.addTags — so each change is
// its own write rather than a replacement of the whole list.

// An outlined count pill — "4 tasks", "1 note", "No deals".
//
// The chevron is the design's. On tasks and notes it does not open a list:
// the contacts list carries only the COUNTS, so the pill opens the contact's
// record instead (see PENDING_FUNCTIONALITY.md).
// The chevron only when the pill opens something. "No deals" drew one with
// nothing behind it — an arrow that promised a menu and did nothing.
function CountPill({ tone, label, onClick, title, chevron = !!onClick }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        height: 28, padding: '0 8px 0 10px',
        border: `1px solid ${tone.line}`,
        borderRadius: 'var(--radius-pill)',
        background: tone.fill || 'var(--surface-card)',
        color: tone.fg,
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 600,
        cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap'
      }}
    >
      {tone.icon && <span className="ms" style={{ fontSize: 15 }}>{tone.icon}</span>}
      {label}
      {chevron && <span className="ms" style={{ fontSize: 16 }}>expand_more</span>}
    </Tag>
  )
}

// A pill that toggles its group in the row's expansion — tinted, chevron up,
// while open.
function ExpandPill({ label, icon, tone, open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%',
        height: 28, padding: '0 8px 0 10px',
        border: `1px solid ${tone.line}`,
        borderRadius: 'var(--radius-pill)',
        background: open ? (tone.fill || 'var(--gray-50)') : 'var(--surface-card)',
        color: tone.fg,
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap'
      }}
    >
      <span className="ms" style={{ fontSize: 15, flex: 'none' }}>{icon}</span>
      <Truncate>{label}</Truncate>
      <span className="ms" style={{ fontSize: 16, flex: 'none' }}>
        {open ? 'expand_less' : 'expand_more'}
      </span>
    </button>
  )
}
