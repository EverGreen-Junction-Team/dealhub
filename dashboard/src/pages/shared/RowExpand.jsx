import React, { useCallback, useRef, useState } from 'react'
import { Truncate } from './ListChrome'
import { TONES } from './MenuChip'

// A list row that EXPANDS IN PLACE — the October 2026 list design, shared by
// the Contacts, Deals and Businesses tables.
//
// A pill in a cell (contacts, business, tasks, notes, deals) toggles its own
// group in a full-width row under the record. Several groups can be open at
// once, in a fixed order; each line carries a View pill to its record. They
// were floating dropdowns: one at a time, over the rows below.

// Which groups a row has open. Several at once.
export function useOpenSet() {
  const [open, setOpen] = useState(() => new Set())
  const toggle = useCallback((kind) => setOpen((cur) => {
    const next = new Set(cur)
    if (next.has(kind)) next.delete(kind); else next.add(kind)
    return next
  }), [])
  return [open, toggle]
}

// A list fetched the first time its group opens — a page of rows should not
// cost a request per row on load for groups nobody opened.
export function useLazy(fetcher) {
  const [state, setState] = useState({ items: null, error: null })
  const started = useRef(false)
  const load = useCallback(() => {
    if (started.current) return
    started.current = true
    fetcher()
      .then((items) => setState({ items, error: null }))
      .catch((e) => setState({ items: [], error: e?.message || 'Could not load' }))
  }, [fetcher])
  return [state, load]
}

// The cell's pill — MenuChip's look (tone names from its TONES), tinted with
// the chevron up while its group is open. Stops the click: these rows open
// their record on click.
export function ExpandChip({ icon, tone = 'neutral', label, title, open, onToggle, maxWidth = 160 }) {
  const t = TONES[tone] || TONES.neutral
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle && onToggle() }}
      aria-expanded={open}
      title={title || label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        maxWidth, height: 26, padding: '0 6px 0 9px',
        border: `1px solid ${t.border}`, borderRadius: 'var(--radius-pill)',
        background: open ? (t.bg !== 'var(--surface-card)' ? t.bg : 'var(--gray-50)') : 'var(--surface-card)',
        color: t.fg,
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 500,
        whiteSpace: 'nowrap', cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 15, flex: 'none' }}>{icon}</span>
      <Truncate>{label}</Truncate>
      <span className="ms" style={{ fontSize: 16, flex: 'none' }}>{open ? 'expand_less' : 'expand_more'}</span>
    </button>
  )
}

// The full-width row under the record that holds the open groups.
export function ExpandRow({ children, background = 'var(--gray-25)' }) {
  return (
    <tr onClick={(e) => e.stopPropagation()}>
      <td colSpan={99} style={{ padding: 0, background, borderBottom: '1px solid var(--border-default)' }}>
        {children}
      </td>
    </tr>
  )
}

// One open group, ruled off from the next.
export function ExpandGroup({ children }) {
  return (
    <div style={{ padding: '6px 16px 6px 56px', borderTop: '1px solid var(--border-default)' }}>
      {children}
    </div>
  )
}

// name · a · b · View — the same x on every line, so a group reads as a
// small table.
export function ExpandItem({ icon, iconColour, name, a = null, b = null, view }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 420px) 190px 150px auto',
      alignItems: 'center', columnGap: 16,
      padding: '7px 0',
      fontSize: 'var(--text-md)', color: 'var(--text-body)'
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span className="ms" style={{ fontSize: 17, flex: 'none', color: iconColour }}>{icon}</span>
        <Truncate style={{ fontWeight: 500, color: 'var(--text-heading)' }} title={typeof name === 'string' ? name : undefined}>
          {name}
        </Truncate>
      </span>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a}</span>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b}</span>
      <span style={{ display: 'inline-flex', justifySelf: 'start' }}>{view}</span>
    </div>
  )
}

// A one-line message inside a group — loading, an error, "none yet".
export function ExpandNote({ children, danger }) {
  return (
    <div style={{
      padding: '7px 0', fontSize: 'var(--text-sm)',
      color: danger ? 'var(--status-stuck-text)' : 'var(--text-muted)'
    }}>
      {children}
    </div>
  )
}

// The link at a group's foot to where the rest live.
export function MoreItem({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        margin: '4px 0 2px', padding: 0,
        border: 'none', background: 'none',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 600,
        color: 'var(--text-link)', cursor: onClick ? 'pointer' : 'default'
      }}
    >
      <span className="ms" style={{ fontSize: 15 }}>open_in_new</span>
      {label}
    </button>
  )
}

// A small square action after a View pill (Change / Unlink).
export function SmallIcon({ icon, title, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, padding: 0,
        border: '1px solid var(--border-default)', borderRadius: 6,
        background: '#fff', color: danger ? 'var(--status-stuck)' : 'var(--text-muted)',
        cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 15 }}>{icon}</span>
    </button>
  )
}

// Plain text from a note body, for a one-line label.
export function noteLabel(n) {
  return n?.title
    || String(n?.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    || '(empty note)'
}
