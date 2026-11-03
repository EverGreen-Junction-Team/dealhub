import { useEffect, useMemo, useRef, useState } from 'react'
import { providersAPI } from '../api/providers'
import { Truncate } from '../pages/shared/ListChrome'

// SenderPicker — which sender carries an outbound message.
//
// THE PROBLEM. GHL locations routinely run a native channel and a custom
// marketplace provider with the same name: native WhatsApp beside a provider
// called "WhatsApp", native SMS beside "SMS Android" and "iMessage". Sending
// `{ type: 'WhatsApp' }` with no provider id lets GHL route through whichever
// it considers default. The rep could not choose, and afterwards nothing in
// the timeline said which one had carried the message.
//
// THE DESIGN RULE. A picker that appears on every send is a tax on the 95%
// of locations with one sender per channel. So this renders in three states,
// and the state is decided by the data, not by a prop:
//
//   one sender            → nothing at all. No control, no row, no noise.
//   several, all distinct → a quiet inline control. A choice exists, but the
//                           names already tell them apart, so it stays small.
//   several, names clash  → the same control, raised: the colliding entries
//                           carry a Native/Custom tag, because here the name
//                           alone genuinely cannot distinguish them.
//
// Only the third state is the "ask Native or Provider" case. Treating it as
// the default would mean interrupting everyone to solve a minority problem.
//
// Value contract: `null` means "no explicit sender — let GHL use its
// default", which is exactly what omitting conversationProviderId does on
// the wire. It is a real, selectable choice, not an empty state.

const DOT = {
  SMS: 'var(--accent-clay)', Email: 'var(--accent-sky)',
  WhatsApp: 'var(--accent-pine)',
}

// `alwaysShow` keeps the control on screen when there is exactly one sender,
// as a static line rather than a dropdown. Email composers pass it: an email
// with no visible From reads as a gap, where an SMS with none is normal.
export default function SenderPicker({ channel, value, onChange, disabled = false, alwaysShow = false }) {
  const [channels, setChannels] = useState(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    let alive = true
    providersAPI.list({ scope: 'composable' })
      .then((res) => { if (alive) setChannels(res?.channels || []) })
      // A catalogue that will not load must not block the send. The composer
      // falls back to no explicit sender, which is precisely the behaviour
      // that existed before this component — degraded, never broken.
      .catch(() => { if (alive) { setChannels([]); setError(true) } })
    return () => { alive = false }
  }, [])

  const group = useMemo(
    () => (channels || []).find((c) => c.channel === channel) || null,
    [channels, channel]
  )

  // Soft-deleted providers stay in the catalogue so historical timeline rows
  // can still name them, but they are not somewhere a rep can send today.
  const options = useMemo(
    () => (group?.providers || []).filter((p) => !p.isDeleted),
    [group]
  )

  const selected = useMemo(
    () => options.find((p) => (p.id ?? null) === (value ?? null)) || options[0] || null,
    [options, value]
  )

  // Close on outside click / Escape — a bare dropdown that traps focus is
  // worse than no dropdown.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (error || !group || options.length === 0) return null
  if (options.length <= 1 && !alwaysShow) return null
  // One sender and asked to show it: the same label and pill, no caret, no
  // menu — nothing to pick, so nothing that looks pickable.
  const single = options.length <= 1

  const collides = group.hasCollision
  const dot = DOT[channel] || 'var(--accent-gray-text)'

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 4,
      }}>
        <span style={{
          fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          Send via
        </span>
        {collides && (
          // Only shown when it is load-bearing: two senders a rep cannot tell
          // apart by name. Elsewhere it would be decoration.
          <span style={{
            fontSize: 'var(--text-xs)', color: 'var(--accent-gold-text)',
            background: 'var(--accent-gold)', padding: '1px 6px',
            borderRadius: 999, fontWeight: 600,
          }}>
            Two senders share this name
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={disabled || single}
        onClick={() => { if (!single) setOpen((v) => !v) }}
        aria-haspopup={single ? undefined : 'listbox'}
        aria-expanded={single ? undefined : open}
        title={single ? 'The only sender set up for this channel' : undefined}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 10px', borderRadius: 8,
          border: `1px solid ${collides ? 'var(--border-prominent)' : 'var(--border-default)'}`,
          background: disabled ? 'var(--surface-sunken)' : 'var(--surface-card)',
          color: 'var(--text-body)', fontSize: 'var(--text-sm)',
          cursor: disabled ? 'not-allowed' : single ? 'default' : 'pointer', textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <span style={{
          width: 7, height: 7, borderRadius: 999, background: dot, flexShrink: 0,
        }} />
        <Truncate style={{ flex: 1 }}>
          {selected ? labelFor(selected, channel) : 'Default sender'}
        </Truncate>
        {selected && kindTag(selected, collides)}
        {!single && <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>▾</span>}
      </button>

      {open && (
        <ul
          role="listbox"
          style={{
            position: 'absolute', zIndex: 40, top: 'calc(100% + 4px)', left: 0, right: 0,
            margin: 0, padding: 4, listStyle: 'none',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-default)', borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
            maxHeight: 260, overflowY: 'auto',
          }}
        >
          {options.map((p) => {
            const isSel = (p.id ?? null) === (selected?.id ?? null)
            return (
              <li key={p.id ?? '__native__'} role="option" aria-selected={isSel}>
                <button
                  type="button"
                  onClick={() => { onChange(p.id ?? null); setOpen(false) }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 8px', border: 'none', borderRadius: 7,
                    background: isSel ? 'var(--surface-selected)' : 'transparent',
                    color: 'var(--text-body)', fontSize: 'var(--text-sm)',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSel) e.currentTarget.style.background = 'var(--surface-hover)'
                  }}
                  onMouseLeave={(e) => {
                    if (!isSel) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: 999, background: dot, flexShrink: 0,
                  }} />
                  <Truncate style={{ flex: 1 }}>
                    {labelFor(p, channel)}
                  </Truncate>
                  {p.isDefault && !collides && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                      Default
                    </span>
                  )}
                  {kindTag(p, collides)}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// The native option arrives named "WhatsApp (native)" so it reads correctly in
// a list on its own. Inside a picker already scoped to one channel, the
// channel name is redundant — "Native" is what distinguishes it.
function labelFor(p, channel) {
  if (p.id === null) return `${channel} (native)`
  return p.name
}

// Native/Custom is only worth showing on the entries that actually collide.
// Tagging every row would turn a disambiguator into wallpaper.
function kindTag(p, collides) {
  if (!collides || !p.ambiguous) return null
  const isNative = p.id === null || p.isNative
  return (
    <span style={{
      fontSize: 'var(--text-xs)', fontWeight: 600,
      padding: '1px 6px', borderRadius: 999, flexShrink: 0,
      background: isNative ? 'var(--accent-teal)' : 'var(--accent-plum)',
      color: isNative ? 'var(--accent-teal-text)' : 'var(--accent-plum-text)',
    }}>
      {isNative ? 'Native' : 'Provider'}
    </span>
  )
}
