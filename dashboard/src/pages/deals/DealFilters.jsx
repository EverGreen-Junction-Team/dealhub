import React, { useEffect, useState } from 'react'
import { Select } from 'antd'
import { createPortal } from 'react-dom'
import { TagFilter } from '../shared/ListFilters'
import ConfirmDialog from '../shared/ConfirmDialog'

// Status, Tag and the SAVED VIEWS, as a panel with Apply and Cancel.
//
// Stage and Owner moved OUT to the toolbar row — the Figma header is Search,
// Pipeline, Stage, Owner, Sort, then Filters. Tag and the saved views moved
// IN: the design has no place for them on the toolbar, and a rep reaches for
// them far less often than for the five fields that are there.
//
// WHY A PANEL AND NOT A DROPDOWN. It was an absolutely-positioned popover
// anchored to its button, and it was invisible: the board's horizontally
// scrolling column strip sits directly beneath the toolbar and covered it.
// Rendering into a portal at the document root puts it above every stacking
// context on the page rather than fighting them one at a time.
//
// WHY APPLY. Each select used to fire a request the moment it changed, so
// setting three filters meant three round trips and two intermediate results
// the rep never wanted to see. Changes are now staged and sent once — which
// also makes Cancel meaningful.

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'abandoned', label: 'Abandoned' },
  // "Any status" rather than GHL's "all": it means "do not filter", not a
  // fifth outcome, and the wording should not invite reading it as one.
  { value: 'all', label: 'Any status' }
]

const LABEL = {
  fontSize: 'var(--text-sm)', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)'
}

// The filters this PANEL owns. Stage and Owner have their own fields on the
// toolbar, so counting them here would badge "Filters (1)" for a choice the
// rep can already see in the row beside it.
const PANEL_KEYS = ['status', 'tag']

// `status: 'open'` is the default the list already applies, so it does not
// count — a badge reading "1" on an unfiltered board would be wrong.
export function countFilters(f = {}) {
  return Object.entries(f)
    .filter(([k, v]) => PANEL_KEYS.includes(k) && v && !(k === 'status' && v === 'open'))
    .length
}

