import React from 'react'
import { Tooltip } from 'antd'
import { clockTime, zoneNote } from '../../utils/calendarTime'
import { formatMoney } from '../../utils/money'

// One booking on the board.
//
// ── WHAT A CARD HAS TO SAY, IN ABOUT 60 PIXELS ───────────────────────
//
// The board is read at a glance, so the card shows only what a dispatcher
// scans for — time, who it is with, which job — and puts everything else in
// the tooltip. A card that tries to show all of it becomes a wall of grey
// text in which nothing stands out, which defeats the point of a board.
//
// ── COLOUR CARRIES THE STATUS, BUT NEVER ALONE ───────────────────────
//
// Status is the thing you want to see without reading: a cancelled visit
// still occupying Tuesday afternoon is the whole reason the slot looks busy
// and is not. So each status has its own tint.
//
// It is never ONLY colour, though. Cancelled is struck through as well as
// greyed, and no-show carries a word. Roughly one man in twelve cannot
// reliably separate the red-green pair this palette would otherwise lean
// on, and "which of these is cancelled" is not a question to answer with
// hue alone.

// The status palette, mapped onto the app's own accent tokens rather than
// raw colours, so the board stays in step with the rest of Deal Hub.
const STATUS_STYLE = {
  confirmed: { tint: 'var(--tint-teal)', bar: 'var(--accent-teal)', text: 'var(--accent-teal-text)' },
  showed: { tint: 'var(--tint-pine)', bar: 'var(--accent-pine)', text: 'var(--accent-pine-text)' },
  noshow: { tint: 'var(--tint-clay)', bar: 'var(--accent-clay)', text: 'var(--accent-clay-text)' },
  cancelled: { tint: 'var(--tint-gray)', bar: 'var(--gray-400)', text: 'var(--text-muted)' },
  invalid: { tint: 'var(--tint-gray)', bar: 'var(--gray-400)', text: 'var(--text-muted)' }
}

// An unrecognised status is NOT an error and must not be swallowed.
//
// GHL does not publish the set, so a value we have not seen is a value that
// exists — migration 143 stores it verbatim for exactly this reason. It gets
// the neutral tint and shows its own name, which is more useful than
// pretending it is confirmed.
const UNKNOWN_STYLE = { tint: 'var(--tint-sky)', bar: 'var(--accent-sky)', text: 'var(--accent-sky-text)' }

const BLOCKED_STYLE = { tint: 'var(--gray-100)', bar: 'var(--gray-450)', text: 'var(--text-muted)' }

