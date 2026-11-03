import React, { useEffect, useState } from 'react'
import { Select } from 'antd'
import { createPortal } from 'react-dom'
import { FiltersButton } from '../shared/WorkFilters'

// Contact type / tag, as a panel with Apply and Cancel.
//
// Deliberately the same shape as DealFilters: a portal so nothing on the page
// can clip it, staged edits so three changes are one request rather than
// three, and a badge that counts only what is actually narrowing the list.
//
// Not shared with DealFilters as one component: the two have different fields
// and different option sources, and a single component taking a schema would
// be harder to read than two that each say what they filter.

// Named windows rather than a free-text "days" box: these are the questions
// a rep actually asks, and a number field invites 1-day and 400-day filters
// that answer none of them.
const ACTIVITY_OPTIONS = [
  { value: 'active:7', label: 'Active in the last 7 days' },
  { value: 'active:30', label: 'Active in the last 30 days' },
  { value: 'quiet:30', label: 'Quiet for 30+ days' },
  { value: 'quiet:90', label: 'Quiet for 90+ days' }
]

const DEALS_OPTIONS = [
  { value: 'yes', label: 'Has an open deal' },
  { value: 'no', label: 'No open deal' }
]

const TYPE_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'customer', label: 'Customer' }
]

const SELECT = {
  width: '100%', height: 38, padding: '0 11px',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)',
  color: 'var(--text-body)', cursor: 'pointer'
}

const LABEL = {
  fontSize: 'var(--text-sm)', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)'
}

export function countContactFilters(f = {}) {
  return Object.entries(f).filter(([k, v]) => v && k !== 'view').length
}

// `activity` is one UI control but TWO server parameters, because "active
// within N days" and "quiet for N days" are different comparisons, not one
// with a sign. Kept as a single stored value so a saved view holds one filter
// rather than two that could drift apart.
export function activityParams(activity) {
  const [kind, days] = String(activity || '').split(':')
  if (!kind || !days) return {}
  if (kind === 'active') return { activeWithin: days }
  if (kind === 'quiet') return { quietFor: days }
  return {}
}

// What a filter chip should read. Without this the strip showed raw values —
// "Activity quiet:30" rather than "Quiet for 30+ days".
export function contactFilterLabels(f = {}, users = []) {
  const activity = ACTIVITY_OPTIONS.find((o) => o.value === f.activity)
  const deals = DEALS_OPTIONS.find((o) => o.value === f.hasDeals)
  const owner = users.find((u) => u.id === f.assignedTo)
  return {
    activity: activity && activity.value ? activity.label : undefined,
    hasDeals: deals && deals.value ? deals.label : undefined,
    minValue: f.minValue ? `over ${f.minValue}` : undefined,
    maxValue: f.maxValue ? `under ${f.maxValue}` : undefined,
    assignedTo: f.assignedTo
      ? (f.assignedTo === 'unassigned'
          ? 'Unassigned'
          // Same fallback chain as the dropdown's own labels, so the chip and
          // the option a rep picked always read identically.
          : (owner?.name || owner?.email || f.assignedTo))
      : undefined
  }
}

