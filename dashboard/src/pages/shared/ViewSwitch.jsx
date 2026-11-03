import React, { useState } from 'react'

// Rows / Grid / Board — a segmented control for choosing how a list is drawn.
//
// Extracted from DealsTab so Tasks and Notes get the same control rather than
// three near-identical copies drifting apart.
//
// ICONS, with the name shown only on the active option or on hover. Three
// labelled buttons take the width of a filter chip each for a control that is
// set once and rarely changed — but an icon-only strip of anonymous glyphs is
// worse, so the current view always reads its own name. `title` and
// `aria-label` carry it for hover-less and screen-reader users.
export default function ViewSwitch({ value, onChange, options }) {
  const [hover, setHover] = useState(null)
  if (!options?.length) return null

  return (
    <div
      role="tablist"
      aria-label="View"
      style={{
        display: 'inline-flex', flex: 'none',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-card)',
        overflow: 'hidden'
      }}
    >
      {options.map((o, i) => {
        const on = value === o.id
        const showLabel = on || hover === o.id
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={on}
            aria-label={o.label}
            onClick={() => onChange(o.id)}
            onMouseEnter={() => setHover(o.id)}
            onMouseLeave={() => setHover(null)}
            title={`${o.label} view`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: showLabel ? 5 : 0,
              height: 36, padding: showLabel ? '0 12px' : '0 10px',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--border-default)',
              background: on ? 'var(--tint-pine)' : 'transparent',
              color: on ? 'var(--green-600)' : 'var(--text-muted)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)',
              fontWeight: on ? 600 : 500,
              cursor: 'pointer',
              // The width changes as the label appears; without this the
              // neighbours jump sideways on every hover.
              transition: 'padding 120ms ease, background 120ms ease'
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>{o.icon}</span>
            {showLabel && o.label}
          </button>
        )
      })}
    </div>
  )
}
