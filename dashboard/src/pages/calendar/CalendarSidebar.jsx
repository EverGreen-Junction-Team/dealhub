import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Tooltip } from 'antd'
import { UNASSIGNED } from './boardLayout'
import MiniMonth from './MiniMonth'

// The calendar list, as Google Calendar's left rail: CALENDARS first, then
// PEOPLE, a checkbox each, tick what you want to see.
//
// ── WHY BOTH, AND WHY CALENDARS FIRST ────────────────────────────────
//
// They cut the same appointments two different ways and you need both.
// A calendar is the KIND of thing — a survey calendar, a service
// calendar, somebody's personal diary — and it carries the working hours
// and the timezone. A person is who is going. "Show me the service
// calendar" and "show me Brad's week" are both real questions, and
// neither answers the other.
//
// Calendars lead because that is the coarser cut: on this account the
// personal diaries carry almost nothing and one service calendar carries
// the work, so it is the first thing worth narrowing by.
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

export default function CalendarSidebar({
  resources, selected, onChange, counts,
  calendars = [], selectedCalendars, onChangeCalendars, calendarCounts,
  // The month picker at the top. Optional so a caller that has no notion
  // of a current day — there is none today, but the sidebar should not
  // require one — still renders.
  day, span, zone, onPickDay,
  // Where to stick, measured by the caller from the toolbar above. See the
  // note there: this used to be a hand-added 118 that went stale every
  // time the bar changed height.
  stickyTop = 118,
  // How tall the rail may be. With ten calendars and twelve people it is
  // taller than the window, and a sticky element taller than the window
  // pushes the PAGE into scrolling — which slid the month's own title and
  // the grid's day headings up under the toolbar. Bounded, it scrolls
  // inside itself and the page never moves.
  maxHeight = null
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

  // The same null-means-everything rule as people, for the same reason.
  const allCalendars = useMemo(() => calendars.map((c) => c.id), [calendars])
  const calsAreAll = selectedCalendars == null
  const calsChecked = calsAreAll ? allCalendars : selectedCalendars

  const toggleCalendar = (id) => {
    const next = calsChecked.includes(id)
      ? calsChecked.filter((x) => x !== id)
      : [...calsChecked, id]
    onChangeCalendars(next.length === allCalendars.length ? null : next)
  }

  return (
    <aside
      style={{
        // 196 fitted the two checkbox lists; seven day columns need more,
        // and at 196 the mini-month's cells came out under 24px — below a
        // comfortable click target, with the numbers crowding their own
        // highlight. 256 buys back what the truncation was eating: at 224
        // every calendar whose name carries the owner ("Vault Suite
        // Vaultsuite's P…", "Marketing London's Pers…") ellipsised in the
        // same place, so the rows that needed telling apart were the ones
        // cut at the same word.
        width: 256, flex: '0 0 256px',
        // CLIPS. A calendar called "Vault Suite Vaultsuite's Personal
        // Calendar" is wider than this box, and without this it was drawn
        // straight across the border and over the grid beside it.
        // border-box, so maxHeight includes the padding. Content-box made
        // the rail 36px taller than its bound — enough to scroll the page.
        boxSizing: 'border-box',
        overflowX: 'hidden',
        overflowY: maxHeight ? 'auto' : 'hidden',
        ...(maxHeight ? { maxHeight } : {}),
        // Room for the scrollbar so it does not sit on the counts.
        scrollbarGutter: 'stable',
        alignSelf: 'flex-start',
        // Below the sticky toolbar, not under it: anything sticking at a
        // smaller offset slides behind it and the top of this list
        // disappears while you scroll. The offset is measured by the
        // caller rather than guessed — see stickyTop.
        position: 'sticky', top: stickyTop,
        // NOT A CARD. It was a bordered, rounded white box floating on
        // the page grey; with the page white it would have been a box
        // outlined on the same colour it contains, which is the worst of
        // both. Google's rail is part of the sheet and separated from the
        // grid by a single rule — so that is what this is now.
        borderRight: '1px solid var(--border-default)',
        background: 'var(--surface-card)',
        padding: 'var(--space-3) var(--space-4) var(--space-5) 0',

        // ── THE RAIL OWNS ITS OWN RHYTHM ───────────────────────────
        //
        // The three sections ran together: the month ended and CALENDARS
        // began 16px later, which at that type size reads as one list
        // with headings in it rather than as three separate controls.
        //
        // A grid gap rather than a margin on each piece, because margins
        // here were being set in three different files — the month set
        // its own bottom margin, the calendar list set another, and the
        // people list set none — so the gaps were never going to agree.
        // One gap, declared once, and the sections cannot drift.
        display: 'grid',
        gap: 'var(--space-5)',
        alignContent: 'start'
      }}
    >
      {/* FIRST, above the filters. The rail answers two questions and they
          are not equal: "when am I looking at" comes before "what am I
          looking at", because you pick the week and then narrow it. It is
          also the control used most, so it goes where the eye lands. */}
      {day && onPickDay && (
        <MiniMonth value={day} span={span} zone={zone} onPick={onPickDay} />
      )}

      {calendars.length > 0 && (
        <div style={{ minWidth: 0 }}>
          <SectionHead
            label="Calendars"
            action={calsAreAll ? 'None' : 'All'}
            onAction={() => onChangeCalendars(calsAreAll ? [] : null)}
          />
          <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
            {calendars.map((c) => {
              const { label, tag } = calendarLabel(c.name)
              return (
                <Row
                  key={c.id}
                  // Calendars get no colour swatch. The card colours are the
                  // PERSON's, and a second colour system on the same cards
                  // would be two keys for one picture.
                  label={label}
                  tag={tag}
                  fullName={c.name}
                  count={calendarCounts?.get(c.id) || 0}
                  checked={calsChecked.includes(c.id)}
                  onToggle={() => toggleCalendar(c.id)}
                />
              )
            })}
          </div>
        </div>
      )}

      <div style={{ minWidth: 0 }}>
        <SectionHead
          label="People"
          action={isAll ? 'None' : 'All'}
          onAction={() => onChange(isAll ? [] : null)}
        />

        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
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

          {/* Always listed, even with nothing in it. Work nobody owns is
              the most likely to be missed, so it needs a box you can tick
              to go looking for it — not one that appears only once there
              is some. */}
          <Row
            colour="var(--gray-450)"
            label="Unassigned"
            count={counts?.get(UNASSIGNED) || 0}
            checked={checked.includes(UNASSIGNED)}
            onToggle={() => toggle(UNASSIGNED)}
          />
        </div>
      </div>
    </aside>
  )
}

/**
 * Is this element's text actually cut off?
 *
 * ── WHY MEASURE RATHER THAN ALWAYS SHOW A TOOLTIP ────────────────────
 *
 * A tooltip repeating text you can already read is noise, and it trains
 * people to ignore the ones that matter. Most calendar names fit; two on
 * this account do not. Only those two should pop.
 *
 * Measured, not guessed from a character count — the sidebar is a fixed 196
 * pixels but the font is not, and the app renders at 85% zoom, so no string
 * length maps reliably to "too wide".
 *
 * Re-measured on resize as well as on the text changing. This is the same
 * test ListChrome's Truncate uses; what differs is the presentation. Truncate
 * sets a native `title`, which is the browser's small pale box after a
 * second's delay. antd's Tooltip is the dark pill that Google shows, which is
 * what was asked for and is easier to read over a busy grid.
 */
function useClipped(dep) {
  const ref = useRef(null)
  const [clipped, setClipped] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dep])

  return [ref, clipped]
}

