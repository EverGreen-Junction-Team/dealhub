import React from 'react'

// Shared chrome for the four Control centre sections: accent-bordered card,
// icon + coloured title, a right-side meta slot ("2 samples"), and a tinted
// help strip under the header explaining what the section feeds.
//
// Same construction as PeopleSection / DealSection in the Deal Hub — 2px
// accent border, white body — so the app reads as one system.

export default function SectionCard({
  icon,
  title,
  accent,
  meta,
  help,
  children,
  footer,
  // COLLAPSE / EXPAND (client request, Oct 2026) — every Control panel
  // section. Starts CLOSED (client request) so the tab opens as a list of
  // section headers, except where `defaultOpen` says otherwise; the rep's
  // own open/closed choice is remembered per section in this browser.
  collapsible = false,
  // Start OPEN until the rep folds it (the email signature). Either way the
  // rep's own choice, once made, is what the next visit shows.
  defaultOpen = false
}) {
  const storeKey = `pp.control.collapsed.${title}`
  const [collapsed, setCollapsed] = React.useState(() => {
    if (!collapsible) return false
    try {
      const stored = localStorage.getItem(storeKey)
      return stored === null ? !defaultOpen : stored === '1'
    } catch { return !defaultOpen }
  })
  const toggle = () => setCollapsed((v) => {
    const next = !v
    try { localStorage.setItem(storeKey, next ? '1' : '0') } catch { /* private mode */ }
    return next
  })
  // SOLID HEADER BAND, the Deal hub panels' look (Oct 2026): the accent at
  // full strength, white title. It was a pale tint with accent-coloured text,
  // which read as the old style beside every redesigned tab.
  const band = `var(--panel-head-${accent}, var(--accent-${accent}))`
  const color = '#fff'
  const tint = band

  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: color,
        ['--panel-tint']: tint,
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden'
      }}
    >
      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: 'var(--space-3) var(--space-4)',
          background: band,
          borderBottom: collapsed ? 'none' : `1px solid var(--panel-head-${accent}-border, var(--border-default))`
        }}
      >
        <span className="ms" style={{ fontSize: 20, color }}>{icon}</span>
        {/* The title toggles too when the section folds — the whole name is
            a bigger target than the chevron alone. */}
        <h2
          onClick={collapsible ? toggle : undefined}
          style={{
            fontSize: 'var(--text-xl)', fontWeight: 600, color, margin: 0, flex: 1,
            cursor: collapsible ? 'pointer' : 'default'
          }}
        >
          {title}
        </h2>
        {meta && (
          <span style={{ fontSize: 'var(--text-md)', color: 'rgba(255,255,255,0.92)' }}>{meta}</span>
        )}
        {/* THE HELP TEXT AS AN ⓘ, not a paragraph. Every redesigned panel
            dropped its explanatory band; this keeps the explanation one hover
            (or keyboard focus) away instead of a grey strip under every
            header. */}
        {help && (
          <span
            tabIndex={0}
            role="img"
            aria-label={help}
            title={help}
            style={{
              display: 'inline-flex', flex: 'none', cursor: 'help',
              color: 'rgba(255,255,255,0.92)'
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>info</span>
          </span>
        )}
        {collapsible && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            title={collapsed ? 'Expand' : 'Collapse'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0, flex: 'none',
              border: 'none', borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.14)', color: '#fff', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 20 }}>{collapsed ? 'expand_more' : 'expand_less'}</span>
          </button>
        )}
      </header>

      {!collapsed && children}

      {!collapsed && footer && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: 'var(--space-3) var(--space-4)',
            borderTop: '1px solid var(--border-default)'
          }}
        >
          {footer}
        </div>
      )}
    </section>
  )
}

// ── Shared controls ───────────────────────────────────────────────────

export function PrimaryButton({ children, onClick, disabled, icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        height: 34, padding: '0 var(--space-4)',
        border: 'none', borderRadius: 'var(--radius-md)',
        background: disabled ? 'var(--gray-300)' : 'var(--green-600)',
        color: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s ease-out'
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 17 }}>{icon}</span>}
      {children}
    </button>
  )
}

// `danger` tints a destructive action — Delete next to Keep has to be
// distinguishable at a glance, or the safe option and the irreversible one
// look identical.
export function GhostButton({ children, onClick, disabled, icon, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        height: 34, padding: '0 14px',
        border: `1px solid ${danger ? 'var(--status-stuck)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        color: danger ? 'var(--status-stuck-text)' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 17 }}>{icon}</span>}
      {children}
    </button>
  )
}

export function IconButton({ icon = 'close', onClick, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, flex: 'none',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: '#fff', color: 'var(--text-muted)',
        cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}

export function TextField({ value, onChange, placeholder, mono, id }) {
  return (
    <input
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', height: 36, boxSizing: 'border-box',
        padding: '0 11px',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 'var(--text-md)', color: 'var(--text-heading)'
      }}
    />
  )
}

export function TextArea({ value, onChange, placeholder, rows = 4 }) {
  return (
    <textarea
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: '100%', boxSizing: 'border-box',
        padding: '10px 11px',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', lineHeight: 1.55,
        color: 'var(--text-heading)',
        resize: 'vertical'
      }}
    />
  )
}

// Save state shown next to a section's save button. Sections are saved
// independently, so each needs to say for itself whether it has unsaved
// edits, is mid-flight, or failed.
export function SaveState({ state, error }) {
  if (state === 'saving') {
    return <Note>Saving…</Note>
  }
  if (state === 'saved') {
    return (
      <Note color="var(--status-done)" icon="check_circle">Saved</Note>
    )
  }
  if (state === 'error') {
    return (
      <Note color="var(--status-stuck)" icon="error">
        {error || 'Save failed'}
      </Note>
    )
  }
  if (state === 'dirty') {
    return <Note icon="edit">Unsaved changes</Note>
  }
  return null
}

function Note({ children, color = 'var(--text-muted)', icon }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 'var(--text-base)', color
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 15 }}>{icon}</span>}
      {children}
    </span>
  )
}