export default function DealFilters({
  filters = {}, onChange,
  // Saved views. Optional: without onSaveView the section is not drawn.
  views = [], activeViewId = null, dirtyViewId = null,
  onSelectView, onSaveView, onUpdateView, onDeleteView
}) {
  const [open, setOpen] = useState(false)
  // Staged, not live: edits apply on Apply, and Cancel throws them away.
  const [draft, setDraft] = useState(filters)
  const [viewName, setViewName] = useState('')
  const [confirmingView, setConfirmingView] = useState(null)

  // Re-seed each time the panel opens, so it always reflects what is actually
  // applied rather than an abandoned edit from last time.
  useEffect(() => { if (open) { setDraft(filters); setViewName('') } }, [open, filters])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const applied = countFilters(filters)
  const activeView = views.find((v) => v.id === activeViewId) || null
  // Only offer an update for a view the rep can actually write to.
  const dirtyView = dirtyViewId ? views.find((v) => v.id === dirtyViewId && v.isMine) : null

  const set = (key, value) => {
    setDraft((d) => {
      const next = { ...d }
      if (!value) delete next[key]
      else next[key] = value
      return next
    })
  }

  function apply() {
    onChange(draft)
    setOpen(false)
  }

  // Saves the DRAFT, not what was applied before the panel opened: a rep who
  // sets Status to Won and types a name expects "Won deals" to mean won. The
  // draft is applied in the same step, so the list and the view agree.
  function saveAsView() {
    const n = viewName.trim()
    if (!n || !onSaveView) return
    onChange(draft)
    onSaveView(n, draft)
    setOpen(false)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={activeView ? `Filters — view "${activeView.name}" applied` : 'Filter these deals'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 36, padding: '0 12px', flex: 'none',
          border: '1px solid',
          borderColor: applied || activeView ? 'var(--green-300)' : 'var(--border-strong)',
          borderRadius: 'var(--radius-md)',
          background: applied || activeView ? 'var(--tint-pine)' : 'var(--surface-card)',
          color: applied || activeView ? 'var(--green-600)' : 'var(--text-body)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
          fontWeight: applied || activeView ? 600 : 500,
          cursor: 'pointer', maxWidth: 260
        }}
      >
        <span className="ms" style={{ fontSize: 17 }}>tune</span>
        Filters{applied ? ` (${applied})` : ''}
        {/* The applied saved view, named on the button. Its old home was a
            tab on the toolbar; with the tabs gone this is the only place on
            screen that says which view the list is showing. */}
        {activeView && (
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontWeight: 500
          }}>
            · {activeView.name}
          </span>
        )}
      </button>

      {open && createPortal(
        // .pp-portal — the design tokens and the icon font are scoped to
        // [data-dealhub], which a portal escapes. Without it every var()
        // below resolves to nothing and the icons render as literal text.
        <div
          className="pp-portal"
          role="dialog"
          aria-modal="true"
          aria-label="Filter deals"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.32)',
            display: 'flex', justifyContent: 'flex-end'
          }}
        >
          <div
            style={{
              width: 'min(380px, 100vw)', height: '100%',
              background: 'var(--surface-card)',
              display: 'flex', flexDirection: 'column',
              boxShadow: '-8px 0 28px rgba(0,0,0,0.14)'
            }}
          >
            <header style={{
              flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: 'var(--space-4)',
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
              flex: 1, overflowY: 'auto',
              padding: 'var(--space-4)',
              display: 'grid', gap: 'var(--space-4)', alignContent: 'start'
            }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Status</span>
                <Select
                  value={draft.status || 'open'}
                  onChange={(v) => set('status', v)}
                  options={STATUS_OPTIONS}
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

              {/* TagFilter renders nothing on an account with no tags — an
                  empty dropdown invites a rep to open it and find nothing. */}
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={LABEL}>Tag</span>
                <TagFilter
                  bare
                  width="100%"
                  value={draft.tag || ''}
                  onChange={(v) => set('tag', v)}
                />
              </label>

              {onSaveView && (
                <section style={{
                  display: 'grid', gap: 'var(--space-2)',
                  paddingTop: 'var(--space-4)',
                  borderTop: '1px solid var(--border-default)'
                }}>
                  <span style={LABEL}>Saved views</span>

                  {views.length === 0 && (
                    <p style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text-faint)' }}>
                      No saved views yet. Set the filters you use often and save them below.
                    </p>
                  )}

                  {views.map((v) => {
                    const on = v.id === activeViewId
                    return (
                      <div key={v.id} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        border: `1px solid ${on ? 'var(--green-300)' : 'var(--border-default)'}`,
                        borderRadius: 'var(--radius-md)',
                        background: on ? 'var(--tint-pine)' : 'var(--surface-card)'
                      }}>
                        <button
                          type="button"
                          onClick={() => { onSelectView(on ? null : v.id); setOpen(false) }}
                          title={on ? `Clear "${v.name}"` : `Apply "${v.name}"`}
                          style={{
                            flex: 1, minWidth: 0,
                            display: 'inline-flex', alignItems: 'center', gap: 7,
                            height: 36, padding: '0 10px',
                            border: 'none', background: 'none', textAlign: 'left',
                            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                            fontWeight: on ? 600 : 500,
                            color: on ? 'var(--green-600)' : 'var(--text-body)',
                            cursor: 'pointer'
                          }}
                        >
                          <span className="ms" style={{ fontSize: 16, flex: 'none' }}>
                            {v.isShared ? 'group' : 'bookmark'}
                          </span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {v.name}
                          </span>
                          {on && (
                            <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                              Applied
                            </span>
                          )}
                        </button>
                        {v.isMine && onDeleteView && (
                          <button
                            type="button"
                            // Closes the panel first: the confirm dialog
                            // stacks at z-index 70, below this portal's 1000,
                            // so it would otherwise open hidden behind it.
                            onClick={() => { setConfirmingView(v); setOpen(false) }}
                            title={`Delete "${v.name}"`}
                            aria-label={`Delete ${v.name}`}
                            style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 30, height: 30, marginRight: 3, flex: 'none',
                              border: 'none', borderRadius: 'var(--radius-sm)',
                              background: 'none', color: 'var(--text-muted)', cursor: 'pointer'
                            }}
                          >
                            <span className="ms" style={{ fontSize: 16 }}>delete</span>
                          </button>
                        )}
                      </div>
                    )
                  })}

                  {/* An applied view whose filters were edited since: save over
                      it rather than inventing a near-duplicate. */}
                  {dirtyView && onUpdateView && (
                    <button
                      type="button"
                      onClick={() => { onUpdateView(dirtyView.id); setOpen(false) }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        height: 36, padding: '0 11px',
                        border: '1px solid var(--brand-primary)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--surface-card)', color: 'var(--brand-primary)',
                        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                        fontWeight: 600, cursor: 'pointer'
                      }}
                    >
                      <span className="ms" style={{ fontSize: 16 }}>save</span>
                      Update “{dirtyView.name}” with current filters
                    </button>
                  )}

                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={viewName}
                      onChange={(e) => setViewName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveAsView() }}
                      placeholder="Name a new view"
                      maxLength={60}
                      aria-label="New view name"
                      style={{
                        flex: 1, minWidth: 0, height: 36, padding: '0 10px',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 'var(--radius-md)',
                        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                        color: 'var(--text-body)'
                      }}
                    />
                    <button
                      type="button"
                      onClick={saveAsView}
                      disabled={!viewName.trim()}
                      title="Apply these filters and save them as a view"
                      style={{
                        height: 36, padding: '0 12px', flex: 'none',
                        border: 'none', borderRadius: 'var(--radius-md)',
                        background: viewName.trim() ? 'var(--brand-primary)' : 'var(--gray-200)',
                        color: viewName.trim() ? '#fff' : 'var(--text-faint)',
                        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
                        cursor: viewName.trim() ? 'pointer' : 'default'
                      }}
                    >
                      Save view
                    </button>
                  </div>
                </section>
              )}
            </div>

            <footer style={{
              flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: 'var(--space-4)',
              borderTop: '1px solid var(--border-default)'
            }}>
              {/* Clears the DRAFT, not the applied filters — nothing here
                  takes effect until Apply, including this. Only this panel's
                  own fields: Stage and Owner live on the toolbar. */}
              <button
                onClick={() => setDraft((d) => {
                  const next = { ...d }
                  PANEL_KEYS.forEach((k) => delete next[k])
                  return next
                })}
                disabled={!countFilters(draft)}
                style={{
                  height: 36, padding: '0 4px',
                  border: 'none', background: 'transparent',
                  color: countFilters(draft) ? 'var(--text-muted)' : 'var(--text-faint)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                  textDecoration: countFilters(draft) ? 'underline' : 'none',
                  cursor: countFilters(draft) ? 'pointer' : 'default'
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
                  onClick={apply}
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

      {/* Deleting a saved view cannot be undone. */}
      {confirmingView && (
        <ConfirmDialog
          title="Delete this view?"
          message="This cannot be undone. The deals it filtered are not affected."
          preview={confirmingView.name}
          confirmLabel="Delete view"
          onConfirm={() => {
            onDeleteView(confirmingView.id)
            setConfirmingView(null)
          }}
          onCancel={() => setConfirmingView(null)}
        />
      )}
    </>
  )
}
