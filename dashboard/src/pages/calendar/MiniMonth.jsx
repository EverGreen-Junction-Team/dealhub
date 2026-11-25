import React, { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import { monthWeeks } from './boardLayout'
import { dayKeyNow } from '../../utils/calendarTime'

// The month picker in the left rail, as Google Calendar has it.
//
// ── WHY THIS IS THE SIDEBAR'S MOST USEFUL CONTROL ────────────────────
//
// Moving around was the slowest thing on this page. The toolbar gives you
// one step forward, one step back, and a date field — so "the week of the
// 11th" meant either clicking an arrow three times or opening a picker and
// reading a popup. For a dispatcher answering "when is she next free" that
// is the most frequent action there is, and it was the most laborious.
//
// A month you can see is a month you can click. It also answers, without
// being asked, the question the toolbar only answers in words: where the
// days you are looking at sit in the month, and how far today is from them.
//
// ── IT SHOWS THE RANGE, NOT JUST THE DAY ─────────────────────────────
//
// The main grid shows a week, or a month, or one day. Highlighting a single
// date would be a lie in two of those three cases — you would click Monday
// the 9th, see the whole week appear, and the picker would still be
// claiming you were looking at one day. So the whole visible span is
// shaded and its first day carries the marker.
//
// ── AND IT FOLLOWS, RATHER THAN LEADS ────────────────────────────────
//
// The month on display tracks whatever the main view moves to, so stepping
// forward past the end of a month carries the picker with it. But it can
// also be paged on its own to look ahead without disturbing the board —
// browsing is not navigating, and a picker that jumped the whole page every
// time you looked at next month would be unusable for planning.

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export default function MiniMonth({ value, span, zone, onPick }) {
  // The month being BROWSED, which is usually but not always the month the
  // board is on. See the note above.
  const [cursor, setCursor] = useState(() => value.startOf('month'))

  // Follow the board when it moves to another month. Keyed on the month, not
  // the day, so stepping from Monday to Tuesday does not reset a rep who has
  // paged ahead to look at December.
  const monthKey = value.format('YYYY-MM')
  useEffect(() => { setCursor(value.startOf('month')) }, [monthKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const weeks = useMemo(() => monthWeeks(cursor), [cursor])
  const todayKey = dayKeyNow(zone)

  // Every day the board is currently showing, as a set. Built from the same
  // `span` the grid is drawn from, so the two cannot disagree about what is
  // on screen.
  const shown = useMemo(() => {
    const out = new Set()
    // NO BAND FOR A MONTH. In Month view the span is six whole weeks —
    // every cell in this picker — so the band turned the entire control
    // green and said nothing. A band is worth drawing only when it picks
    // out part of what is shown; the picker's own title already says
    // which month.
    if (!span || span.days > 7) return out
    for (let i = 0; i < span.days; i++) {
      out.add(span.from.add(i, 'day').format('YYYY-MM-DD'))
    }
    return out
  }, [span])

  // The ends of the visible range, so the band can be capped like a pill
  // rather than stopping square as though it had been cut off.
  const firstKey = span ? span.from.format('YYYY-MM-DD') : null
  const lastKey = span ? span.from.add(span.days - 1, 'day').format('YYYY-MM-DD') : null

  const thisMonth = cursor.format('YYYY-MM')

  return (
    // No bottom margin: the rail is a grid and owns the gap between its
    // sections. A margin here would stack on top of that gap and make the
    // month sit further from CALENDARS than CALENDARS sits from PEOPLE.
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 4
        }}
      >
        <div
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-heading)'
          }}
        >
          {cursor.format('MMMM YYYY')}
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <Step label="Previous month" onClick={() => setCursor((c) => c.subtract(1, 'month'))}><LeftOutlined /></Step>
          <Step label="Next month" onClick={() => setCursor((c) => c.add(1, 'month'))}><RightOutlined /></Step>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {WEEKDAYS.map((d, i) => (
          <div
            key={i}
            aria-hidden
            style={{
              textAlign: 'center',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-faint)',
              lineHeight: '18px'
            }}
          >
            {d}
          </div>
        ))}

        {weeks.flat().map((day) => {
          const d = dayjs(day)
          const outside = d.format('YYYY-MM') !== thisMonth
          const isToday = day === todayKey
          const isShown = shown.has(day)
          return (
            <button
              key={day}
              type="button"
              onClick={() => onPick(d)}
              aria-current={isToday ? 'date' : undefined}
              title={d.format('dddd D MMMM YYYY')}
              style={{
                // ── TWO JOBS, TWO ELEMENTS ─────────────────────────
                //
                // The band and the disc were both painted on this one
                // button, and they fought. `background` was set for the
                // span and then overwritten for today, so the one day
                // that is almost always INSIDE the visible week was the
                // one day that lost the week's tint — a white hole in
                // the middle of the band. And `borderRadius: 50%` on a
                // cell wider than it is tall is an ellipse, not a disc,
                // so white showed at its corners too.
                //
                // Now the button carries the BAND, square and full-cell
                // so it meets its neighbours with no seam, and the span
                // inside carries the DISC at a fixed square size. They
                // cannot overwrite each other because they are no
                // longer the same declaration.
                border: 'none',
                padding: 0,
                height: 28,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                background: isShown ? 'var(--tint-pine)' : 'transparent',
                // Capped at the ends, square in the middle: a range with
                // rounded ends reads as one run of days, where a square
                // stripe reads as a stripe that ran out of room.
                borderTopLeftRadius: isShown && day === firstKey ? 999 : 0,
                borderBottomLeftRadius: isShown && day === firstKey ? 999 : 0,
                borderTopRightRadius: isShown && day === lastKey ? 999 : 0,
                borderBottomRightRadius: isShown && day === lastKey ? 999 : 0,
                color: outside
                  // Days from the neighbouring month are reachable —
                  // clicking the 1st of next month should work — but
                  // they are context, so they recede.
                  ? 'var(--text-faint)'
                  : 'var(--text-body)',
                fontWeight: isToday || isShown
                  ? 'var(--weight-semibold)'
                  : 'var(--weight-regular)'
              }}
            >
              <span
                style={{
                  // A real circle: square box, so 50% is a circle at any
                  // column width. The cell is wider than this and the
                  // band shows around it, which is the point.
                  width: 24, height: 24,
                  display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center',
                  borderRadius: '50%',
                  background: isToday ? 'var(--brand-primary)' : 'transparent',
                  color: isToday ? '#fff' : 'inherit'
                }}
              >
                {d.date()}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Step({ children, label, onClick }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        // 28px: a 20px target holding a guillemet was the smallest
        // control on the page and the one used most.
        width: 28, height: 28, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'none',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-muted)',
        fontSize: 12, lineHeight: 1,
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
