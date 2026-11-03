import React from 'react'
import { Truncate } from '../shared/ListChrome'

// The bordered field boxes inside the deal card (client design, Oct 2026).
//
// Three places wanted the same shape — the customer's details, the deal's own
// name, and the stage facts (owner, days in stage, last contact, source):
//
//   ┌─ CUSTOMER · Alex Morgan ──────────────┐   <- a tinted strip
//   │ ⬚ FIRST NAME   │ ⬚ SECOND NAME        │   <- cells, 1px apart
//   │   Alex      ✎  │   Morgan        ✎    │
//   └────────────────┴───────────────────────┘
//
// Previously these were bare label-над-value pairs on the card's own white, so
// nine of them read as one undifferentiated block. The border is what makes
// "the customer's record" a thing you can see the edges of.
//
// THE 1px GAPS ARE THE BACKGROUND SHOWING THROUGH, not borders on the cells.
// Nine cells each drawing their own 1px line would double up where they meet
// and leave a 2px seam down the middle of the grid.

// "Not set", as a chip rather than an em dash.
//
// A dash is a character in the same grey as a real value, so a gap in the
// deal's record reads as something that was filled in. The design gives it a
// pale amber chip instead — the colour the app already uses for "needs
// attention", and unmistakably not a value someone typed.
//
// Verified AA for normal text: #8f6808 on #faf3e0 is 4.57:1 light, 4.51:1
// dark. Both are thin margins, so neither token should be lightened without
// recomputing.
export function NotSet() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      height: 22, padding: '0 9px',
      borderRadius: 'var(--radius-sm)',
      // SOFTENED (Oct 2026, client feedback: "looks very bright"). Still the
      // amber family, so an empty field reads as a gap worth filling, but a
      // half-strength border, a paler fill and regular weight — on a card
      // with four empty fields the old full-strength chips outshouted the
      // values that WERE set.
      border: '1px solid color-mix(in srgb, var(--accent-gold) 40%, transparent)',
      background: 'color-mix(in srgb, var(--tint-gold) 55%, #fff)',
      color: 'var(--accent-gold-text)',
      fontSize: 'var(--text-sm)', fontWeight: 500,
      whiteSpace: 'nowrap'
    }}>
      Not set
    </span>
  )
}

export function FieldCard({ icon, label, value, action, children, style }) {
  return (
    <div
      style={{
        border: '1px solid var(--gray-200)',
        borderRadius: 'var(--radius-sm)',
        background: '#fff',
        overflow: 'hidden',
        ...style
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px',
          background: 'var(--gray-25)',
          borderBottom: '1px solid var(--gray-200)'
        }}
      >
        {icon && (
          <span className="ms" style={{ fontSize: 16, color: 'var(--text-muted)', flex: 'none' }}>
            {icon}
          </span>
        )}
        <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
        {value != null && value !== '' && (
          <Truncate style={{
            fontSize: 'var(--text-base)', fontWeight: 600,
            color: 'var(--text-heading)', marginLeft: 4, minWidth: 0
          }}>
            {value}
          </Truncate>
        )}
        {action && <span style={{ marginLeft: 'auto', flex: 'none' }}>{action}</span>}
      </div>
      {children}
    </div>
  )
}

// The grid the cells sit in. `background` is the gap colour — see the note
// above about why the cells themselves draw no borders.
export function FieldGrid({ children, columns = 2, style }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 1,
        background: 'var(--gray-200)',
        ...style
      }}
    >
      {children}
    </div>
  )
}

// One cell: an icon, its label, and the value with an optional edit affordance.
export function FieldCell({ icon, label, value, onEdit, editTitle, tone, title }) {
  const empty = value == null || value === ''
  return (
    <div style={{ minWidth: 0, padding: '8px 12px', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        {icon && (
          <span className="ms" style={{ fontSize: 15, color: 'var(--text-muted)', flex: 'none' }}>
            {icon}
          </span>
        )}
        <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        {/* An em dash, not a blank: an empty row and a row whose value is
            missing look identical otherwise, and a gap in the customer's
            record is the thing a rep is meant to notice. */}
        {/* `tone` carries a warning the value itself cannot say — a last
            contact date is just a date until you know it is two weeks old.
            The title explains it in words, since colour alone is not a
            message a screen reader relays. */}
        <Truncate title={title} style={{
          fontSize: 'var(--text-base)', lineHeight: 1.35,
          fontWeight: tone === 'danger' ? 600 : 400,
          color: tone === 'danger'
            ? 'var(--status-stuck-text)'
            : (empty ? 'var(--text-faint)' : 'var(--text-body)')
        }}>
          {empty ? '—' : value}
        </Truncate>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title={editTitle || `Edit ${String(label).toLowerCase()}`}
            aria-label={editTitle || `Edit ${String(label).toLowerCase()}`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flex: 'none', width: 20, height: 20, padding: 0,
              border: 'none', background: 'none',
              color: 'var(--text-muted)', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 15 }}>edit</span>
          </button>
        )}
      </div>
    </div>
  )
}

