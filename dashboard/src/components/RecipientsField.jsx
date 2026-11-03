import React, { useEffect, useMemo, useRef, useState } from 'react'
import { contactsAPI } from '../api/contacts'
import { initialsFor } from '../pages/shared/ListChrome'

// RecipientsField — the To / CC / BCC rows of an email draft, drawn the way
// GHL's own composer draws them.
//
// To, CC and BCC are all lists. The email files under the FIRST To
// contact's conversation, and GHL's send takes one To address, so the
// server sends the first To as the To and the rest as CC — the card shows
// who the rep addressed, the wire carries what GHL allows (actionExecutor
// explains). Clicking into any row opens a contact list
// at once — no typing needed — with the deal's own people first (handed in
// as `options`), then the sub-account's contacts; typing narrows it by
// name or address through the server. Rows already on the email carry a
// tick, and clicking a ticked row takes them off again. An address that
// matches nobody can be typed and added on Enter or comma, anywhere but
// To, which has to be a contact.
//
// Value contract mirrors the server's payload:
//   { to: [{contactId, name, email}], cc: [{contactId?, name?, email}], bcc: [...] }

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/
const DEBOUNCE_MS = 200
const PAGE = 20

const nameOf = (c) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.business || c.email || 'Contact'

const fromContact = (c) => ({ contactId: c.id, name: nameOf(c), email: String(c.email || '').toLowerCase() })

const key = (r) => String(r?.email || '').toLowerCase()

// `scope`: 'deal' offers the deal's people only (Deal AI — the rep asked to
// message someone on this deal, and a sub-account-wide list there is a way
// to email the wrong customer); 'all' adds the sub-account's contacts and
// server search (Insights AI, where no deal is in scope).
// `collapsibleCc`: CC and BCC start hidden behind "CC  BCC" links on the To
// row, as GHL's composer has them (the Deal Hub timeline composer). Off, CC
// is always shown and only BCC is behind a link.
export default function RecipientsField({
  value, onChange, options = [], scope = 'all', disabled = false, collapsibleCc = false
}) {
  // `to` was a single object before it became a list; read both.
  const v = useMemo(() => {
    const raw = value || {}
    const to = Array.isArray(raw.to) ? raw.to : (raw.to ? [raw.to] : [])
    return { to, cc: raw.cc || [], bcc: raw.bcc || [] }
  }, [value])
  const [showBcc, setShowBcc] = useState((v.bcc || []).length > 0)
  const [showCc, setShowCc] = useState(!collapsibleCc || (v.cc || []).length > 0)
  const [openRow, setOpenRow] = useState(null) // 'to' | 'cc' | 'bcc' | null

  // One directory for all three rows: the deal's people, then the first
  // page of contacts, fetched once on first open. Typing searches instead.
  const [initial, setInitial] = useState(null)
  const wide = scope !== 'deal'
  useEffect(() => {
    if (!wide || !openRow || initial !== null) return undefined
    let alive = true
    contactsAPI.list({ limit: PAGE })
      .then((res) => { if (alive) setInitial((res?.contacts || []).filter((c) => c.email).map(fromContact)) })
      .catch(() => { if (alive) setInitial([]) })
    return () => { alive = false }
  }, [openRow, initial, wide])

  const set = (patch) => onChange({ to: v.to, cc: v.cc, bcc: v.bcc, ...patch })

  const rows = [
    { id: 'to', label: 'To', values: v.to, contactsOnly: true,
      add: (r) => set({ to: [...v.to, r] }),
      remove: (k) => set({ to: v.to.filter((x) => key(x) !== k) }) },
    ...(showCc ? [{ id: 'cc', label: 'CC', values: v.cc || [],
      add: (r) => set({ cc: [...(v.cc || []), r] }),
      remove: (k) => set({ cc: (v.cc || []).filter((x) => key(x) !== k) }) }] : []),
    ...(showBcc ? [{ id: 'bcc', label: 'BCC', values: v.bcc || [],
      add: (r) => set({ bcc: [...(v.bcc || []), r] }),
      remove: (k) => set({ bcc: (v.bcc || []).filter((x) => key(x) !== k) }) }] : [])
  ]

  const directory = useMemo(() => [...options, ...(initial || [])], [options, initial])
  const dealEmails = useMemo(() => new Set(options.map(key)), [options])
  const primaryEmail = options.find((o) => o.isPrimary)?.email?.toLowerCase() || null

  return (
    <div style={{
      border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
      background: 'var(--surface-card)'
    }}>
      {rows.map((row, i) => (
        <RecipientRow
          key={row.id}
          row={row}
          last={i === rows.length - 1}
          open={openRow === row.id}
          onOpen={() => setOpenRow(row.id)}
          onClose={() => setOpenRow((cur) => (cur === row.id ? null : cur))}
          directory={directory}
          directoryLoading={wide && openRow === row.id && initial === null}
          wide={wide}
          dealEmails={dealEmails}
          primaryEmail={primaryEmail}
          disabled={disabled}
          trailing={collapsibleCc
            ? (row.id === 'to' && (!showCc || !showBcc) ? (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                {!showCc && <button type="button" onClick={() => { setShowCc(true); setOpenRow('cc') }} style={linkBtn}>CC</button>}
                {!showBcc && <button type="button" onClick={() => { setShowBcc(true); setOpenRow('bcc') }} style={linkBtn}>BCC</button>}
              </span>
            ) : null)
            : (row.id === 'cc' && !showBcc ? (
              <button type="button" onClick={() => setShowBcc(true)} style={linkBtn}>Bcc</button>
            ) : null)}
        />
      ))}
    </div>
  )
}

