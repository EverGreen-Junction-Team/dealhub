import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppointmentCard from './AppointmentCard'
import DraftSlot from './DraftSlot'
import { useElementScrollMemory } from '../../hooks/useScrollMemory'
import {
  DAY_START_MIN, DAY_END_MIN, boardHeightPx, hourMarks, clampToWindow,
  groupIntoCells, cellKey, minutesForDrop, isRealMove, movePatch,
  UNASSIGNED, PIXELS_PER_MINUTE
} from './boardLayout'
import {
  isoForSlot, dayLabel, minutesNow, dayKeyNow, SNAP_MINUTES
} from '../../utils/calendarTime'

// The board: a column per person, read down the day.
//
// This is option B from the decision brief. The difference from a shared
// week is not cosmetic — a shared calendar answers "what is booked", and a
// board with a column each answers "who should take this", which is the
// question a dispatcher is actually asking. Moving work between people is
// therefore the primary gesture here, not an afterthought: you drag sideways.
//
// ── LAYOUT ───────────────────────────────────────────────────────────
//
// A sticky hour gutter down the left, then one column per person, repeated
// per day when more than one day is shown. The grid is absolute-positioned
// inside each column rather than built from CSS grid rows, because
// appointments overlap and a row-based grid cannot express two things in the
// same half hour side by side.
//
// ── THE UNASSIGNED COLUMN ────────────────────────────────────────────
//
// Always last, always present when something is in it. An appointment nobody
// owns is the one most likely to be missed, so it gets a column rather than
// being filtered out of view — and being a column means it can be dragged
// out of, which is how it stops being unassigned.

function dayList(from, days) {
  const out = []
  for (let i = 0; i < days; i++) {
    out.push(from.add(i, 'day').format('YYYY-MM-DD'))
  }
  return out
}