// A field as a FULL-WIDTH ROW: tinted label column, value, edit affordance.
//
//   ┌──────────────┬────────────────────────────┬────┐
//   │ ✉ EMAIL      │ alex.morgan@example.com    │ ✎  │
//   └──────────────┴────────────────────────────┴────┘
//
// FieldCell stacks its label ABOVE the value, which suits the deal card's
// two-column grid where each cell is ~150px wide. A person card is the full
// width of its column, and at that width a stacked pair wastes the right two
// thirds of every row — so the label moves beside the value and takes a tint
// to hold the eye at the left edge.
//
// Same empty-value contract as FieldCell: an em dash, never a blank, because
// a gap in a contact's record is the thing a rep needs to notice.
// `control` replaces the value slot with an interactive element — the deal
// rail's custom fields are pickers, not text. The label still comes from the
// row's tinted column, so the control must not draw a label of its own;
// FieldPicker has a `bare` mode for exactly that.
export function FieldRow({
  icon, label, value, onEdit, editTitle, last, notSet = false, control,
  // Same contract as FieldCell: `tone` carries a warning the value cannot
  // say on its own, `title` puts it in words for a screen reader.
  tone, title
}) {
  const empty = value == null || value === ''
  return (
    <div
      style={{
        display: 'grid',
        // The label column is FIXED so every row's value starts at the same
        // x — ragged left edges down four rows read as a broken table.
        //
        // WIDER THAN IT WAS (150 → 190). "Last customer contact" and "First
        // contact method" both wrap at 150px, and while wrapping is fine, it
        // was wrapping further than it needed to.
        gridTemplateColumns: 'minmax(132px, 190px) minmax(0, 1fr) auto',
        // STRETCH, NOT CENTRE.
        //
        // `center` sizes each cell to its own content, so a label that wraps
        // to two lines made the tinted cell TALLER than the value beside it —
        // and the tint and the right-hand divider stopped short of the row's
        // full height, leaving a ragged step. Stretching makes every cell the
        // row's height; the centring that `center` was for now happens inside
        // each cell, where it only affects the text.
        alignItems: 'stretch',
        borderBottom: last ? 'none' : '1px solid var(--gray-200)'
      }}
    >
      <span style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '9px 12px', minWidth: 0,
        background: 'var(--gray-25)',
        borderRight: '1px solid var(--gray-200)'
      }}>
        {icon && (
          <span className="ms" style={{ fontSize: 15, color: 'var(--text-muted)', flex: 'none' }}>
            {icon}
          </span>
        )}
        <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      </span>

      {/* `notSet` is opt-in: the Deal rail takes the chip, People keeps the
          dash. Both say "nothing here", but the chip also says "and that is
          worth fixing" — true of a deal's product type, not of a contact's
          middle name. */}
      {control
        ? (
          <span style={{
            display: 'flex', alignItems: 'center',
            padding: '5px 12px', minWidth: 0
          }}>
            {control}
          </span>
        )
        : (
          /* The centring sits on a WRAPPER, not on the Truncate itself:
             text-overflow: ellipsis needs a block container, and making the
             truncating element a flex box silently disables the clipping it
             exists for. */
          <span style={{
            display: 'flex', alignItems: 'center',
            padding: '9px 12px', minWidth: 0
          }}>
            <Truncate title={title} style={{
              fontSize: 'var(--text-md)', lineHeight: 1.35,
              fontWeight: tone === 'danger' ? 600 : 400,
              color: tone === 'danger'
                ? 'var(--status-stuck-text)'
                : (empty ? 'var(--text-faint)' : 'var(--text-body)')
            }}>
              {empty ? (notSet ? <NotSet /> : '—') : value}
            </Truncate>
          </span>
        )}

      <span style={{
        display: 'flex', alignItems: 'center',
        padding: '0 10px', flex: 'none'
      }}>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title={editTitle || `Edit ${String(label).toLowerCase()}`}
            aria-label={editTitle || `Edit ${String(label).toLowerCase()}`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, padding: 0,
              border: 'none', background: 'none',
              color: 'var(--text-muted)', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>edit</span>
          </button>
        )}
      </span>
    </div>
  )
}