const linkBtn = {
  border: 0, background: 'none', padding: '0 4px', cursor: 'pointer',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 600,
  color: 'var(--accent-sky-text)'
}

function RecipientRow({
  row, last, open, onOpen, onClose, directory, directoryLoading, wide,
  dealEmails, primaryEmail, disabled, trailing
}) {
  const { values, contactsOnly } = row
  const single = false
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const reqId = useRef(0)

  const q = query.trim().toLowerCase()

  // Server search once there is a query. The directory already covers the
  // empty case.
  useEffect(() => {
    if (!wide || !open || !q) { setResults([]); setSearching(false); return undefined }
    setSearching(true)
    const id = ++reqId.current
    const t = window.setTimeout(() => {
      contactsAPI.list({ q, limit: PAGE })
        .then((res) => { if (id === reqId.current) setResults((res?.contacts || []).filter((c) => c.email).map(fromContact)) })
        .catch(() => { if (id === reqId.current) setResults([]) })
        .finally(() => { if (id === reqId.current) setSearching(false) })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [q, open, wide])

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) { onClose(); setQuery('') } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onClose])

  const chosen = useMemo(() => new Set(values.map(key)), [values])

  const list = useMemo(() => {
    const seen = new Set()
    const out = []
    const push = (r) => {
      const k = key(r)
      if (!k || seen.has(k)) return
      seen.add(k)
      out.push(r)
    }
    const pool = q
      ? [...directory.filter((r) => `${r.name || ''} ${r.email}`.toLowerCase().includes(q)), ...results]
      : directory
    for (const r of pool) push(r)
    if (!contactsOnly && q && EMAIL_RE.test(q) && !seen.has(q)) out.push({ email: q, name: null, typed: true })
    return out
  }, [directory, results, q, contactsOnly])

  useEffect(() => { setActive(0) }, [list.length, q])

  const toggle = (r) => {
    if (!r) return
    const k = key(r)
    if (single) {
      row.add({ contactId: r.contactId || null, name: r.name || null, email: r.email })
      setQuery('')
      onClose()
      return
    }
    if (chosen.has(k)) row.remove(k)
    else row.add({ contactId: r.contactId || null, name: r.name || null, email: r.email })
    setQuery('')
    inputRef.current?.focus()
  }

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); onOpen(); setActive((a) => Math.min(a + 1, Math.max(list.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && q)) {
      if (list.length) { e.preventDefault(); toggle(list[active]) }
      else if (!contactsOnly && q && EMAIL_RE.test(q)) { e.preventDefault(); toggle({ email: q }) }
    } else if (e.key === 'Backspace' && !query && values.length && !single) {
      row.remove(key(values[values.length - 1]))
    } else if (e.key === 'Escape') { onClose(); setQuery('') }
  }

  const focusInput = () => {
    if (disabled) return
    onOpen()
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        display: 'grid', gridTemplateColumns: '48px minmax(0, 1fr) auto', alignItems: 'center',
        gap: 8, padding: '7px 12px', minHeight: 44,
        borderBottom: last ? 'none' : '1px solid var(--border-default)'
      }}
    >
      <span style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-muted)' }}>
        {row.label}
      </span>

      <div
        onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); focusInput() } }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0, cursor: 'text' }}
      >
        {values.map((r) => (
          <Chip
            key={key(r)}
            r={r}
            onRemove={disabled || single ? null : () => row.remove(key(r))}
            onClick={single && !disabled ? focusInput : null}
          />
        ))}
        {(!single || open || !values.length) && (
          <input
            ref={inputRef}
            className="pp-focus-inherit"
            value={query}
            disabled={disabled}
            onChange={(e) => { setQuery(e.target.value); onOpen() }}
            onFocus={onOpen}
            onKeyDown={onKey}
            placeholder={values.length ? '' : (contactsOnly ? 'Choose a contact' : (wide ? 'Add people or an email' : 'Add someone on this deal, or an email'))}
            style={{
              flex: '1 1 160px', minWidth: 140, height: 28, border: 0, outline: 'none',
              boxShadow: 'none', background: 'transparent', padding: 0,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-heading)'
            }}
          />
        )}
      </div>

      <span>{trailing || null}</span>

      {open && !disabled && (
        <div
          role="listbox"
          style={{
            position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 30,
            maxHeight: 320, overflowY: 'auto',
            background: 'var(--surface-raised, #fff)', border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)', boxShadow: '0 12px 32px rgba(16, 24, 40, 0.14)',
            padding: 4
          }}
        >
          {list.map((r, i) => {
            const on = chosen.has(key(r))
            const tag = r.typed ? null
              : key(r) === primaryEmail ? 'Primary'
                : dealEmails.has(key(r)) ? 'On deal'
                  : null
            return (
              <button
                type="button"
                key={`${key(r)}-${r.typed ? 't' : 'c'}`}
                onMouseDown={(e) => { e.preventDefault(); toggle(r) }}
                onMouseEnter={() => setActive(i)}
                aria-selected={on}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  height: 40, padding: '0 10px', border: 0, textAlign: 'left', cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)',
                  background: i === active ? 'var(--gray-50)' : 'transparent',
                  fontFamily: 'var(--font-sans)'
                }}
              >
                <Avatar r={r} size={26} />
                <span style={{
                  minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 'var(--text-base)', color: 'var(--text-heading)'
                }}>
                  {r.typed ? <>Add <strong>{r.email}</strong></> : (
                    <>
                      {r.name}
                      <span style={{ color: 'var(--text-muted)' }}> &lt;{r.email}&gt;</span>
                    </>
                  )}
                </span>
                {tag && (
                  <span style={{
                    flex: 'none', fontSize: 'var(--text-xs)', fontWeight: 600,
                    color: 'var(--accent-pine-text)', background: 'var(--tint-pine)',
                    borderRadius: 'var(--radius-pill)', padding: '2px 8px'
                  }}>
                    {tag}
                  </span>
                )}
                {on && <span className="ms" style={{ flex: 'none', fontSize: 18, color: 'var(--accent-sky-text)' }}>check</span>}
              </button>
            )
          })}
          {(searching || directoryLoading) && (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Loading contacts…</div>
          )}
          {!searching && !directoryLoading && !list.length && (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {q
                ? (contactsOnly ? (wide ? 'No contact matches.' : 'No one on this deal matches.')
                  : (wide ? 'No contact matches — type a full address to add it.' : 'No one on this deal matches — type a full address to add them.'))
                : (wide ? 'No contacts with an email address.' : 'No one else on this deal has an email address.')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Avatar({ r, size = 24 }) {
  const label = r.name || r.email || '?'
  return (
    <span aria-hidden="true" style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, flex: 'none', borderRadius: '50%',
      background: r.contactId ? 'var(--tint-sky)' : 'var(--gray-100)',
      color: r.contactId ? 'var(--accent-sky-text)' : 'var(--gray-600)',
      fontSize: size <= 22 ? 9 : 'var(--text-xs)', fontWeight: 700, letterSpacing: 0.3
    }}>
      {initialsFor(label)}
    </span>
  )
}

// GHL's chip: avatar, the address, and an × on the ones that can go.
function Chip({ r, onRemove, onClick }) {
  return (
    <span
      title={r.name ? `${r.name} <${r.email}>` : r.email}
      onClick={onClick || undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28,
        padding: '0 8px 0 4px', borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-default)', background: 'var(--gray-50)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 500,
        color: 'var(--text-heading)', maxWidth: '100%', cursor: onClick ? 'pointer' : 'default'
      }}
    >
      <Avatar r={r} size={20} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${r.email}`}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          style={{
            border: 0, background: 'none', padding: 0, marginLeft: 2, cursor: 'pointer',
            display: 'inline-flex', color: 'var(--text-muted)'
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>close</span>
        </button>
      )}
    </span>
  )
}
