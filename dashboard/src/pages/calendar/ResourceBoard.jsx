import React, { useCallback, useMemo, useRef, useState } from 'react'
import AppointmentCard from './AppointmentCard'
import {
  DAY_START_MIN, boardHeightPx, hourMarks, clampToWindow,
  groupIntoCells, cellKey, minutesForDrop, isRealMove, movePatch,
  UNASSIGNED, PIXELS_PER_MINUTE
} from './boardLayout'
import { isoForSlot, dayLabel, SNAP_MINUTES } from '../../utils/calendarTime'

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
  onOpenDeal, onMove, onSetStatus, onBookAt, busyIds
}) {
  // What is being dragged, and where it was grabbed. Held in a ref rather
  // than state: it changes during a drag and re-rendering the whole board on
  // every dragover would make the drag stutter.
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
    const cols = resources.map((r) => ({ ...r }))
    const hasUnassigned = appointments.some((a) => !a.assignedUserId)
    if (hasUnassigned) {
      cols.push({
        id: UNASSIGNED,
        name: 'Unassigned',
        assignable: true,
        isUnassigned: true
      })
    }
    return cols
  }, [resources, appointments])

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
    <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
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
              // A heavier rule between days than between people, so a
              // three-day board reads as three days of columns rather than
              // one undifferentiated wall.
              borderLeft: dayIdx > 0 ? '2px solid var(--border-strong)' : 'none'
            }}
          >
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
                      background: col.isUnassigned ? 'var(--tint-gold)' : 'var(--surface-card)',
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
                      {days > 1 ? dayLabel(`${day}T12:00:00`, zone) : `${items.length} booked`}
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
                        userId: col.id === UNASSIGNED ? null : col.id
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