export default function AppointmentCard({
  appointment, zone, top, height, lane, lanes,
  clippedBefore, clippedAfter,
  onOpenDeal, onDragStart, busy
}) {
  const a = appointment
  const isBlocked = a.kind === 'blocked'
  const status = (a.status || '').toLowerCase()
  const style = isBlocked
    ? BLOCKED_STYLE
    : (STATUS_STYLE[status] || UNKNOWN_STYLE)
  const cancelled = status === 'cancelled'

  // Lanes share the column's width; see boardLayout.assignLanes for why this
  // is computed per overlap group rather than per column.
  const widthPct = 100 / lanes
  const leftPct = widthPct * lane

  const otherZone = zoneNote(a.timezone, zone)

  // Blocked time is not a booking and must not pretend to be one: no
  // customer, no deal, and — crucially — it cannot be dragged. GHL's
  // appointment endpoints do not own blocked slots, so a drag would produce
  // a refusal from the server with nothing the rep could do about it.
  const draggable = !isBlocked && !busy

  const label = isBlocked
    ? (a.title || 'Blocked')
    : (a.contactName || a.title || 'Appointment')

  const tip = (
    <div style={{ display: 'grid', gap: 4, fontSize: 'var(--text-sm)' }}>
      <strong>{label}</strong>
      <span>
        {clockTime(a.startsAt, zone)}
        {a.endsAt ? `–${clockTime(a.endsAt, zone)}` : ''}
        {otherZone ? ` · booked in ${otherZone}` : ''}
      </span>
      {a.title && a.title !== label && <span>{a.title}</span>}
      {!isBlocked && (
        a.dealName
          ? (
            <span>
              {a.dealName}
              {a.dealValue != null ? ` · ${formatMoney(a.dealValue, a.dealCurrency)}` : ''}
            </span>
          )
          // Shown, not hidden. NULL is the common and correct state when the
          // customer has more than one open deal and the server declined to
          // guess — see migration 143. Leaving the line out would read as
          // "this booking has no job", which is a different claim.
          : <span style={{ opacity: 0.75 }}>No deal linked</span>
      )}
      {a.address && <span style={{ opacity: 0.75 }}>{a.address}</span>}
      {a.status && !isBlocked && <span style={{ opacity: 0.75 }}>Status: {a.status}</span>}
      {clippedBefore && <span style={{ opacity: 0.75 }}>Starts before the board's first hour</span>}
      {clippedAfter && <span style={{ opacity: 0.75 }}>Runs past the board's last hour</span>}
      {!isBlocked && a.dealId && <span style={{ opacity: 0.75 }}>Click to open the deal</span>}
    </div>
  )

  return (
    <Tooltip title={tip} mouseEnterDelay={0.35} placement="right">
      <div
        draggable={draggable}
        onDragStart={(e) => {
          if (!draggable) return
          // Where in the card the pointer took hold. Without this the card
          // jumps so its top edge lands under the cursor, which silently
          // moves a booking grabbed by its middle half an hour earlier.
          const rect = e.currentTarget.getBoundingClientRect()
          onDragStart?.(a, e.clientY - rect.top)
          // Required for Firefox to start a drag at all.
          e.dataTransfer.setData('text/plain', a.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => { if (!isBlocked && a.dealId) onOpenDeal?.(a.dealId) }}
        role={!isBlocked && a.dealId ? 'button' : undefined}
        tabIndex={!isBlocked && a.dealId ? 0 : undefined}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && a.dealId && !isBlocked) {
            e.preventDefault()
            onOpenDeal?.(a.dealId)
          }
        }}
        style={{
          position: 'absolute',
          top, height,
          left: `calc(${leftPct}% + 2px)`,
          width: `calc(${widthPct}% - 4px)`,
          background: style.tint,
          // The status bar down the left edge. Doing the colour work here
          // rather than tinting the whole card keeps the text legible.
          borderLeft: `3px solid ${style.bar}`,
          border: '1px solid var(--border-default)',
          borderLeftWidth: 3,
          borderLeftColor: style.bar,
          borderRadius: 'var(--radius-sm)',
          padding: '3px 6px',
          overflow: 'hidden',
          cursor: draggable ? 'grab' : (isBlocked ? 'default' : 'pointer'),
          // A write is in flight for this card; it is still readable but
          // cannot be grabbed again until the server answers.
          opacity: busy ? 0.55 : 1,
          // Blocked time reads as a surface, not an item — it is the absence
          // of availability rather than a thing on the schedule.
          backgroundImage: isBlocked
            ? 'repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(0,0,0,0.045) 5px, rgba(0,0,0,0.045) 10px)'
            : undefined,
          boxSizing: 'border-box',
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-snug)',
          color: 'var(--text-body)'
        }}
      >
        <div
          style={{
            fontWeight: 'var(--weight-semibold)',
            color: style.text,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            // Never colour alone: a cancelled visit is struck through too.
            textDecoration: cancelled ? 'line-through' : 'none'
          }}
        >
          {clippedBefore ? '↑ ' : ''}{clockTime(a.startsAt, zone)} {label}
        </div>
        {/* The second line only survives on a card tall enough to show it. */}
        {height > 34 && (
          <div
            style={{
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >
            {isBlocked
              ? 'Blocked'
              : (a.dealName || (status === 'noshow' ? 'No-show' : 'No deal'))}
            {clippedAfter ? ' ↓' : ''}
          </div>
        )}
      </div>
    </Tooltip>
  )
}
