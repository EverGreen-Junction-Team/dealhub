import React from 'react'
import { Popover, Dropdown } from 'antd'
import AppointmentDetail from './AppointmentDetail'
import { clockTime } from '../../utils/calendarTime'

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
  onOpenDeal, onDragStart, onSetStatus, busy,
  // Week and day views mix every rep together, so the card has to say
  // WHOSE it is. On the resource board the column already says that, and
  // repeating it on every card would be noise.
  showOwner = false,
  // The PERSON's colour, for the bar down the left edge. Only the time views
  // pass it: there, every rep's work is mixed into one column per day, and
  // the colour is what lets you read whose is whose without squinting at
  // names four cards abreast. On the resource board the column already says
  // whose it is, so the bar keeps showing STATUS instead.
  //
  // Status is never lost either way — it is the tint, and cancelled is also
  // struck through. The bar is the only thing this changes.
  accent = null
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


  // Blocked time is not a booking and must not pretend to be one: no
  // customer, no deal, and — crucially — it cannot be dragged. GHL's
  // appointment endpoints do not own blocked slots, so a drag would produce
  // a refusal from the server with nothing the rep could do about it.
  const draggable = !isBlocked && !busy

  const label = isBlocked
    ? (a.title || 'Blocked')
    : (a.contactName || a.title || 'Appointment')

  // Cancelling and reinstating, behind a menu rather than an always-visible
  // button.
  //
  // CANCELLING, NOT DELETING. A cancelled appointment keeps its slot in the
  // diary and its link to the deal — it is the record that somebody was
  // going to visit on Tuesday and then did not, which is exactly what a
  // sales operation wants to be able to count. Deleting it would make the
  // afternoon look like it was always free. Deletion exists on the API for
  // the genuine mistake, and is deliberately not offered here.
  //
  // Reinstating is offered because cancelling is one click and people
  // misclick. Without it the only way back is the CRM.
  const statusActions = []
  if (!isBlocked && onSetStatus) {
    if (cancelled) {
      statusActions.push({
        key: 'confirmed',
        label: 'Reinstate',
        onClick: () => onSetStatus(a, 'confirmed')
      })
    } else {
      statusActions.push({
        key: 'cancelled',
        label: 'Cancel this appointment',
        danger: true,
        onClick: () => onSetStatus(a, 'cancelled')
      })
      // Outcomes, which are what make the board worth reading back. A
      // no-show recorded on the day is a fact; reconstructed a week later
      // it is a guess.
      statusActions.push({
        key: 'showed', label: 'Mark as attended', onClick: () => onSetStatus(a, 'showed')
      })
      statusActions.push({
        key: 'noshow', label: 'Mark as a no-show', onClick: () => onSetStatus(a, 'noshow')
      })
    }
  }

  return (
    <Popover
      // A light card, not a dark tooltip — see AppointmentDetail for why.
      // rootClassName because it portals to <body>, outside [data-dealhub],
      // where none of the type or colour tokens exist without it.
      content={<AppointmentDetail appointment={a} zone={zone} accent={accent} clippedBefore={clippedBefore} clippedAfter={clippedAfter} />}
      trigger="hover"
      mouseEnterDelay={0.35}
      placement="right"
      rootClassName="pp-portal"
      styles={{ body: { padding: 'var(--space-4)' } }}
    >
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
        className={!isBlocked && !cancelled ? 'pp-appt' : undefined}
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
          // ── ONE COLOUR, TWO STRENGTHS ──────────────────────────
          //
          // The card used to carry two unrelated colours: the fill said
          // what STATUS the booking was in, the bar said WHOSE it was.
          // The status tints are hues of their own, so a purple bar on a
          // teal fill had no relationship to it and read as a rendering
          // fault before it read as two facts.
          //
          // Making the card white fixed that and broke something else: a
          // white card on a white grid is barely an object, and a week
          // with work in it read as an empty week. So a BOOKED slot is
          // filled again — with a wash of its own bar, set from the one
          // --pp-accent below, so the fill and the edge are the same
          // colour at two strengths and cannot drift apart.
          //
          // Colour therefore means "somebody is booked here", and its
          // HUE means who. Status is carried by things that are not hue,
          // which was always the rule in this file: cancelled is struck
          // through, no-show says the word, blocked is hatched. Roughly
          // one man in twelve cannot separate the red-green pair a
          // status palette leans on, so status was never safe in colour
          // alone.
          //
          // WHAT THIS COSTS, stated rather than discovered later:
          // `confirmed` and `showed` do not differ at a glance. They
          // differ in the tooltip and nowhere else.

          // The one colour, and the only place it is chosen. On the time
          // views it is the PERSON: their work is mixed into one column
          // per day, and the hue is what separates it. On the resource
          // board the column already says whose it is, so it falls back
          // to the status.
          '--pp-accent': accent || style.bar,

          // Blocked time keeps its grey and its hatching — it is the
          // absence of availability, not a booking, and must not be
          // counted as work by anyone glancing at the week.
          //
          // CANCELLED IS NOT COLOURED EITHER, and that is the point of
          // the rule above: the slot is still spoken for, which is why
          // it still occupies Tuesday afternoon, but nobody is coming.
          // A pale card that is struck through says both. Leaving it
          // tinted would have made a dead afternoon look booked, which
          // is the exact question a dispatcher opens this view to ask.
          //
          // Anything else is a live booking and gets its wash from the
          // .pp-appt class, which is why background is left unset here:
          // an inline background would beat the class.
          background: isBlocked
            ? style.tint
            : (cancelled ? 'var(--surface-card)' : undefined),
          border: '1px solid var(--border-strong, var(--gray-200))',
          borderLeftWidth: 4,
          borderLeftStyle: 'solid',
          borderLeftColor: isBlocked ? style.bar : (accent || style.bar),
          boxShadow: 'var(--shadow-xs, 0 1px 1px rgba(23, 33, 46, 0.06))',
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
        {statusActions.length > 0 && !busy && (
          <Dropdown
            trigger={['click']}
            menu={{ items: statusActions.map(({ onClick, ...rest }) => rest),
                    onClick: ({ key }) => statusActions.find((x) => x.key === key)?.onClick() }}
          >
            <button
              type="button"
              aria-label="Appointment actions"
              // Stops the card's own click opening the deal underneath the
              // menu, and stops a click on the button starting a drag.
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              draggable={false}
              className="pp-appt-menu"
              style={{
                position: 'absolute', top: 1, right: 1, zIndex: 1,
                width: 18, height: 18, padding: 0,
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: 'rgba(255,255,255,0.78)',
                color: 'var(--text-muted)',
                cursor: 'pointer', lineHeight: '16px', fontSize: 13
              }}
            >
              ⋯
            </button>
          </Dropdown>
        )}
        <div
          style={{
            fontWeight: 'var(--weight-semibold)',
            // Neutral, not the status accent. On a white card a coloured
            // heading would put the patchwork straight back: seven
            // statuses, seven heading colours, and the one colour the
            // card is allowed is the bar.
            color: cancelled ? 'var(--text-muted)' : 'var(--text-heading)',
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
              // Body, not muted, now that the card has a fill behind it.
              // --text-muted is 4.69:1 on plain white — a pass with
              // nothing to spare — and every one of the nine accent
              // washes takes it under 4.5, to 4.12 at the worst.
              // --text-body is 9.57 at the worst on the same fills.
              color: 'var(--text-body)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >
            {isBlocked
              ? 'Blocked'
              : (showOwner
                ? (a.assignedUserName || 'Unassigned')
                : (a.dealName || (status === 'noshow' ? 'No-show' : 'No deal')))}
            {clippedAfter ? ' ↓' : ''}
          </div>
        )}
      </div>
    </Popover>
  )
}
