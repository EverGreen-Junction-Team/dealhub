import React, { useState } from 'react'
import { Popover, Select } from 'antd'
import ConfirmDialog from '../shared/ConfirmDialog'

// The SAVED VIEWS control on the Deals toolbar: a dropdown to apply one, and a
// "Save view" button whose popover names a new view, updates the applied one
// and deletes the rep's own.
//
// Status and Tag used to live here too, in a side panel with Apply/Cancel,
// along with these views. The client asked for every filter on the main row
// (Nov 2026), so Status and Tag are toolbar fields in DealsTab now and apply
// the moment they change, like Stage and Owner beside them. What was left of
// the panel was the views — and a panel for one dropdown was more chrome than
// the choice deserved.

export const STATUS_OPTIONS = [
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

// The dropdown. '' is "no view": choosing it clears the applied view and its
// filters, which is what clicking an applied view in the old panel did.
export function SavedViewSelect({ views = [], activeViewId = null, onSelectView }) {
  return (
    <Select
      aria-label="Saved view"
      value={activeViewId ?? ''}
      onChange={(v) => onSelectView(v || null)}
      options={[
        { value: '', label: 'No view' },
        ...views.map((v) => ({ value: v.id, label: v.name }))
      ]}
      showSearch
      optionFilterProp="label"
      popupClassName="pp-menu"
      popupMatchSelectWidth={false}
      style={{ width: 170 }}
      styles={{ root: { height: 36 } }}
    />
  )
}

export default function SaveViewButton({
  views = [], dirtyViewId = null,
  onSaveView, onUpdateView, onDeleteView
}) {
  const [open, setOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [confirmingView, setConfirmingView] = useState(null)

  // Only offer an update for a view the rep can actually write to.
  const dirtyView = dirtyViewId ? views.find((v) => v.id === dirtyViewId && v.isMine) : null
  const mine = views.filter((v) => v.isMine)

  function saveAsView() {
    const n = viewName.trim()
    if (!n) return
    onSaveView(n)
    setViewName('')
    setOpen(false)
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) setViewName('') }}
        trigger="click"
        placement="bottomRight"
        // Rendered at the document root, outside [data-dealhub]; the class is
        // what gives it the tokens and the icon font.
        rootClassName="pp-portal"
        content={
          <div style={{ display: 'grid', gap: 'var(--space-2)', width: 280 }}>
            <span style={LABEL}>Save these filters as a view</span>

            {/* An applied view whose filters were edited since: save over it
                rather than inventing a near-duplicate. */}
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
                Update “{dirtyView.name}”
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
                autoFocus
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
                style={{
                  height: 36, padding: '0 12px', flex: 'none',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  background: viewName.trim() ? 'var(--brand-primary)' : 'var(--gray-200)',
                  color: viewName.trim() ? '#fff' : 'var(--text-faint)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
                  cursor: viewName.trim() ? 'pointer' : 'default'
                }}
              >
                Save
              </button>
            </div>

            {mine.length > 0 && onDeleteView && (
              <section style={{
                display: 'grid', gap: 4,
                paddingTop: 'var(--space-2)',
                borderTop: '1px solid var(--border-default)'
              }}>
                <span style={LABEL}>Your views</span>
                {mine.map((v) => (
                  <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 30 }}>
                    <span className="ms" style={{ fontSize: 16, color: 'var(--text-muted)', flex: 'none' }}>
                      {v.isShared ? 'group' : 'bookmark'}
                    </span>
                    <span style={{
                      flex: 1, minWidth: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontSize: 'var(--text-md)', color: 'var(--text-body)'
                    }}>
                      {v.name}
                    </span>
                    <button
                      type="button"
                      // Closes the popover first: the confirm dialog stacks
                      // at z-index 70, below antd's popover layer, so it
                      // would otherwise open hidden behind it.
                      onClick={() => { setConfirmingView(v); setOpen(false) }}
                      title={`Delete "${v.name}"`}
                      aria-label={`Delete ${v.name}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 30, height: 30, flex: 'none',
                        border: 'none', borderRadius: 'var(--radius-sm)',
                        background: 'none', color: 'var(--text-muted)', cursor: 'pointer'
                      }}
                    >
                      <span className="ms" style={{ fontSize: 16 }}>delete</span>
                    </button>
                  </div>
                ))}
              </section>
            )}
          </div>
        }
      >
        <button
          type="button"
          title="Save these filters as a view"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 36, padding: '0 12px', flex: 'none',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-card)', color: 'var(--text-body)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
            cursor: 'pointer'
          }}
        >
          <span className="ms" style={{ fontSize: 17 }}>bookmark_add</span>
          Save view
        </button>
      </Popover>

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
