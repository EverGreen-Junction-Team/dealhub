import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Popover } from 'antd'
import AppointmentDetail from './AppointmentDetail'
import { monthWeeks, groupByDay, movePatch, isLong, longSpan } from './boardLayout'
import { colourFor } from './CalendarSidebar'
import {
  isoForSlot, minutesFromMidnight, dayKeyNow, clockTime, inZone, dayKey
} from '../../utils/calendarTime'

// The month view.
//
// ── IT IS NOT A SMALL WEEK VIEW ──────────────────────────────────────
//
// A month cell is about 90 pixels tall. At the week view's scale that is
// twenty minutes of one day, so there is no room to place anything by time —
// and no point: nobody reads a month grid to find out whether something is
// at 9am or 9:30. They read it to find which DAY has the thing on it.
//
// So a month cell is a LIST, in time order, with the time as text. The grid
// answers "which day", you click through to a day for "what time".
//
// ── WHAT A DRAG MEANS HERE ───────────────────────────────────────────
//
// Dropping on a day moves the appointment to that day AT THE SAME TIME.
// There is no vertical position to read a new time from, and inventing one
// — 9am, say — would silently reschedule a 2pm survey to the morning
// because somebody dragged it one square right. Keeping the clock time is
// the only reading that cannot surprise anyone.

