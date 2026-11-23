import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppointmentCard from './AppointmentCard'
import { colourFor } from './CalendarSidebar'
import {
  DAY_START_MIN, DAY_END_MIN, boardHeightPx, hourMarks, clampToWindow,
  groupByDay, minutesForDrop, isRealMove, movePatch, PIXELS_PER_MINUTE
} from './boardLayout'
import {
  isoForSlot, minutesNow, dayKeyNow, inZone
} from '../../utils/calendarTime'

// The day and week views — the shape everybody already knows from Google
// Calendar: days across the top, hours down the side, appointments in the
// grid where they fall.
//
// ── HOW THIS DIFFERS FROM THE RESOURCE BOARD ─────────────────────────
//
// Both draw a time grid, and they answer different questions, which is why
// both exist rather than one being a setting on the other:
//
//   this        a column per DAY, everyone's work together. "What is
//               happening this week?" Dragging moves work in TIME.
//   the board   a column per PERSON, one day at a time. "Who should take
//               this?" Dragging sideways moves work between PEOPLE.
//
// So a drop here never changes who owns an appointment. Moving it to
// Thursday should not also reassign it to whoever happens to be in the
// column you dropped on — there is no such person; the column is a day.
//
// ── OVERLAPS MATTER MORE HERE ────────────────────────────────────────
//
// A week column holds every rep's bookings at once, so four people out at
// 10am is the normal case rather than the exception. The lane packing from
// boardLayout puts them abreast; stacked, three of the four would be
// invisible and the day would look quiet.

const HEADER_H = 58
const GUTTER_W = 56