export default function ResourceBoard({
  appointments, resources, zone, fromDay, days = 1,
  onOpenDeal, onMove, onSetStatus, onBookAt, busyIds,
  hideEmpty = false,
  // The slot the open booking card is aiming at. Here it also has to land
  // in the right PERSON's column — booking from this board picks the
  // person by which column you clicked, so a draft in the wrong one would
  // misreport the only thing this view exists to show.
  draft
}) {
  // What is being dragged, and where it was grabbed. Held in a ref rather
  // than state: it changes during a drag and re-rendering the whole board on
  // every dragover would make the drag stutter.
  // A twelve-column board is mostly off-screen. Scrolling across to find a
  // rep and then opening a deal should not send you back to the first column.
  const boardScroll = useElementScrollMemory('calendar', 'board')

  const dragging = useRef(null)
  // The cell the pointer is currently over, which IS state — it is the drop
  // highlight, and the rep needs to see where the card will land.
  const [hover, setHover] = useState(null)

  const cells = useMemo(() => groupIntoCells(appointments, zone), [appointments, zone])
  const dayKeys = useMemo(() => dayList(fromDay, days), [fromDay, days])

  // Columns: everyone assignable, then anyone holding work who is not.
  //
  // The unassigned column is appended only when something is actually in it.
  // An empty column permanently taking up width would be noise on a board
  // that is usually fully assigned.
  const columns = useMemo(() => {
    // Who actually has something in this window.
    //
    // WHY THIS MATTERS MORE THAN IT SOUNDS. The column list is "every active
    // account user", and a real sub-account's user list is not a list of
    // surveyors — it is the surveyors PLUS the marketing logins, the
    // enquiries inbox and whatever integrations have accounts. One live
    // account draws twelve columns, of which perhaps three ever take an
    // appointment. At three days that is thirty-six columns of nothing, and
    // the two bookings you came to look at are somewhere off-screen.
    const busy = new Set(
      appointments.map((a) => a.assignedUserId).filter(Boolean)
    )

    let cols = resources.map((r) => ({ ...r, hasWork: busy.has(r.id) }))

    if (hideEmpty) {
      const kept = cols.filter((c) => c.hasWork)
      // Never hide EVERYTHING. On a genuinely empty day the board's remaining
      // job is to be booked into, and a board with no columns cannot be —
      // there is nowhere to double-click. So an empty result falls back to
      // showing everyone, which is also the honest answer to "who is free".
      cols = kept.length > 0 ? kept : cols
    }

    const hasUnassigned = appointments.some((a) => !a.assignedUserId)
    if (hasUnassigned) {
      cols.push({
        id: UNASSIGNED,
        name: 'Unassigned',
        assignable: true,
        isUnassigned: true,
        hasWork: true
      })
    }
    return cols
  }, [resources, appointments, hideEmpty])

  // The red line across today. A day board without one makes you read the
  // gutter to answer "what is next", which is the question you opened it for.
  // Minute precision is pointless here and would re-render every second; a
  // minute is finer than the 15-minute grid anyone books on.
  const [nowMin, setNowMin] = useState(() => minutesNow(zone))
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(minutesNow(zone)), 60000)
    return () => window.clearInterval(id)
  }, [zone])
  const todayKey = dayKeyNow(zone)

  const height = boardHeightPx()
  const marks = hourMarks()

  const handleDrop = useCallback((e, day, userId) => {
    e.preventDefault()
    const drag = dragging.current
    setHover(null)
    if (!drag) return
    dragging.current = null

    const rect = e.currentTarget.getBoundingClientRect()
    const minutes = minutesForDrop(e.clientY - rect.top, drag.grabOffset)
    const target = {
      day,
      minutes,
      userId: userId === UNASSIGNED ? null : userId
    }

    // A click the browser reported as a one-pixel drag, or a card put back
    // where it came from, must not become a write. On a board that is a lot
    // of pointless PUTs — and each one is a chance to notify a customer if
    // that ever gets switched on.
    if (!isRealMove(drag.appointment, target, zone)) return

    const patch = movePatch(drag.appointment, target, zone, isoForSlot)
    if (Object.keys(patch).length === 0) return
    onMove?.(drag.appointment, patch, target)
  }, [zone, onMove])

  return (
    <div ref={boardScroll} style={{ overflowX: 'auto', overflowY: 'visible' }}>
      <div style={{ display: 'flex', minWidth: 'fit-content' }}>
        {/* The hour gutter. Sticky, so the times stay readable when a board
            with eight reps is scrolled sideways. */}
        <div
          style={{
            position: 'sticky', left: 0, zIndex: 3,
            width: 52, flex: '0 0 52px',
            background: 'var(--surface-page)',
            borderRight: '1px solid var(--border-default)'
          }}
        >
          <div style={{ height: HEADER_H, borderBottom: '1px solid var(--border-default)' }} />
          <div style={{ position: 'relative', height }}>
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
        </div>

        {dayKeys.map((day, dayIdx) => (
          <div
            key={day}
            style={{
              display: 'flex',
              flexDirection: days > 1 ? 'column' : 'row',
              // A heavier rule between days than between people, so a
              // three-day board reads as three days of columns rather than
              // one undifferentiated wall.
              borderLeft: dayIdx > 0 ? '2px solid var(--border-strong)' : 'none'
            }}
          >
            {/* One heading per DAY, above that day's people — rather than the
                date repeated under every column, which is where it was. */}
            {days > 1 && (
              <div
                style={{
                  position: 'sticky', top: 0, zIndex: 4,
                  padding: '5px 10px',
                  background: day === todayKey ? 'var(--tint-teal)' : 'var(--surface-sunken)',
                  borderBottom: '1px solid var(--border-default)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--weight-semibold)',
                  color: 'var(--text-heading)',
                  whiteSpace: 'nowrap'
                }}
              >
                {dayLabel(`${day}T12:00:00`, zone)}
                {day === todayKey && (
                  <span style={{ marginLeft: 6, color: 'var(--accent-teal-text)' }}>· today</span>
                )}
              </div>
            )}
            <div style={{ display: 'flex' }}>
            {columns.map((col) => {
              const key = cellKey(day, col.id === UNASSIGNED ? null : col.id)
              const items = cells.get(key) || []
              const isHover = hover === key
              return (
                <div
                  key={col.id}
                  style={{
                    width: COLUMN_W, flex: `0 0 ${COLUMN_W}px`,
                    borderRight: '1px solid var(--border-default)'
                  }}
                >
                  {/* Column head: who, and what day when more than one is
                      shown. Sticky downwards so it survives page scroll. */}
                  <div
                    style={{
                      height: HEADER_H, boxSizing: 'border-box',
                      position: 'sticky', top: 0, zIndex: 2,
                      background: col.isUnassigned
                        ? 'var(--tint-gold)'
                        : (day === todayKey ? 'var(--tint-teal)' : 'var(--surface-card)'),
                      borderBottom: '1px solid var(--border-default)',
                      padding: '4px 8px',
                      display: 'flex', flexDirection: 'column', justifyContent: 'center'
                    }}
                  >
                    <div
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 'var(--weight-semibold)',
                        color: 'var(--text-heading)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}
                      title={col.name}
                    >
                      {col.name}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                      {/* The count, always — it was replaced by the date on a
                          multi-day board, which put the same date under all
                          twelve of that day's columns and told you nothing
                          you could not see from the day heading. */}
                      {items.length === 0
                        ? 'Free'
                        : `${items.length} booked`}
                    </div>
                  </div>

                  <div
                    onDragOver={(e) => {
                      // A column that cannot take new work still shows its
                      // own — it just refuses the drop. A departed rep's
                      // Tuesday is visible and read-only.
                      if (!col.assignable) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (hover !== key) setHover(key)
                    }}
                    onDragLeave={() => setHover((h) => (h === key ? null : h))}
                    onDrop={(e) => col.assignable && handleDrop(e, day, col.id)}
                    // Double-click, not single.
                    //
                    // A single click is what a consumer calendar uses, and on
                    // a board that is also a drop target it is too easy to
                    // fire by accident — a drag released a pixel from where
                    // it started reads as a click, and a modal opening
                    // mid-gesture is the kind of thing that makes people stop
                    // dragging. The toolbar's Book button is the discoverable
                    // path; this is the fast one, and it prefills the time and
                    // the person from where the rep clicked.
                    onDoubleClick={(e) => {
                      if (!col.assignable || !onBookAt) return
                      // Only empty space. A double-click on a card is a
                      // double-click on the deal it opens, not a request to
                      // book something on top of it.
                      if (e.target !== e.currentTarget) return
                      const rect = e.currentTarget.getBoundingClientRect()
                      onBookAt({
                        day,
                        minutes: minutesForDrop(e.clientY - rect.top),
                        userId: col.id === UNASSIGNED ? null : col.id,
                        anchor: { x: e.clientX, y: e.clientY }
                      })
                    }}
                    style={{
                      position: 'relative', height,
                      background: isHover ? 'var(--surface-selected)' : 'var(--surface-card)',
                      transition: 'background 90ms linear'
                    }}
                  >
                    {/* Hour rules. Half-hour lines are drawn lighter —
                        without them a 30-minute booking has nothing to sit
                        against and every card looks approximately placed. */}
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

                    {/* Now. Drawn per column rather than once across the
                        board because each day group is its own scroll box;
                        one absolutely-positioned line could not span them. */}
                    {day === todayKey
                      && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN && (
                      <div
                        aria-hidden
                        style={{
                          position: 'absolute', left: 0, right: 0,
                          top: (nowMin - DAY_START_MIN) * PIXELS_PER_MINUTE,
                          borderTop: '2px solid var(--status-stuck)',
                          pointerEvents: 'none',
                          zIndex: 1
                        }}
                      />
                    )}

                    {draft
                      && draft.day === day
                      && (draft.userId || UNASSIGNED) === col.id
                      && (() => {
                        const start = draft.minutes
                        const end = start + (draft.duration || 30)
                        const geo = clampToWindow(start, end)
                        return (
                          <DraftSlot
                            top={geo.top}
                            height={geo.height}
                            startMin={start}
                            endMin={end}
                            title={draft.title}
                          />
                        )
                      })()}

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
                          onDragStart={(appointment, grabOffset) => {
                            dragging.current = { appointment, grabOffset }
                          }}
                        />
                      )
                    })}
                  </div>
                </div>
              )
            })}
            </div>
          </div>
        ))}
      </div>

      <p
        style={{
          margin: 'var(--space-3) 0 0',
          fontSize: 'var(--text-xs)', color: 'var(--text-faint)'
        }}
      >
        Drag a card down its column to change the time, or across to give it to
        someone else. Double-click an empty slot to book there, and use a
        card's ⋯ menu to cancel it or record the outcome. Times snap to
        {' '}{SNAP_MINUTES} minutes. The board shows
        {' '}{String(Math.floor(DAY_START_MIN / 60)).padStart(2, '0')}:00 onwards —
        anything earlier is pinned to the top and marked ↑. Customers are not
        emailed when you move an appointment.
      </p>
    </div>
  )
}

const COLUMN_W = 172
const HEADER_H = 44