function SectionHead({ label, action, onAction }) {
  return (
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
        {label}
      </h3>
      <button
        type="button"
        onClick={onAction}
        style={{
          // A real target. "All" is three letters at 13px — about 14px
          // wide — and a click 7px to its left missed it on the live
          // board. Padding grows the target; the negative margin keeps it
          // where it was drawn.
          border: 'none', background: 'none',
          padding: '4px 8px', margin: '-4px -8px',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-xs)', color: 'var(--text-link)',
          cursor: 'pointer'
        }}
      >
        {action}
      </button>
    </div>
  )
}

// ── "Charlie Stoyle's Personal Calendar" ───────────────────────────────
//
// GHL names every user's own calendar this way, so a sub-account with ten
// users has ten rows that all END in the same two words — and at the rail's
// width the ellipsis lands on exactly those words, so every row read
// "Somebody's Personal Cal…". The part that tells them apart survived and
// the part that is identical took the room.
//
// So the owner is the label and "Personal" is a quiet tag after it. The
// full name is still the hover title, and still what is searched and
// filtered on — this only changes how the row is drawn.
const PERSONAL = /^(.+?)['’]s personal calendar$/i
export function calendarLabel(name) {
  const m = PERSONAL.exec((name || '').trim())
  return m ? { label: m[1].trim(), tag: 'Personal' } : { label: name || 'Untitled calendar', tag: null }
}

function Row({ colour, label, tag = null, fullName = null, count, checked, onToggle }) {
  const [textRef, clipped] = useClipped(label)
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        // minWidth 0 IS THE FIX, and it is not optional.
        //
        // This row is a grid item, and a grid item's min-width defaults to
        // `auto` — meaning "at least as wide as my content". So the ellipsis
        // on the label below could never take effect: the row simply grew to
        // fit the longest calendar name and pushed it through the sidebar's
        // edge. The label was already set up to truncate; it was never given
        // the chance.
        minWidth: 0,
        padding: '3px 2px', borderRadius: 'var(--radius-sm)',
        cursor: 'pointer', fontSize: 'var(--text-sm)'
      }}
    >
      <Checkbox checked={checked} onChange={onToggle} />
      {colour && (
        <span
          aria-hidden
          style={{
            width: 10, height: 10, flex: 'none',
            borderRadius: 2, background: colour
          }}
        />
      )}
      {/* `title` is null when the text fits, and antd renders no tooltip at
          all for a null title — so the measurement is the whole switch. */}
      <Tooltip title={clipped || tag ? (fullName || label) : null} mouseEnterDelay={0.3} placement="right">
        <span
          ref={textRef}
          style={{
            flex: 1, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            color: checked ? 'var(--text-body)' : 'var(--text-faint)'
          }}
        >
          {label}
        </span>
      </Tooltip>
      {tag && (
        <span
          style={{
            flex: 'none',
            padding: '0 6px', borderRadius: 'var(--radius-pill)',
            background: 'var(--gray-100)',
            fontSize: 'var(--text-xs)', color: 'var(--text-muted)',
            lineHeight: '18px'
          }}
        >
          {tag}
        </span>
      )}
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
