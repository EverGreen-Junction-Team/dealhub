import React, { useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../shared/ConfirmDialog'
import { Truncate } from '../shared/ListChrome'

// The strip above the board: saved views, filters, search, view switch.
//
// Laid out in two rows because they answer different questions and change at
// different rates:
//
//   row 1  WHICH DEALS — the saved view tabs, plus the count they resolve to
//   row 2  HOW THEY LOOK and how to narrow them — filters, search, view mode
//
// One row would put a tab strip that grows with every saved view next to
// controls that never move, and the fixed controls would shift sideways every
// time someone saved a view.

const FILTER_LABEL = {
  status: 'Status',
  pipelineId: 'Pipeline',
  stageId: 'Stage',
  assignedTo: 'Owner'
}

// A tab. The active one is filled rather than underlined — this strip sits on
// a tinted page and an underline on a light ground reads as a divider.
function ViewTab({ view, active, onSelect, onDelete }) {
  const [hover, setHover] = useState(false)

  // A saved view is NOT a filter chip. It is the thing that PRODUCED the
  // filters beside it, so it reads as a bookmark: an icon, a heavier label,
  // and a solid fill when active.
  //
  // THE BORDER LIVES ON THE WRAPPER, not on the label button. It used to sit
  // on the button, which put the delete × outside the pill's outline — a
  // stray glyph floating next to a control rather than part of it. With the
  // outline on the wrapper, both children sit inside one shape.
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        view.isShared && !view.isMine
          ? `${view.name} — shared with the team`
          : (active ? `${view.name} — click to clear` : `Apply "${view.name}"`)
      }
      style={{
        display: 'inline-flex', alignItems: 'center', flex: 'none',
        height: 36, maxWidth: 220,
        border: '1px solid',
        borderColor: active ? 'var(--brand-primary)' : 'var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--brand-primary)' : 'var(--surface-card)',
        color: active ? '#fff' : 'var(--text-body)',
        overflow: 'hidden'
      }}
    >
      <button
        onClick={onSelect}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          minWidth: 0, height: '100%',
          padding: '0 11px',
          border: 'none', background: 'transparent', color: 'inherit',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
          fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap'
        }}
      >
        <span className="ms" style={{ fontSize: 16, flex: 'none' }}>
          {view.isShared ? 'group' : 'bookmark'}
        </span>
        <Truncate>
          {view.name}
        </Truncate>
      </button>

      {/* Inside the pill, and ALWAYS occupying its slot.
          It used to mount on hover, so the pill grew ~24px the moment the
          pointer touched it and shoved every neighbour sideways. Rendered
          always and faded instead: the width never changes.
          Only on your own views — a shared one belongs to whoever made it. */}
      {onDelete && (
        <button
          onClick={onDelete}
          title={`Delete "${view.name}"`}
          aria-label={`Delete ${view.name}`}
          tabIndex={hover ? 0 : -1}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: '100%', flex: 'none',
            paddingRight: 4,
            border: 'none', background: 'transparent',
            color: active ? '#fff' : 'var(--text-faint)',
            opacity: hover ? 1 : 0,
            pointerEvents: hover ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
            cursor: 'pointer'
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>close</span>
        </button>
      )}
    </span>
  )
}

// A live filter, shown as a removable chip so what is narrowing the list is
// visible rather than hidden behind a "Filters (2)" button.
function FilterChip({ label, value, onClear }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: 28, padding: '0 6px 0 10px',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-card)',
      fontSize: 'var(--text-base)', color: 'var(--text-body)',
      maxWidth: 220
    }}>
      <span style={{ color: 'var(--text-faint)' }}>{label}</span>
      <Truncate style={{ fontWeight: 600 }}>
        {value}
      </Truncate>
      <button
        onClick={onClear}
        aria-label={`Clear ${label}`}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, flex: 'none',
          border: 'none', borderRadius: '50%',
          background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer'
        }}
      >
        <span className="ms" style={{ fontSize: 14 }}>close</span>
      </button>
    </span>
  )
}

