import React from 'react'

// The pieces the Tasks page is built from, per the rebuild spec.
//
// They live here rather than in ListChrome because the spec pins exact
// values — 26px tall, 12px/500 text, this tint with that border — and folding
// them into the shared chips would either drag every other surface along or
// leave two chip systems to drift apart.

// ── The tinted tab ───────────────────────────────────────────────────
//
// Contact, deal and business all render this way: a pale tint, a 1px border,
// text in the full colour. Never solid, never bold — "View DEAL" is the only
// solid element on a card, and making these solid too would leave nothing to
// mark the one control that acts.
const TAB_COLOUR = {
  contact:  { fg: 'var(--accent-sky-text)',  bg: 'var(--tint-sky)',  bd: '#bcd7f5', icon: 'person' },
  deal:     { fg: 'var(--accent-pine-text)', bg: 'var(--tint-pine)', bd: 'var(--green-300)', icon: 'sell' },
  business: { fg: 'var(--accent-plum-text)', bg: 'var(--tint-plum)', bd: '#cfc0ee', icon: 'domain' }
}

export function TintedTab({ kind, children, onClick, title }) {
  const c = TAB_COLOUR[kind]
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      onClick={onClick}
      title={title || (typeof children === 'string' ? children : undefined)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        maxWidth: '100%', height: 26, padding: '0 10px 0 8px',
        border: `1px solid ${c.bd}`, borderRadius: 'var(--radius-pill)',
        background: c.bg, color: c.fg,
        fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500,
        whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : 'default'
      }}
    >
      <span className="ms" style={{ fontSize: 14, flex: 'none' }}>{c.icon}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {children}
      </span>
    </Tag>
  )
}

// ── View DEAL ────────────────────────────────────────────────────────
//
// The one SOLID element on a card, which is what marks it as the thing that
// acts. With no deal it keeps the shape in red and reads "No DEAL" — a
// state, not a button, so it is not clickable.
export function DealAction({ dealName, onClick }) {
  const none = !dealName
  const fill = none ? 'var(--status-stuck)' : 'var(--green-500)'
  const Tag = none ? 'span' : 'button'
  return (
    <Tag
      onClick={none ? undefined : onClick}
      title={none ? 'This task is not linked to a deal' : `Open ${dealName}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
        height: 26, padding: '0 4px 0 10px',
        border: 'none', borderRadius: 'var(--radius-pill)', background: fill,
        fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600,
        color: '#fff', cursor: none ? 'default' : 'pointer', whiteSpace: 'nowrap'
      }}
    >
      {none ? 'No' : 'View'}
      <span style={{
        display: 'inline-flex', alignItems: 'center', height: 19, padding: '0 8px',
        borderRadius: 'var(--radius-pill)', background: '#fff', color: fill,
        fontSize: 10, fontWeight: 700, letterSpacing: 'var(--tracking-label)'
      }}>
        DEAL
      </span>
    </Tag>
  )
}

// ── Date ─────────────────────────────────────────────────────────────
//
// Plain text, no box, and not the word "due" — the column it sits in already
// says what it is. Overdue is the one case that changes weight and colour,
// because it is the one case a rep has to act on.
export function TaskDate({ due, state }) {
  const overdue = state === 'overdue'
  return (
    <span style={{
      fontSize: 13,
      fontWeight: overdue ? 600 : 400,
      color: overdue ? 'var(--status-stuck-text)' : 'var(--text-heading)',
      whiteSpace: 'nowrap'
    }}>
      {due}
    </span>
  )
}

// ── Complete ─────────────────────────────────────────────────────────
export function CompleteButton({ done, onClick, size = 26 }) {
  return (
    <button
      onClick={onClick}
      title={done ? 'Mark as open' : 'Mark complete'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, flex: 'none', padding: 0,
        border: `2px solid ${done ? 'var(--green-500)' : '#8a919c'}`,
        borderRadius: '50%',
        background: done ? 'var(--green-500)' : '#fff',
        color: done ? '#fff' : '#8a919c',
        cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 16, fontWeight: 700 }}>check</span>
    </button>
  )
}

// ── Edit / delete ────────────────────────────────────────────────────
export function RowIconButton({ icon, onClick, title, danger, size = 26 }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, flex: 'none', padding: 0,
        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
        background: '#fff',
        color: danger ? 'var(--status-stuck)' : 'var(--text-muted)',
        cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 15 }}>{icon}</span>
    </button>
  )
}
