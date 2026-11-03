import React from 'react'

// Shared placeholder for tabs whose full implementation is scheduled after
// the Deal Hub tab lands. Keeps the top-nav clickable and visually
// consistent with the rest of the app.
export default function Placeholder({ icon, title, accent = 'pine', description }) {
  return (
    <div
      style={{
        maxWidth: 640, margin: '48px auto', padding: 32,
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: `var(--accent-${accent}-text)`,
        ['--panel-tint']: `var(--tint-${accent})`,
        borderRadius: 'var(--radius-md)',
        background: '#fff', textAlign: 'center'
      }}
    >
      <span
        className="ms"
        style={{
          fontSize: 'var(--text-2xl)', color: `var(--accent-${accent})`,
          display: 'inline-block', marginBottom: 12
        }}
      >
        {icon}
      </span>
      <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 6 }}>{title}</h1>
      <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {description}
      </p>
    </div>
  )
}