export default function DealToolbar({
  views = [], activeViewId, onSelectView, onSaveView, onDeleteView,
  filters = {}, filterLabels = {}, onClearFilter, onClearAll,
  count, countLabel = 'deals',
  // The Filters control, rendered first — it is what a rep reaches for to
  // narrow the list, so it leads the row.
  // A saved view whose filters have been edited since it was applied.
  dirtyViewId, onUpdateView,
  // Render without a border or radius — for a caller that already supplies
  // the surface, such as a Panel's toolbar slot.
  bare = false,
  filterControl,
  // Sits beside Filters. The pipeline picker lives here: it decides WHICH
  // deals are shown, the same question Filters answers — where the view
  // icons on the right only decide how they are drawn.
  secondaryControl,
  // False for a caller that picks saved views from its own dropdown (the
  // Contacts toolbar) — the tabs would show the same views twice.
  showViewTabs = true,
  // Rendered after Save view, still on the left — the Contacts "Show on
  // cards" toggles.
  afterViews,
  // Display controls (view switch, pipeline picker). Pushed right.
  children
}) {
  // The view awaiting a delete confirmation, or null.
  const [confirmingView, setConfirmingView] = useState(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (naming) inputRef.current?.focus() }, [naming])

  // Filters that have their OWN control on the toolbar do not also get a chip.
  //
  // Owner and Tag moved out of the "Filters" popover and onto the toolbar, so
  // a chip reading "Owner J srini" sat inches from a dropdown already reading
  // "Mine (J srini)" — the same fact twice, and two places to clear it from.
  // Chips exist to surface what is hidden inside the popover; these are not
  // hidden any more.
  const SELF_EVIDENT = new Set(['assignedTo', 'tag'])
  const allActive = Object.entries(filters).filter(([, v]) => v)
  const active = allActive.filter(([k]) => !SELF_EVIDENT.has(k))
  // Only offer an update for a view the caller can actually write to.
  const dirtyView = dirtyViewId
    ? views.find((v) => v.id === dirtyViewId && v.isMine)
    : null

  function save() {
    const n = name.trim()
    if (!n) return
    onSaveView(n)
    setName('')
    setNaming(false)
  }

  return (
    // ONE row: what narrows the list on the left, how it is displayed on the
    // right. It was two rows with a tab strip on top, but the strip held a
    // single permanent "All open deals" tab that did nothing until a view was
    // saved — a whole row of chrome for a control most reps never used.
    //
    // Saved views now appear only once they EXIST, and the way back to
    // unfiltered is the chips' own clear buttons, which is where a rep is
    // already looking.
    <>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
      flexWrap: 'wrap',
      // No padding when bare — the Panel's band already pads, and doubling it
      // pushed the controls into the middle of an over-tall strip.
      padding: bare ? 0 : '8px 14px',
      // `bare` drops the border and radius for a caller that already provides
      // a surface — a Panel's toolbar band. Without it the toolbar drew its
      // own rounded card inside the panel's, a box in a box.
      ...(bare
        // Fill the band. The Panel's toolbar slot is itself a flex row, so a
        // bare toolbar sized to its content and marginLeft:auto had nothing
        // to push against — the view switch sat beside the filters instead of
        // at the far right.
        ? { flex: 1, minWidth: 0 }
        : {
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)'
        })
    }}>
      {/* CONTEXT — which pipeline, and how many deals it holds.
          Its own group, separated by a rule: it is not a control you set to
          narrow the list, it is what the list IS. Everything after the rule
          acts on it. */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
        flex: 'none'
      }}>
        {secondaryControl}

      {/* The count belongs to the pipeline beside it, not to the far right of
          the row — it answers "how many are in THIS", which is the question
          the control to its left just set. Reflects the filters too, so a
          filtered board says how many survived them. */}
      {typeof count === 'number' && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', flex: 'none',
          height: 26, padding: '0 10px',
          borderRadius: 'var(--radius-pill)',
          // Grey, not a tint. It sits inside the context group and states a
          // fact; a coloured pill there read as another filter chip, which is
          // the one thing it is not.
          background: 'var(--gray-100)',
          fontSize: 'var(--text-md)', fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-muted)', whiteSpace: 'nowrap'
        }}>
          {count} {count === 1 ? countLabel.replace(/s$/, '') : countLabel}
        </span>
      )}

      </span>

      {/* A hairline, not a gap — spacing alone read as one long row of
          controls with no grouping.
          Only when there IS a context group to separate: Contacts passes no
          pipeline and no count, so this drew a line before nothing. */}
      {(secondaryControl || typeof count === 'number') && (
        <span
          aria-hidden="true"
          style={{
            flex: 'none', width: 1, height: 22,
            background: 'var(--border-default)',
            margin: '0 var(--space-1)'
          }}
        />
      )}

      {/* NARROWING — what cuts the list down, and the saved sets of it.

          The line break lives inside filterControl now, not here: only the
          caller knows which of its own controls are the common ones that
          should lead the row. Putting it here broke BEFORE the whole group,
          which pushed search onto the second line with everything else. */}
      {filterControl}

      {active.map(([k, v]) => (
        <FilterChip
          key={k}
          label={FILTER_LABEL[k] || k}
          value={filterLabels[k] || v}
          onClear={() => onClearFilter(k)}
        />
      ))}
      {active.length > 1 && (
        <button
          onClick={onClearAll}
          style={{
            height: 28, padding: '0 10px',
            border: 'none', background: 'transparent',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
            textDecoration: 'underline', cursor: 'pointer'
          }}
        >
          Clear all
        </button>
      )}

      {/* Saved views, only once there are any. */}
      {showViewTabs && views.map((v) => (
        <ViewTab
          key={v.id}
          view={v}
          active={activeViewId === v.id}
          onSelect={() => onSelectView(activeViewId === v.id ? null : v.id)}
          onDelete={v.isMine ? () => setConfirmingView(v) : undefined}
        />
      ))}

      {naming ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') { setNaming(false); setName('') }
            }}
            placeholder="Name this view"
            maxLength={60}
            style={{
              height: 36, width: 180, padding: '0 10px',
              border: '1px solid var(--brand-primary)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              color: 'var(--text-body)', outline: 'none'
            }}
          />
          <button
            onClick={save}
            disabled={!name.trim()}
            style={{
              height: 36, padding: '0 12px',
              border: 'none', borderRadius: 'var(--radius-md)',
              background: name.trim() ? 'var(--brand-primary)' : 'var(--gray-200)',
              color: name.trim() ? '#fff' : 'var(--text-faint)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
              cursor: name.trim() ? 'pointer' : 'default'
            }}
          >
            Save
          </button>
          {/* Escape works, but a rep who opened this by accident should not
              have to know that — and on the board there is nothing else to
              click that would dismiss it. */}
          <button
            onClick={() => { setNaming(false); setName('') }}
            title="Cancel"
            aria-label="Cancel naming this view"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, flex: 'none',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-card)', color: 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 17 }}>close</span>
          </button>
        </span>
      ) : (
        // Three states, one slot:
        //
        //   a view is applied and EDITED  -> "Update <name>"
        //   no view, but filters are set  -> "Save view"
        //   a view is applied, unchanged  -> nothing
        //
        // That last case was missing: "Save view" showed beside an applied
        // view whose filters had not been touched, inviting a rep to save a
        // duplicate of the view they were already looking at.
        dirtyViewId && dirtyView ? (
          <button
            onClick={() => onUpdateView(dirtyViewId)}
            title={`Save these filters over "${dirtyView.name}"`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 36, padding: '0 11px', flex: 'none',
              border: '1px solid var(--brand-primary)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-card)', color: 'var(--brand-primary)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              fontWeight: 600, cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>save</span>
            Update {dirtyView.name}
          </button>
        // allActive, not active: a view filtered to one owner and one tag is
        // a perfectly good view to save, and keying this off the CHIPPED
        // filters would hide the button for exactly that case.
        ) : (allActive.length > 0 && !activeViewId) && (
          <button
            onClick={() => setNaming(true)}
            title="Save these filters as a view"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 36, padding: '0 10px',
              // Dashed and square-cornered, matching the saved views it
              // creates — it is the empty slot beside them, not a filter.
              border: '1px dashed var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'transparent', color: 'var(--text-muted)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              fontWeight: 500, cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>add</span>
            Save view
          </button>
        )
      )}

      {afterViews}

      {/* Display controls sit right, away from everything that changes WHICH
          deals are shown. */}
      <span style={{
        marginLeft: 'auto',
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)'
      }}>
        {children}
      </span>
    </div>

    {/* Deleting a saved view cannot be undone, and the ✕ sits a few pixels
        from the pill a rep clicks to APPLY that view — close enough that a
        misclick threw away filters they had built up. */}
    {confirmingView && (
      <ConfirmDialog
        title="Delete this view?"
        message={`This cannot be undone. The ${countLabel} it filtered are not affected.`}
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
