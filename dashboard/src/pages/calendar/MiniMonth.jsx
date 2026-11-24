import React, { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
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
    if (!span) return out
    for (let i = 0; i < span.days; i++) {
      out.add(span.from.add(i, 'day').format('YYYY-MM-DD'))
    }
    return out
  }, [span])

  const thisMonth = cursor.format('YYYY-MM')

  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
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
          <Step label="Previous month" onClick={() => setCursor((c) => c.subtract(1, 'month'))}>‹</Step>
          <Step label="Next month" onClick={() => setCursor((c) => c.add(1, 'month'))}>›</Step>
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
                border: 'none',
                padding: 0,
                height: 24,
                cursor: 'pointer',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                // THE SPAN, not the single day. A week view highlighting one
                // date would contradict the seven columns beside it.
                background: isShown ? 'var(--tint-pine)' : 'transparent',
                // Today is a filled disc, the same mark the grid's own day
                // headings use — one idiom for "today" across the tab.
                borderRadius: isToday ? '50%' : 0,
                ...(isToday
                  ? { background: 'var(--brand-primary)', color: '#fff' }
                  : {
                      color: outside
                        // Days from the neighbouring month are reachable —
                        // clicking the 1st of next month should work — but
                        // they are context, so they recede.
                        ? 'var(--text-faint)'
                        : 'var(--text-body)'
                    }),
                fontWeight: isToday || isShown
                  ? 'var(--weight-semibold)'
                  : 'var(--weight-regular)'
              }}
            >
              {d.date()}
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
        width: 20, height: 20, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'none',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-muted)',
        fontSize: 'var(--text-md)', lineHeight: 1,
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
