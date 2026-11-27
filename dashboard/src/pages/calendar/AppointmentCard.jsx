import React, { useState } from 'react'
import { Popover, Dropdown } from 'antd'
import AppointmentDetail from './AppointmentDetail'
import { clockTime, inZone } from '../../utils/calendarTime'
import { offsetY } from './pointer'
import { BLOCKED_HATCH, hasCalendarColour } from './calendarColours'

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
  // Opens the deal-and-records dialog (AppointmentLinks) for this booking.
  onOpenLinks,
  // Week and day views mix every rep together, so the card has to say
  // WHOSE it is. On the resource board the column already says that, and
  // repeating it on every card would be noise.
  showOwner = false,
  // The CALENDAR's colour (calendarColours.js), for the fill and the bar
  // down the left edge — on every view. Status is never lost: cancelled is
  // struck through, no-show says the word, blocked is hatched grey.
  accent = null
}) {
  const a = appointment
  // A START MARKER for a days-long appointment (see longStartPiece): a
  // half-hour card at its start time, standing in for the whole thing.
  // Everything that acts or reports — the menu, the hover card, the deal —
  // uses the WHOLE appointment; only the card's own geometry is the piece.
  const whole = a._whole || a
  const isPiece = whole !== a
  const isBlocked = a.kind === 'blocked'
  const status = (a.status || '').toLowerCase()
  const style = isBlocked
    ? BLOCKED_STYLE
    : (STATUS_STYLE[status] || UNKNOWN_STYLE)
  const cancelled = status === 'cancelled'
  // Blocked time takes its calendar's colour too (its person's Personal
  // calendar, usually) and keeps its stripes; grey only with no calendar.
  const tinted = !cancelled && (!isBlocked || hasCalendarColour(accent))

  // Lanes share the column's width; see boardLayout.assignLanes for why this
  // is computed per overlap group rather than per column.
  const widthPct = 100 / lanes
  const leftPct = widthPct * lane


  // Blocked time is not a booking and must not pretend to be one: no
  // customer, no deal, and — crucially — it cannot be dragged. GHL's
  // appointment endpoints do not own blocked slots, so a drag would produce
  // a refusal from the server with nothing the rep could do about it.
  const draggable = !isBlocked && !busy && !isPiece

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
  // The hover card stands aside while the menu is open. Found live: both
  // opened from the same pointer position and drew on top of each other,
  // the menu's "Cancel this appointment" over the card's own status line.
  const [menuOpen, setMenuOpen] = useState(false)

  const statusActions = []
  if (!isBlocked && onSetStatus) {
    if (cancelled) {
      statusActions.push({
        key: 'confirmed',
        label: 'Reinstate',
        onClick: () => onSetStatus(whole, 'confirmed')
      })
    } else {
      statusActions.push({
        key: 'cancelled',
        label: 'Cancel this appointment',
        danger: true,
        onClick: () => onSetStatus(whole, 'cancelled')
      })
      // Outcomes, which are what make the board worth reading back. A
      // no-show recorded on the day is a fact; reconstructed a week later
      // it is a guess.
      // Not the one it already is. "Mark as attended" on an attended
      // booking was offered on the live board; it does nothing but write.
      if (status !== 'showed') {
        statusActions.push({
          key: 'showed', label: 'Mark as attended', onClick: () => onSetStatus(whole, 'showed')
        })
      }
      if (status !== 'noshow') {
        statusActions.push({
          key: 'noshow', label: 'Mark as a no-show', onClick: () => onSetStatus(whole, 'noshow')
        })
      }
    }
  }

  // The links come FIRST in the menu: they are the everyday action, and the
  // status changes below them include the one destructive item, which is
  // safer at the bottom than under the pointer when the menu opens.
  const menuActions = []
  if (!isBlocked && onOpenLinks) {
    menuActions.push({
      key: 'links',
      label: whole.dealId ? 'Change deal or records…' : 'Link a deal or record…',
      onClick: () => onOpenLinks(whole)
    })
  }
  if (menuActions.length && statusActions.length) menuActions.push({ type: 'divider', key: 'div' })
  menuActions.push(...statusActions)

  return (
    <Popover
      open={menuOpen ? false : undefined}
      // A light card, not a dark tooltip — see AppointmentDetail for why.
      // rootClassName because it portals to <body>, outside [data-dealhub],
      // where none of the type or colour tokens exist without it.
      content={<AppointmentDetail appointment={whole} zone={zone} accent={accent} clippedBefore={clippedBefore} clippedAfter={clippedAfter} />}
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
          onDragStart?.(a, offsetY(e, e.currentTarget))
          // Required for Firefox to start a drag at all.
          e.dataTransfer.setData('text/plain', a.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        className={tinted ? 'pp-appt' : undefined}
        // Its hover card shows the full text — no native title on top.
        data-noclip=""
        onClick={(e) => {
          // Only a click ON the card. A click in something portalled from
          // inside it (the ⋯ menu) still bubbles here through React's tree,
          // though it is nowhere near the card on screen.
          if (!e.currentTarget.contains(e.target)) return
          if (!isBlocked && a.dealId) onOpenDeal?.(a.dealId)
        }}
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
          // HUE means which calendar. Status is carried by things that are not hue,
          // which was always the rule in this file: cancelled is struck
          // through, no-show says the word, blocked is hatched. Roughly
          // one man in twelve cannot separate the red-green pair a
          // status palette leans on, so status was never safe in colour
          // alone.
          //
          // WHAT THIS COSTS, stated rather than discovered later:
          // `confirmed` and `showed` do not differ at a glance. They
          // differ in the tooltip and nowhere else.

          // The one colour, and the only place it is chosen: the
          // booking's CALENDAR, on every view. Without one (no calendar
          // list) it falls back to the status.
          '--pp-accent': accent || style.bar,

          // Blocked time is washed in its calendar's colour like a
          // booking — asked for: the team reads the diary by colour — and
          // keeps its hatching and the word "Blocked", so it is never
          // counted as work. With no calendar it stays grey.
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
          background: tinted
            ? undefined
            : (isBlocked ? style.tint : 'var(--surface-card)'),
          border: '1px solid var(--border-strong, var(--gray-200))',
          borderLeftWidth: 4,
          borderLeftStyle: 'solid',
          borderLeftColor: isBlocked && !tinted ? style.bar : (accent || style.bar),
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
          backgroundImage: isBlocked ? BLOCKED_HATCH : undefined,
          boxSizing: 'border-box',
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-snug)',
          color: 'var(--text-body)'
        }}
      >
        {menuActions.some((x) => x.onClick) && !busy && (
          <Dropdown
            trigger={['click']}
            onOpenChange={setMenuOpen}
            menu={{ items: menuActions.map(({ onClick, ...rest }) => rest),
                    onClick: ({ key, domEvent }) => {
                      // The menu is portalled to <body>, but React bubbles
                      // through PORTALS along the component tree — so this
                      // click reached the card's own onClick and opened the
                      // deal page over whatever the item was meant to do.
                      // Found live: "Change deal or records…" navigated to
                      // the deal instead of opening the dialog.
                      domEvent?.stopPropagation()
                      menuActions.find((x) => x.key === key)?.onClick?.()
                    } }}
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
          {clippedBefore ? '↑ ' : ''}
          {/* The end marker leads with when it ENDS — "10:30" on the last
              day would read as a fresh start. */}
          {a._edge === 'end' ? `until ${clockTime(whole.endsAt, zone)}` : clockTime(a.startsAt, zone)} {label}
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
              : isPiece
                ? (a._edge === 'daily'
                    ? `Daily until ${inZone(whole.endsAt, zone).format('ddd D MMM')}`
                    : a._edge === 'end'
                    ? `from ${inZone(whole.startsAt, zone).format('ddd D MMM, HH:mm')}`
                    : `until ${inZone(whole.endsAt, zone).format('ddd D MMM, HH:mm')}`)
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
