import React from 'react'
import { DealPill, Truncate } from './ListChrome'

// The records a task or a note is linked to — contact, deal, business — as
// rows of "name · View X". Shared by the Tasks and Notes tabs, in both their
// grid and rows views, so a record opens the same way wherever it appears.

// One LinkedRow per record. `record` is a task or a note — both carry
// `contacts` / `contact`, `deal` and `business` in the same shape.
//
// Only the records it HAS: the designs call out a missing DEAL in its own
// place (a card's header, a task row's due column) and simply give a missing
// contact or business no row. Built as a list so the LAST one present drops
// its divider, whichever it is.
export function LinkedRecords({ record: t, large = false, onOpenDeal, onOpenContact, onOpenBusiness }) {
  const contact = t.contacts?.[0] || t.contact || null
  const rows = []
  if (contact) {
    rows.push(
      <LinkedRow
        key="contact"
        icon="person"
        name={contact.name || 'Unnamed contact'}
        tone={LINK_TONES.contact}
        iconColour={LINK_TONES.contact.fill}
        large={large}
        onOpen={onOpenContact ? () => onOpenContact(contact.id) : undefined}
      />
    )
  }
  if (t.deal) {
    // The SHARED DealPill — opening a deal has one treatment across every
    // surface (dealPill.test.mjs pins it).
    rows.push(
      <LinkedRow
        key="deal"
        icon="sell"
        name={t.deal.name || 'Untitled deal'}
        iconColour={LINK_TONES.deal.fill}
        large={large}
        action={(
          <DealPill
            name={t.deal.name}
            compact={!large}
            onClick={onOpenDeal ? () => onOpenDeal(t.deal.id) : undefined}
          />
        )}
      />
    )
  }
  if (t.business) {
    rows.push(
      <LinkedRow
        key="business"
        icon="business"
        name={t.business.name || 'Unnamed business'}
        tone={LINK_TONES.business}
        iconColour={LINK_TONES.business.fill}
        large={large}
        onOpen={onOpenBusiness ? () => onOpenBusiness(t.business.id) : undefined}
      />
    )
  }
  if (!rows.length) {
    return (
      <span style={{ padding: '12px 0', fontSize: 'var(--text-md)', color: 'var(--text-faint)' }}>
        No linked records
      </span>
    )
  }
  return rows.map((row, i) =>
    i === rows.length - 1 ? React.cloneElement(row, { last: true }) : row)
}

// One linked record: icon, name, and a "View X" button.
//
// These were bare pills — a ContactChip and a DealPill side by side — which
// said WHO and WHICH DEAL but not what kind of record each was, and gave no
// affordance for opening them beyond the pill itself being clickable.
//
// The design makes each a row: the type is named by its icon and by the chip
// inside the button, so "Riley Nakamura · View CONTACT" and "Brightwell ·
// View BUSINESS" cannot be mistaken for one another at a glance.
//
// Rendered even when the record is MISSING (`name` null) — an unattached task
// is a real state worth seeing, not an absence to hide. The button is then
// inert and the row says so.
// `action` overrides the built-in button, for a row whose control already
// exists as a shared component — the deal row hands it a DealPill.
//
// `large` is the grid card's form: the icon takes the record's colour and the
// name steps up a size, as the card design draws it.
//
// `meta` is quiet detail after the name — a contact's deal value and stage.
// It is truncated with the name, never pushing the button off the row.
export function LinkedRow({
  icon, name, emptyText, tone, onOpen, last, action, iconColour, large = false, meta
}) {
  const present = !!name
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: large ? 10 : 'var(--space-2)',
        padding: large ? '10px 0' : '7px 0',
        borderBottom: last ? 'none' : '1px solid var(--border-default)',
        minWidth: 0
      }}
    >
      {/* A heavier stroke than the icon font's default 400 — the design's
          record icons read as solid marks beside the names, and at 400 they
          looked faint next to the coloured View pills. */}
      <span className="ms" style={{
        fontSize: large ? 18 : 17, flex: 'none',
        fontVariationSettings: "'FILL' 0, 'wght' 600, 'GRAD' 0, 'opsz' 20",
        color: iconColour || 'var(--text-faint)'
      }}>
        {icon}
      </span>
      {/* Medium weight in heading colour, in both sizes — the design's names
          are the darkest text on the row after the title. */}
      <Truncate style={{
        flex: 1, minWidth: 0,
        fontSize: large ? 'var(--text-lg)' : 'var(--text-md)',
        fontWeight: 500,
        color: present ? 'var(--text-heading)' : 'var(--text-faint)'
      }}>
        {present ? name : emptyText}
        {present && meta && (
          <span style={{
            marginLeft: 6, fontSize: 'var(--text-base)', fontWeight: 400,
            color: 'var(--text-muted)'
          }}>
            {meta}
          </span>
        )}
      </Truncate>
      {action || (
      <button
        type="button"
        onClick={present && onOpen ? onOpen : undefined}
        disabled={!present || !onOpen}
        title={present && onOpen ? `Open ${name}` : emptyText}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
          height: 24, padding: '0 4px 0 10px',
          border: 'none', borderRadius: 'var(--radius-pill)',
          background: present ? tone.fill : 'var(--status-stuck)',
          color: '#fff',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)', fontWeight: 600,
          cursor: present && onOpen ? 'pointer' : 'default',
          opacity: present ? 1 : 1
        }}
      >
        {present ? 'View' : 'No'}
        {/* Glyph only. The word moved to the tooltip and the accessible
            name — the icon says CONTACT / DEAL / BUSINESS on its own, and
            the capsule was wider than the "View" beside it with both. */}
        <span
          title={tone.label}
          aria-label={tone.label}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            height: 18, minWidth: 18, padding: '0 5px',
            borderRadius: 'var(--radius-pill)',
            background: '#fff',
            color: present ? tone.fill : 'var(--status-stuck)'
          }}
        >
          <span className="ms" style={{ fontSize: 13 }}>{tone.glyph || 'link'}</span>
        </span>
      </button>
      )}
    </div>
  )
}

// `glyph` is the record's icon, drawn inside the white capsule beside the
// word — a person for a contact, a tag for a deal, a building for a
// business — so the three pills tell apart at a glance. Same glyphs the
// rows' leading icons use, so the capsule and the row agree.
export const LINK_TONES = {
  contact: { fill: 'var(--accent-sky)', label: 'CONTACT', glyph: 'person' },
  deal: { fill: 'var(--green-500)', label: 'DEAL', glyph: 'sell' },
  business: { fill: 'var(--accent-plum)', label: 'BUSINESS', glyph: 'domain' }
}