// How many fit before the cell has to say "+N more". Four lines plus the
// date is about all 90px holds without the row growing and pushing the
// weeks below it off screen.
const MAX_PER_CELL = 4

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function MonthGrid({
  appointments, zone, fromDay,
  // For the chip dots. Defaulted, because a caller that has not loaded
  // the rep list yet should get grey dots rather than no month view.
  resources = [],
  onOpenDeal, onMove, onBookAt, onOpenDay, busyIds,
  // The slot the open booking card is aiming at. A month cell has no
  // vertical position to place it at, so it is a chip at the top of the
  // day rather than a block — which is also where it would sit once
  // saved, since the cell lists by time.
  draft,
  // How tall the month may be. The six weeks SHARE it, so the grid fills
  // the window the way Google's does instead of stopping two-thirds of the
  // way down and leaving a band of nothing. Each week keeps its 116px
  // floor; on a window too short for that, the month scrolls inside.
  height = null
}) {
  const dragging = useRef(null)
  const [hover, setHover] = useState(null)

  const weeks = useMemo(() => monthWeeks(fromDay), [fromDay])
  // A days-long booking is listed on EVERY day it covers, not only its
  // first — a month answers "which days is she out", and a six-day job
  // that showed on one square answered it wrong.
  const cells = useMemo(() => {
    const m = groupByDay(appointments, zone)
    const keys = weeks.flat()
    for (const a of appointments.filter(isLong)) {
      const span = longSpan(a, keys, zone)
      if (!span) continue
      const startKey = dayKey(a.startsAt, zone)
      for (let i = span.from; i <= span.to; i++) {
        if (keys[i] === startKey) continue
        if (!m.has(keys[i])) m.set(keys[i], [])
        m.get(keys[i]).unshift(a)
      }
    }
    return m
  }, [appointments, zone, weeks])
  const todayKey = dayKeyNow(zone)
  const thisMonth = fromDay.format('YYYY-MM')

  const handleDrop = useCallback((e, day) => {
    e.preventDefault()
    const drag = dragging.current
    setHover(null)
    if (!drag) return
    dragging.current = null

    const a = drag.appointment
    // Same time of day, different date — see the note above.
    const minutes = minutesFromMidnight(a.startsAt, zone)
    const target = { day, minutes, userId: a.assignedUserId || null }
    const patch = movePatch(a, target, zone, isoForSlot)
    if (Object.keys(patch).length === 0) return
    onMove?.(a, patch, target)
  }, [zone, onMove])

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-card)',
        ...(height
          ? { height, display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden' }
          : { overflow: 'hidden' })
      }}
    >
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-default)' }}>
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            style={{
              flex: 1, textAlign: 'center', padding: '6px 0',
              fontSize: 'var(--text-xs)',
              letterSpacing: 'var(--tracking-label)',
              textTransform: 'uppercase',
              color: 'var(--text-faint)'
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week) => (
        <div
          key={week[0]}
          style={{
            display: 'flex', borderBottom: '1px solid var(--border-default)',
            // Shares the height equally with the other weeks.
            flex: height ? '1 0 auto' : undefined
          }}
        >
          {week.map((day) => {
            const items = cells.get(day) || []
            const d = inZone(`${day}T12:00:00`, zone)
            const isToday = day === todayKey
            // Days either side of the month are real and may hold work — a
            // survey on the 1st should be visible from the previous month's
            // last row — but they are dimmed so the month still reads as a
            // month.
            const outside = d.format('YYYY-MM') !== thisMonth
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
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  // 9am, because a month cell has no time in it to read. The
                  // form opens with it filled in and the rep changes it —
                  // better than refusing to open at all, which is what a
                  // month grid with no click target amounts to.
                  onBookAt?.({
                    day,
                    minutes: 9 * 60,
                    userId: null,
                    anchor: { x: e.clientX, y: e.clientY }
                  })
                }}
                style={{
                  // Tall enough for the date plus MAX_PER_CELL rows at the
                  // calendar's text size — 96 fitted four rows of the old
                  // 12px type and clipped the fourth once it went up.
                  flex: 1, minWidth: 0, minHeight: 116,
                  boxSizing: 'border-box',
                  padding: '4px 5px',
                  borderLeft: '1px solid var(--border-default)',
                  // One white surface here too. The neighbouring month's
                  // days were shaded, which made five of the thirty-five
                  // cells a different colour from the rest; their DATE is
                  // already dimmed, which says the same thing without
                  // putting the cards on two different grounds.
                  background: hover === day
                    ? 'var(--surface-selected)'
                    : 'var(--surface-card)',
                  cursor: onBookAt ? 'cell' : 'default'
                }}
              >
                <div
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 22, height: 22, marginBottom: 2,
                    borderRadius: 'var(--radius-pill)',
                    background: isToday ? 'var(--brand-primary)' : 'transparent',
                    color: isToday
                      ? '#fff'
                      : (outside ? 'var(--text-faint)' : 'var(--text-heading)'),
                    fontSize: 'var(--text-sm)',
                    fontWeight: isToday ? 'var(--weight-semibold)' : 'var(--weight-regular)'
                  }}
                >
                  {d.format('D')}
                </div>

                {draft && draft.day === day && (
                  <div
                    aria-hidden
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      margin: '1px 0',
                      padding: '1px 5px',
                      border: '1px dashed var(--brand-primary)',
                      borderRadius: 'var(--radius-pill)',
                      background: 'var(--tint-pine)',
                      color: 'var(--accent-pine-text)',
                      fontSize: 'var(--text-xs)',
                      whiteSpace: 'nowrap', overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {/* Dashed, like the day view's block, because it is the
                        same unsaved thing and must not be counted as work
                        by anyone glancing at the month. */}
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {String(Math.floor(draft.minutes / 60)).padStart(2, '0')}
                      :{String(draft.minutes % 60).padStart(2, '0')}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {draft.title?.trim() || '(No title)'}
                    </span>
                  </div>
                )}

                {items.slice(0, MAX_PER_CELL).map((a) => (
                  <MonthChip
                    key={a.id}
                    appointment={a}
                    zone={zone}
                    busy={busyIds?.has(a.id)}
                    accent={colourFor(resources, a.assignedUserId)}
                    onOpenDeal={onOpenDeal}
                    onDragStart={(appointment) => { dragging.current = { appointment } }}
                  />
                ))}

                {items.length > MAX_PER_CELL && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpenDay?.(day) }}
                    style={{
                      display: 'block', width: '100%',
                      border: 'none', background: 'none',
                      padding: '1px 2px', textAlign: 'left',
                      fontSize: 'var(--text-xs)', color: 'var(--text-link)',
                      cursor: 'pointer'
                    }}
                  >
                    +{items.length - MAX_PER_CELL} more
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// One appointment as a line in a month cell.
//
// A single line, because four of these plus the date is what the cell holds.
// The time leads: in a month view the time is the only thing distinguishing
// two visits to the same customer, and it is what you are scanning for once
// you have found the day.
function MonthChip({ appointment: a, zone, busy, onOpenDeal, onDragStart, accent }) {
  const isBlocked = a.kind === 'blocked'
  const status = (a.status || '').toLowerCase()
  const cancelled = status === 'cancelled'
  const label = isBlocked
    ? (a.title || 'Blocked')
    : (a.contactName || a.title || 'Appointment')


  return (
    <Popover
      content={<AppointmentDetail appointment={a} zone={zone} accent={accent} />}
      trigger="hover"
      mouseEnterDelay={0.4}
      rootClassName="pp-portal"
      styles={{ body: { padding: 'var(--space-4)' } }}
    >
      <div
        className={!isBlocked && !cancelled ? 'pp-appt-chip' : undefined}
        draggable={!isBlocked && !busy}
        onDragStart={(e) => {
          if (isBlocked || busy) return
          onDragStart?.(a)
          e.dataTransfer.setData('text/plain', a.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (!isBlocked && a.dealId) onOpenDeal?.(a.dealId)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '1px 4px', marginBottom: 1,
          borderRadius: 'var(--radius-sm)',
          // Same rule as the day view's card, at half strength: a booked
          // slot is washed in its own accent, blocked time stays grey,
          // and a cancelled one stays plain because nobody is coming.
          // Four chips stack in one 116px cell, so 10% rather than 14%
          // — at full strength the cell became a block of colour whose
          // shape said nothing.
          '--pp-accent': accent || 'var(--accent-teal)',
          background: isBlocked
            ? 'var(--gray-100)'
            : (cancelled ? 'transparent' : undefined),
          color: 'var(--text-body)',
          fontSize: 'var(--text-xs)',
          lineHeight: 1.5,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          opacity: busy ? 0.55 : 1,
          cursor: isBlocked ? 'default' : 'grab',
          textDecoration: cancelled ? 'line-through' : 'none'
        }}
      >
        {/* The dot IS the colour coding now. Six pixels of the person's
            hue, in the one place on a single-line chip where a colour can
            sit without competing with the words beside it. */}
        {!isBlocked && (
          <span
            aria-hidden
            style={{
              flex: 'none', width: 6, height: 6, borderRadius: '50%',
              background: accent || 'var(--accent-teal)'
            }}
          />
        )}
        <span style={{ fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
          {clockTime(a.startsAt, zone)}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      </div>
    </Popover>
  )
}