export default function ContactFilters({ filters = {}, onChange, tags = [], users = [] }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(filters)

  useEffect(() => { if (open) setDraft(filters) }, [open, filters])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const applied = countContactFilters(filters)

  const set = (key, value) => {
    setDraft((d) => {
      const next = { ...d }
      if (!value) delete next[key]
      else next[key] = value
      return next
    })
  }

  return (
    <>
      {/* The same pill as the Tasks and Notes toolbars. */}
      <FiltersButton
        applied={applied}
        onClick={() => setOpen(true)}
        title="Filter these contacts"
      />

      {open && createPortal(
        // .pp-portal — tokens and the icon font are scoped to [data-dealhub],
        // which a portal escapes.
        <div
          className="pp-portal"
          role="dialog"
          aria-modal="true"
          aria-label="Filter contacts"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.32)',
            display: 'flex', justifyContent: 'flex-end'
          }}
        >
          <div style={{
            width: 'min(380px, 100vw)', height: '100%',
            background: 'var(--surface-card)',
            display: 'flex', flexDirection: 'column',
            boxShadow: '-8px 0 28px rgba(0,0,0,0.14)'
          }}>
            <header style={{
              flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--space-3)', padding: 'var(--space-4)',
              borderBottom: '1px solid var(--border-default)'
            }}>
              <h2 style={{
                margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600,
                color: 'var(--text-heading)', letterSpacing: '-0.01em'
              }}>
                Filters
              </h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 30, height: 30, flex: 'none',
                  border: '1px solid var(--border-default)', borderRadius: '50%',
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
                <span style={LABEL}>Contact type</span>
                <Select
                  value={draft.contactType || undefined}
                  onChange={(v) => set('contactType', v)}
                  placeholder="Any type"
                  allowClear
                  options={TYPE_OPTIONS}
                  // Searchable, and OUR menu — a native <select>
                  // renders the OS's own list, which cannot be
                  // styled, searched or given the app's type.
                  showSearch
                  optionFilterProp="label"
                  popupClassName="pp-menu"
                  style={{ width: '100%' }}
                  styles={{ root: { height: 38 } }}
                />
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Last activity</span>
                <Select
                  value={draft.activity || undefined}
                  onChange={(v) => set('activity', v)}
                  placeholder="Any time"
                  allowClear
                  options={ACTIVITY_OPTIONS}
                  // Searchable, and OUR menu — a native <select>
                  // renders the OS's own list, which cannot be
                  // styled, searched or given the app's type.
                  showSearch
                  optionFilterProp="label"
                  popupClassName="pp-menu"
                  style={{ width: '100%' }}
                  styles={{ root: { height: 38 } }}
                />
              </label>

              {users.length > 0 && (
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={LABEL}>Owner</span>
                  <Select
                    value={draft.assignedTo || undefined}
                    onChange={(v) => set('assignedTo', v)}
                    // Searchable, and OUR menu — a native <select>
                    // renders the OS's own list, which cannot be
                    // styled, searched or given the app's type.
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="Anyone"
                    options={[
                      // Not a user id but a question managers ask; the
                      // server special-cases it to `assigned_to IS NULL`.
                      { value: 'unassigned', label: 'Unassigned' },
                      ...users.map((u) => ({ value: u.id, label: u.name || u.email || u.id }))
                    ]}
                    popupClassName="pp-menu"
                    style={{ width: '100%' }}
                    styles={{ root: { height: 38 } }}
                  />
                </label>
              )}

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Open deals</span>
                <Select
                  value={draft.hasDeals || undefined}
                  onChange={(v) => set('hasDeals', v)}
                  placeholder="Any"
                  allowClear
                  options={DEALS_OPTIONS}
                  // Searchable, and OUR menu — a native <select>
                  // renders the OS's own list, which cannot be
                  // styled, searched or given the app's type.
                  showSearch
                  optionFilterProp="label"
                  popupClassName="pp-menu"
                  style={{ width: '100%' }}
                  styles={{ root: { height: 38 } }}
                />
              </label>

              {/* Open deal value. Either bound alone is valid — "over £10k"
                  and "under £1k" are both real questions. */}
              <div style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Open deal value</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={draft.minValue || ''}
                    onChange={(e) => set('minValue', e.target.value)}
                    placeholder="Min"
                    aria-label="Minimum open deal value"
                    style={{ ...SELECT, cursor: 'text' }}
                  />
                  <span style={{ color: 'var(--text-faint)', flex: 'none' }}>to</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={draft.maxValue || ''}
                    onChange={(e) => set('maxValue', e.target.value)}
                    placeholder="Max"
                    aria-label="Maximum open deal value"
                    style={{ ...SELECT, cursor: 'text' }}
                  />
                </div>
              </div>

              {/* Only when the location HAS tags — an empty dropdown says
                  nothing useful, and a sub-account that tags nothing should
                  not be shown a control it can never use. */}
              {tags.length > 0 && (
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={LABEL}>Tag</span>
                  <Select
                    value={draft.tag || undefined}
                    onChange={(v) => set('tag', v)}
                    // Searchable, and OUR menu: a native <select> renders the
                    // OS's own list, which cannot be styled or searched.
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="Any tag"
                    options={tags.map((t) => ({ value: t, label: t }))}
                    popupClassName="pp-menu"
                    style={{ width: '100%' }}
                    styles={{ root: { height: 38 } }}
                  />
                </label>
              )}
            </div>

            <footer style={{
              flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--space-3)', padding: 'var(--space-4)',
              borderTop: '1px solid var(--border-default)'
            }}>
              {/* Clears the DRAFT — nothing here takes effect until Apply. */}
              <button
                onClick={() => setDraft({})}
                disabled={!countContactFilters(draft)}
                style={{
                  height: 36, padding: '0 4px',
                  border: 'none', background: 'transparent',
                  color: countContactFilters(draft) ? 'var(--text-muted)' : 'var(--text-faint)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                  textDecoration: countContactFilters(draft) ? 'underline' : 'none',
                  cursor: countContactFilters(draft) ? 'pointer' : 'default'
                }}
              >
                Clear all
              </button>

              <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                <button
                  onClick={() => setOpen(false)}
                  style={{
                    height: 36, padding: '0 14px',
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
                    height: 36, padding: '0 16px',
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
