import React, { useMemo } from 'react'
import { Checkbox } from 'antd'
import { UNASSIGNED } from './boardLayout'

// The people list, as Google Calendar's "My calendars" — a checkbox each,
// tick what you want to see.
//
// ── WHY CHECKBOXES AND NOT THE DROPDOWN THIS REPLACES ────────────────
//
// The toolbar had a single-select "Everyone / one person" picker. It could
// answer "just show me Brad" and nothing else — and the question a
// dispatcher actually asks is "the two surveyors, not the marketing
// logins", which a single select cannot express at all. On a sub-account
// whose user list is mostly system accounts, that is the only question
// worth asking.
//
// ── FILTERED HERE, NOT ON THE SERVER ─────────────────────────────────
//
// The old picker sent ?assignedTo and the server narrowed the query. This
// does not: the window is fetched once for everyone and ticking filters
// what is already in the browser.
//
// That is a deliberate trade. A tick is now instant — no request, no
// spinner, no flash of an empty grid — which is what makes a checkbox list
// feel like a checkbox list rather than a search form. The cost is carrying
// a week of appointments for people who are unticked, which is a few
// hundred rows: nothing next to the round trip it saves on every toggle.
//
// ── EVERY COLUMN IS A COLOUR ─────────────────────────────────────────
//
// Assigned from a fixed palette by position, so a person keeps the same
// colour for as long as the list does. It is the only way to read a week
// view where everyone's work is mixed into one column per day — without it
// you are reading names off cards four to a column.

// Picked from the app's own accent tokens rather than invented, so the
// calendar stays in step with the rest of Deal Hub. Ordered so neighbours
// are easy to tell apart — adjacent people get visibly different hues, not
// two blues.
export const PERSON_COLOURS = [
  'var(--accent-teal)', 'var(--accent-clay)', 'var(--accent-pine)',
  'var(--accent-plum)', 'var(--accent-gold)', 'var(--accent-sky)',
  'var(--accent-rose)', 'var(--accent-brown)', 'var(--accent-sun)'
]

/**
 * A stable colour for one person.
 *
 * By INDEX in the list, not by hashing the id. A hash is stable across
 * sessions but gives no control over neighbours, so two people side by side
 * routinely got near-identical colours — which is the one thing this has to
 * avoid. The list is alphabetical and changes rarely, so position is stable
 * enough in practice.
 */
export function colourFor(resources, userId) {
  if (!userId) return 'var(--gray-450)'
  const i = resources.findIndex((r) => r.id === userId)
  if (i < 0) return 'var(--gray-450)'
  return PERSON_COLOURS[i % PERSON_COLOURS.length]
}

export default function CalendarPeople({
  resources, selected, onChange, counts
}) {
  // null/undefined selection means EVERYONE, which is different from an empty
  // array meaning nobody. A fresh board shows all the work; a board where
  // someone has unticked every box shows none, and should, or unticking the
  // last person would silently show everything again.
  const all = useMemo(
    () => [...resources.map((r) => r.id), UNASSIGNED],
    [resources]
  )
  const isAll = selected == null
  const checked = isAll ? all : selected

  const toggle = (id) => {
    const next = checked.includes(id)
      ? checked.filter((x) => x !== id)
      : [...checked, id]
    // Back to "everyone" when everything is ticked, so the state returns to
    // its clean form rather than to a list that happens to contain all of
    // them — otherwise adding a rep tomorrow would leave them unticked.
    onChange(next.length === all.length ? null : next)
  }

  return (
    <aside
      style={{
        width: 196, flex: '0 0 196px',
        alignSelf: 'flex-start',
        position: 'sticky', top: 'var(--space-3)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-card)',
        padding: 'var(--space-3)'
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          marginBottom: 'var(--space-2)'
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 'var(--text-xs)',
            letterSpacing: 'var(--tracking-label)',
            textTransform: 'uppercase',
            color: 'var(--text-muted)'
          }}
        >
          People
        </h3>
        <button
          type="button"
          onClick={() => onChange(isAll ? [] : null)}
          style={{
            border: 'none', background: 'none', padding: 0,
            fontSize: 'var(--text-xs)', color: 'var(--text-link)',
            cursor: 'pointer'
          }}
        >
          {isAll ? 'None' : 'All'}
        </button>
      </div>

      <div style={{ display: 'grid', gap: 2 }}>
        {resources.map((r) => (
          <Row
            key={r.id}
            colour={colourFor(resources, r.id)}
            label={r.name}
            count={counts?.get(r.id) || 0}
            checked={checked.includes(r.id)}
            onToggle={() => toggle(r.id)}
          />
        ))}

        {/* Always listed, even with nothing in it. Work nobody owns is the
            most likely to be missed, so it needs a box you can tick to go
            looking for it — not one that appears only once there is some. */}
        <Row
          colour="var(--gray-450)"
          label="Unassigned"
          count={counts?.get(UNASSIGNED) || 0}
          checked={checked.includes(UNASSIGNED)}
          onToggle={() => toggle(UNASSIGNED)}
        />
      </div>
    </aside>
  )
}

function Row({ colour, label, count, checked, onToggle }) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '3px 2px', borderRadius: 'var(--radius-sm)',
        cursor: 'pointer', fontSize: 'var(--text-sm)'
      }}
      title={label}
    >
      <Checkbox checked={checked} onChange={onToggle} />
      <span
        aria-hidden
        style={{
          width: 10, height: 10, flex: 'none',
          borderRadius: 2, background: colour
        }}
      />
      <span
        style={{
          flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          color: checked ? 'var(--text-body)' : 'var(--text-faint)'
        }}
      >
        {label}
      </span>
      {/* The count is what makes the list worth reading rather than just
          operating: it says who is busy before you have ticked anything. */}
      {count > 0 && (
        <span
          style={{
            flex: 'none',
            fontSize: 'var(--text-xs)', color: 'var(--text-faint)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {count}
        </span>
      )}
    </label>
  )
}