export default function TimeGrid({
  appointments, resources = [], zone, fromDay, days = 7,
  onOpenDeal, onMove, onSetStatus, onBookAt, busyIds
}) {
  const dragging = useRef(null)
  const [hover, setHover] = useState(null)
  // Where the pointer went down, so a click that was really the end of a
  // drag does not open the booking form. Google opens on a plain click and
  // so do we, which only works if the two are told apart.
  const pressedAt = useRef(null)

  const cells = useMemo(() => groupByDay(appointments, zone), [appointments, zone])

  const dayKeys = useMemo(() => {
    const out = []
    for (let i = 0; i < days; i++) out.push(fromDay.add(i, 'day').format('YYYY-MM-DD'))
    return out
  }, [fromDay, days])

  const [nowMin, setNowMin] = useState(() => minutesNow(zone))
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(minutesNow(zone)), 60000)
    return () => window.clearInterval(id)
  }, [zone])
  const todayKey = dayKeyNow(zone)

  const height = boardHeightPx()
  const marks = hourMarks()

  // Open where the work is, not at 07:00.
  //
  // Google scrolls to roughly now, and the reason is the same here: the top
  // of the grid is the hour least likely to hold anything, so a view that
  // opens there spends its first impression on empty space. An hour before
  // now gives a little context behind the current time; outside working
  // hours it falls back to 08:00 rather than parking at midnight-adjacent
  // emptiness.
  const scroller = useRef(null)
  const scrolledOnce = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || scrolledOnce.current) return
    scrolledOnce.current = true
    const anchor = (nowMin > DAY_START_MIN && nowMin < DAY_END_MIN)
      ? nowMin - 60
      : 8 * 60
    el.scrollTop = Math.max(0, (anchor - DAY_START_MIN) * PIXELS_PER_MINUTE)
    // Mount only: re-running would yank the grid back every minute when the
    // now-line ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = useCallback((e, day) => {
    e.preventDefault()
    const drag = dragging.current
    setHover(null)
    if (!drag) return
    dragging.current = null

    const rect = e.currentTarget.getBoundingClientRect()
    const minutes = minutesForDrop(e.clientY - rect.top, drag.grabOffset)
    // THE OWNER IS CARRIED, NOT TAKEN FROM THE COLUMN. See the note above:
    // a column here is a day, not a person, so there is nobody to reassign
    // to. Passing the appointment's own owner means movePatch sees no change
    // and sends only the times.
    const target = { day, minutes, userId: drag.appointment.assignedUserId || null }

    if (!isRealMove(drag.appointment, target, zone)) return
    const patch = movePatch(drag.appointment, target, zone, isoForSlot)
    if (Object.keys(patch).length === 0) return
    onMove?.(drag.appointment, patch, target)
  }, [zone, onMove])

  const colWidth = `calc((100% - ${GUTTER_W}px) / ${days})`

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--surface-card)'
      }}
    >
      {/* Day headings. Sticky so they survive scrolling a tall day. */}
      <div
        style={{
          display: 'flex',
          position: 'sticky', top: 0, zIndex: 3,
          background: 'var(--surface-card)',
          borderBottom: '1px solid var(--border-default)'
        }}
      >
        {/* Lines up with the hour gutter below. */}
        <div style={{ width: GUTTER_W, flex: `0 0 ${GUTTER_W}px` }} />
        {dayKeys.map((day) => {
          const d = inZone(`${day}T12:00:00`, zone)
          const isToday = day === todayKey
          return (
            <div
              key={day}
              style={{
                flex: `0 0 ${colWidth}`, width: colWidth,
                boxSizing: 'border-box',
                height: HEADER_H,
                padding: '6px 4px',
                borderLeft: '1px solid var(--border-default)',
                textAlign: 'center'
              }}
            >
              <div
                style={{
                  fontSize: 'var(--text-xs)',
                  letterSpacing: 'var(--tracking-label)',
                  textTransform: 'uppercase',
                  color: isToday ? 'var(--brand-primary)' : 'var(--text-faint)'
                }}
              >
                {d.format('ddd')}
              </div>
              {/* Today's date in a filled disc, as Google draws it — the one
                  piece of chrome everybody already reads without thinking. */}
              <div
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 26, height: 26, marginTop: 2,
                  borderRadius: 'var(--radius-pill)',
                  background: isToday ? 'var(--brand-primary)' : 'transparent',
                  color: isToday ? '#fff' : 'var(--text-heading)',
                  fontSize: 'var(--text-lg)',
                  fontWeight: isToday ? 'var(--weight-semibold)' : 'var(--weight-regular)'
                }}
              >
                {d.format('D')}
              </div>
            </div>
          )
        })}
      </div>

      {/* THE GRID SCROLLS INSIDE ITSELF, and the day headings above do not.
          
          Thirteen hours at this scale is about 860 pixels, which inside the
          GHL iframe is taller than the viewport — so the grid was being cut
          off at both ends with no way to reach either. Letting the PAGE
          scroll instead would take the day headings away with it, and a week
          grid whose columns are unlabelled is unreadable.

          The height is the viewport less the chrome above it — divided by
          the app zoom, because a viewport unit inside a zoomed body resolves
          in body own coordinate space (see index.css). The floor keeps it
          usable on a short window rather than collapsing to nothing. */}
      <div
        ref={scroller}
        style={{
          display: 'flex', position: 'relative',
          maxHeight: 'max(360px, calc(100vh / var(--app-zoom) - 250px))',
          overflowY: 'auto'
        }}
      >
        <div
          style={{
            width: GUTTER_W, flex: `0 0 ${GUTTER_W}px`,
            position: 'relative', height,
            background: 'var(--surface-page)',
            borderRight: '1px solid var(--border-default)'
          }}
        >
          {marks.map((m) => (
            <div
              key={m.minutes}
              style={{
                position: 'absolute', top: m.top - 7, right: 6,
                fontSize: 'var(--text-xs)', color: 'var(--text-faint)',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {m.label}
            </div>
          ))}
        </div>

        {dayKeys.map((day) => {
          const items = cells.get(day) || []
          const isToday = day === todayKey
          return (
            <div
              key={day}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (hover !== day) setHover(day)
              }}
              onDragLeave={() => setHover((h) => (h === day ? null : h))}
              onDrop={(e) => handleDrop(e, day)}
              onMouseDown={(e) => {
                pressedAt.current = { x: e.clientX, y: e.clientY, target: e.target }
              }}
              onClick={(e) => {
                // A SINGLE click books, the way Google does — but only a real
                // click on empty grid. Two guards, both earned: a click that
                // travelled more than a few pixels was the tail of a drag,
                // and a click that started on a card belongs to the card.
                if (!onBookAt) return
                const down = pressedAt.current
                pressedAt.current = null
                if (!down) return
                if (down.target !== e.currentTarget) return
                if (e.target !== e.currentTarget) return
                const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y)
                if (moved > 4) return
                const rect = e.currentTarget.getBoundingClientRect()
                onBookAt({
                  day,
                  minutes: minutesForDrop(e.clientY - rect.top),
                  userId: null,
                  // Where to spring the card from, so it reads as belonging
                  // to the slot that was clicked rather than to the page.
                  anchor: { x: e.clientX, y: e.clientY }
                })
              }}
              style={{
                flex: `0 0 ${colWidth}`, width: colWidth,
                boxSizing: 'border-box',
                position: 'relative', height,
                borderLeft: '1px solid var(--border-default)',
                background: hover === day
                  ? 'var(--surface-selected)'
                  : (isToday ? 'var(--tint-sky)' : 'var(--surface-card)'),
                cursor: onBookAt ? 'cell' : 'default',
                transition: 'background 90ms linear'
              }}
            >
              {marks.map((m) => (
                <React.Fragment key={m.minutes}>
                  <div
                    style={{
                      position: 'absolute', top: m.top, left: 0, right: 0,
                      borderTop: '1px solid var(--border-default)',
                      pointerEvents: 'none'
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: m.top + 30 * PIXELS_PER_MINUTE,
                      left: 0, right: 0,
                      borderTop: '1px dotted var(--gray-200)',
                      pointerEvents: 'none'
                    }}
                  />
                </React.Fragment>
              ))}

              {isToday && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN && (
                <div
                  aria-hidden
                  style={{
                    position: 'absolute', left: 0, right: 0,
                    top: (nowMin - DAY_START_MIN) * PIXELS_PER_MINUTE,
                    borderTop: '2px solid var(--status-stuck)',
                    pointerEvents: 'none', zIndex: 2
                  }}
                >
                  {/* The dot on the left, as Google has it — it is what makes
                      the line read as "now" rather than as a divider. */}
                  <span
                    style={{
                      position: 'absolute', left: -5, top: -5,
                      width: 9, height: 9, borderRadius: '50%',
                      background: 'var(--status-stuck)'
                    }}
                  />
                </div>
              )}

              {items.map((item) => {
                const geo = clampToWindow(item.startMin, item.endMin)
                return (
                  <AppointmentCard
                    key={item.id}
                    appointment={item}
                    zone={zone}
                    top={geo.top}
                    height={geo.height}
                    clippedBefore={geo.clippedBefore}
                    clippedAfter={geo.clippedAfter}
                    lane={item.lane}
                    lanes={item.lanes}
                    busy={busyIds?.has(item.id)}
                    onOpenDeal={onOpenDeal}
                    onSetStatus={onSetStatus}
                    showOwner
                    accent={colourFor(resources, item.assignedUserId)}
                    onDragStart={(appointment, grabOffset) => {
                      dragging.current = { appointment, grabOffset }
                    }}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
