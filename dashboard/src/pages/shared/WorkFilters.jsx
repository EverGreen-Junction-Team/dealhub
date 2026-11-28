import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ContactPicker from './ContactPicker'
import RemotePicker from './RemotePicker'
import { searchDeals } from '../../hooks/useLinkTargets'

// Contact / deal filters for the Tasks and Notes tabs — the October 2026
// design's "Filter notes" drawer.
//
// A portal so nothing clips it, staged edits so two changes are one request
// (Clear all · Cancel · Apply in the footer, as the design has it), and a
// badge counting only what is actually narrowing the list.
//
// Pickers rather than dropdowns: a location has thousands of contacts and
// hundreds of deals, so these SEARCH the server. A <select> would have to
// preload everything to be useful, and would still miss whatever fell outside
// the first page.

export function countWorkFilters(f = {}) {
  return Object.entries(f).filter(([k, v]) => v && k !== 'view').length
}

// The toolbar label style — the same small dark caps as SEARCH and SORT.
const LABEL = {
  fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '.05em',
  color: '#4a515c'
}

// The "Filters" pill — shared with ContactFilters so every tab's toolbar
// opens its filters with the same control.
export function FiltersButton({ applied, onClick, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 34, padding: '0 14px 0 12px', flex: 'none',
        border: '1px solid',
        borderColor: applied ? 'var(--green-300)' : 'var(--border-strong)',
        borderRadius: 'var(--radius-pill)',
        background: applied ? 'var(--tint-pine)' : 'var(--surface-card)',
        color: applied ? 'var(--green-600)' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
        fontWeight: applied ? 600 : 500,
        cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 17 }}>tune</span>
      Filters{applied ? ` (${applied})` : ''}
    </button>
  )
}

export default function WorkFilters({ filters = {}, onChange, noun = 'tasks' }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(filters)

  useEffect(() => { if (open) setDraft(filters) }, [open, filters])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const applied = countWorkFilters(filters)
  const drafted = countWorkFilters(draft)

  // Staged until Apply — see the note at the top.
  const update = (patch) => setDraft((d) => {
    const next = { ...d, ...patch }
    for (const k of Object.keys(next)) if (!next[k]) delete next[k]
    return next
  })

  // The deal picker is scoped to the chosen contact when there is one — the
  // same rule the note and task editors follow, so a filter cannot offer a
  // deal that contact is not on.
  const dealSearch = React.useCallback(
    (q) => searchDeals(q, { contactId: draft.contactId || undefined }),
    [draft.contactId]
  )

  return (
    <>
      <FiltersButton
        applied={applied}
        onClick={() => setOpen(true)}
        title={`Filter these ${noun}`}
      />

      {open && createPortal(
        // .pp-portal — tokens and the icon font are scoped to [data-dealhub],
        // which a portal escapes.
        <div
          className="pp-portal"
          role="dialog"
          aria-modal="true"
          aria-label={`Filter ${noun}`}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.32)',
            display: 'flex', justifyContent: 'flex-end'
          }}
        >
          <div style={{
            width: 'min(340px, 100vw)', height: '100%',
            background: 'var(--surface-card)',
            display: 'flex', flexDirection: 'column',
            boxShadow: '-8px 0 28px rgba(0,0,0,0.14)'
          }}>
            <header style={{
              flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--space-3)', padding: '14px var(--space-4)',
              borderBottom: '1px solid var(--border-default)'
            }}>
              <h2 style={{
                margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600,
                color: 'var(--text-heading)', letterSpacing: '-0.01em'
              }}>
                Filter {noun}
              </h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 30, height: 30, flex: 'none',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent', color: 'var(--text-muted)',
                  cursor: 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 18 }}>close</span>
              </button>
            </header>

            <div style={{
              flex: 1, overflowY: 'auto', padding: 'var(--space-4)',
              display: 'grid', gap: 'var(--space-4)', alignContent: 'start'
            }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Contact</span>
                <ContactPicker
                  value={draft.contactId || null}
                  // The deal picker is scoped to the contact, so a deal chosen
                  // under the previous one may no longer be valid — cleared in
                  // the same change.
                  onChange={(id) => update({ contactId: id, dealId: undefined })}
                  placeholder="Anyone"
                />
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Deal</span>
                <RemotePicker
                  value={draft.dealId || null}
                  onChange={(id) => update({ dealId: id })}
                  search={dealSearch}
                  seed={[]}
                  placeholder="Any deal"
                  emptyText="No deal matches that"
                  style={{ width: '100%' }}
                />
              </label>
            </div>

            <footer style={{
              flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--space-3)', padding: '12px var(--space-4)',
              borderTop: '1px solid var(--border-default)'
            }}>
              <button
                onClick={() => setDraft({})}
                disabled={!drafted}
                style={{
                  height: 34, padding: 0,
                  border: 'none', background: 'transparent',
                  color: drafted ? 'var(--text-muted)' : 'var(--text-faint)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                  textDecoration: 'underline',
                  cursor: drafted ? 'pointer' : 'default'
                }}
              >
                Clear all
              </button>

              <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                <button
                  onClick={() => setOpen(false)}
                  style={{
                    height: 34, padding: '0 14px',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-card)',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                    fontWeight: 500, color: 'var(--text-body)', cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => { onChange(draft); setOpen(false) }}
                  className="pp-btn-primary"
                  style={{
                    height: 34, padding: '0 16px',
                    border: 'none', borderRadius: 'var(--radius-md)',
                    background: 'var(--brand-primary)', color: '#fff',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                    fontWeight: 600, cursor: 'pointer'
                  }}
                >
                  Apply
                </button>
              </span>
            </footer>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
