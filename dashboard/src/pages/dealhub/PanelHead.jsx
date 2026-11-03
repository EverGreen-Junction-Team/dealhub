import React from 'react'
import { Truncate } from '../shared/ListChrome'

// The solid header band every Deal hub panel wears (client design, Oct 2026).
//
// WHY A COMPONENT. The seven panels here — Deal, Timeline, Tasks, Notes,
// Qualification, Media, People, Co-Pilot — each had their own <header> block
// with the same shape: icon, title, a quiet subtitle, sometimes an action.
// They were pale tints with coloured text; the design makes them solid bands
// of the same accent with white text. Changing that in seven places invites
// six of them to agree and one to drift, which is how the Tasks header ended
// up needing its own --tasks-header token in the first place.
//
// NOT ListChrome's Panel. That one is shared with Businesses, Contacts, Tasks,
// Notes and the rest, so restyling it here would restyle those tabs too. It
// takes a `solidHeader` prop for when the same design reaches them.
//
// CONTRAST. The 18px/600 title clears AA-large (3:1) on every band. The
// smaller subtitle does NOT clear AA on clay (4.40:1) or gold (3.25:1), so it
// renders at 92% white rather than the 85% the mockup shows — the measured
// table lives in dealhub-tokens.css beside the tokens.
export default function PanelHead({
  icon,
  title,
  // The quiet line beside the title — "1 message · 1 task · 2 notes".
  subtitle,
  // pine | teal | clay | brown | gold | plum | sky
  accent = 'pine',
  // Anything right-aligned: a button, a badge, a chevron.
  action,
  // Renders as a <button> instead of a <header>, for the panels that collapse.
  as = 'header',
  // The native tooltip. Named separately because `title` is already the
  // heading text here — passing a tooltip through it would retitle the panel.
  tooltip,
  ...rest
}) {
  const band = `var(--panel-head-${accent}, var(--accent-${accent}))`
  const rule = `var(--panel-head-${accent}-border, var(--border-strong))`
  const Tag = as

  return (
    <Tag
      {...rest}
      title={tooltip}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
        width: as === 'button' ? '100%' : undefined,
        padding: '12px var(--space-4)',
        border: 'none',
        borderBottom: `1px solid ${rule}`,
        background: band,
        textAlign: 'left',
        cursor: as === 'button' ? 'pointer' : undefined,
        ...(rest.style || {})
      }}
    >
      {icon && (
        <span className="ms" style={{ fontSize: 19, color: '#fff', flex: 'none' }}>
          {icon}
        </span>
      )}
      <h3 style={{
        margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600, color: '#fff'
      }}>
        {title}
      </h3>
      {subtitle != null && subtitle !== '' && (
        <Truncate style={{
          fontSize: 'var(--text-md)',
          // 92%, not the design's 85% — see the contrast note above.
          color: 'rgba(255,255,255,0.92)',
          minWidth: 0
        }}>
          {subtitle}
        </Truncate>
      )}
      {action && <span style={{ marginLeft: 'auto', flex: 'none' }}>{action}</span>}
    </Tag>
  )
}

// The pill-shaped button that sits ON a solid band — "Edit record".
//
// A normal ghost button is a grey border on white, which on a coloured band
// reads as a hole punched through it. This is the inverse: a translucent white
// fill that lets the band show through.
export function PanelHeadButton({ icon, children, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 30, padding: '0 12px',
        border: '1px solid rgba(255,255,255,0.55)',
        borderRadius: 'var(--radius-pill)',
        background: 'rgba(255,255,255,0.14)',
        color: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
        cursor: 'pointer',
        ...(rest.style || {})
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 16 }}>{icon}</span>}
      {children}
    </button>
  )
}
