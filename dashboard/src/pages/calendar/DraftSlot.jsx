import React from 'react'

// Minutes from midnight as a clock time.
//
// Formatted here rather than through calendarTime's clockTime, which takes
// an ISO instant: this block has no instant, only a position on the grid
// that the rep is still moving. Building an ISO just to format it would
// mean choosing a timezone for something that has not been given one yet.
const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// The block that appears on the grid while the booking card is open.
//
// ── WHY AN UNSAVED THING IS DRAWN AS IF IT WERE SAVED ────────────────
//
// Google does this and it is not decoration. The booking card is anchored
// near where you clicked, which tells you roughly where — but "roughly" is
// not good enough on a grid where 15 minutes is 20 pixels. The draft block
// is the only thing that answers "is this the slot I meant?" in the terms
// the question was asked in: against the hour lines, next to the work
// already there, the right width in the right column.
//
// It also answers a question the card cannot. Change the time in the card
// and the block moves, so you see the collision BEFORE you save — the
// appointment it would sit on top of is right there, and the card alone
// would have let you book straight over it and find out afterwards.
//
// ── WHY IT LOOKS UNFINISHED ON PURPOSE ───────────────────────────────
//
// Dashed, not solid; translucent, not filled. A draft that looked exactly
// like a booking would be a lie on the one screen whose entire job is
// saying what is actually booked — and somebody glancing at a colleague's
// screen must not count it. Google uses a solid block for this; that works
// there because an unsaved Google event is one click from existing, while
// this one is a write to somebody else's CRM that can still be refused.
//
// Never interactive: pointerEvents none, so the click that would reach the
// grid underneath still does, and a drag over it is unaffected.

// `colour`: the calendar chosen in the booking card, so the slot previews in
// the colour it will be saved in. Brand green until one is chosen.
export default function DraftSlot({ top, height, startMin, endMin, title, colour = null }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top, height,
        left: 2, right: 2,
        boxSizing: 'border-box',
        border: `2px dashed ${colour || 'var(--brand-primary)'}`,
        borderRadius: 'var(--radius-sm)',
        background: colour ? `color-mix(in srgb, ${colour} 18%, #fff)` : 'var(--tint-pine)',
        // Above the booked work — it is what you are looking at right now —
        // but below the now-line, which should never be hidden.
        zIndex: 1,
        opacity: 0.92,
        padding: '3px 6px',
        overflow: 'hidden',
        pointerEvents: 'none',
        fontSize: 'var(--text-xs)',
        lineHeight: 'var(--leading-snug)',
        color: colour ? 'var(--text-heading)' : 'var(--accent-pine-text)'
      }}
    >
      <div
        style={{
          fontWeight: 'var(--weight-semibold)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}
      >
        {/* Mirrors the title as it is typed. "(No title)" is Google's
            wording and the right one: the block is already obviously a
            new thing, being dashed and the only one of its kind on the
            grid, so the caption's job is the title — and when there is
            none, saying so is shorter and truer than naming the form. */}
        {title?.trim() || '(No title)'}
      </div>
      {/* The times, because the block's own edges are only accurate to the
          nearest few pixels and the question being asked is exact. */}
      {height >= 28 && (
        <div style={{ opacity: 0.85 }}>
          {hhmm(startMin)} – {hhmm(endMin)}
        </div>
      )}
    </div>
  )
}
