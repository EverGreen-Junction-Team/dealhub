import React from 'react'
import { formatMoney } from '../../utils/money'
import { DealPill, Truncate } from '../shared/ListChrome'

// The deals list as a table — the dense, scannable view.
//
// Fixed columns, matching what the CRM shows: name, contact, stage, value,
// status, owner, tags, created, updated. No column picker: every field here
// is one a rep reads on every row, and a chooser would add persistence and a
// settings surface for a list nobody has asked to trim.
//
// SORTING IS SERVER-SIDE, and only on the columns the cursor can anchor to:
// Value, Created and Last customer message. Re-sorting client-side would order
// only the page you hold — with a keyset cursor that is ~20 rows out of N, so
// "highest value" would name the richest deal on screen rather than in the
// pipeline. The text columns (deal, contact, stage, status, owner) stay
// unsorted rather than offering a control that quietly lies; sorting those
// needs a collation-matched text key in the cursor, which is its own change.
// Tags is multi-valued and has no single sort key at all.

const TH = {
  textAlign: 'left',
  // Taller header, and a size up: at text-sm on a tinted strip the column
  // names read as a caption above the table rather than part of it.
  padding: '11px var(--space-4)',
  fontSize: 'var(--text-base)', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border-strong)',
  whiteSpace: 'nowrap',
  background: 'var(--surface-sunken)',
  // The header stays put while the body scrolls: a 20-row page is taller than
  // most screens and a column you cannot name is a column you cannot read.
  position: 'sticky', top: 0, zIndex: 1
}

const TD = {
  // 14px vertical / 16px horizontal. At space-3 the rows were closer to each
  // other than a row's own cells were to its edges, so the grid read as one
  // dense block instead of a list of records.
  padding: '14px var(--space-4)',
  fontSize: 'var(--text-lg)',
  color: 'var(--text-body)',
  borderBottom: '1px solid var(--border-default)',
  verticalAlign: 'middle'
}

// The final row's divider doubles up with the container's own border.
const TD_LAST = { ...TD, borderBottom: 'none' }

const STATUS_TONE = {
  open: { bg: 'var(--tint-sky)', fg: 'var(--text-body)' },
  won: { bg: 'var(--tint-pine)', fg: 'var(--green-600)' },
  lost: { bg: 'var(--tint-rose)', fg: 'var(--status-stuck-text)' },
  abandoned: { bg: 'var(--tint-gray)', fg: 'var(--text-muted)' }
}

function Pill({ children, bg, fg, title }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-block', maxWidth: 200,
        padding: '3px 9px', borderRadius: 'var(--radius-pill)',
        background: bg, color: fg,
        fontSize: 'var(--text-base)', fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        verticalAlign: 'middle'
      }}
    >
      {children}
    </span>
  )
}

function shortDate(ts) {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function DealTable({
  deals = [], onOpenDeal, onOpenContact, onOpenInHub,
  // Server-side sort: the active column, its direction, and the setter. All
  // three optional, so a caller that does not sort renders plain headers.
  sort, dir, onSort,
  // True when the list is already filtered to ONE stage.
  singleStage = false
}) {
  if (!deals.length) return null

  // Filtered to one stage? Drop the column. Every row would print the same
  // value, which is a column of noise that pushes the useful ones sideways —
  // the stage is already named in the filter chip above the table.
  const showStage = !singleStage

  return (
    // The table scrolls sideways inside its own box. Without this the page
    // body scrolls horizontally and the nav goes with it.
    // A card, not a bare table. It sat directly on the page ground with no
    // edge, so the header strip floated and the last row ended in mid-air.
    <div style={{
      width: '100%', overflowX: 'auto',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)'
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontFamily: 'var(--font-sans)'
      }}>
        <thead>
          <tr>
            <th style={TH}>Deal</th>
            {/* Deliberately unlabelled: the chip in it says "DEAL" itself, and
                a "Hub" or "Open" heading over a one-control column is a word
                that earns nothing. */}
            <th style={{ ...TH, width: 1 }} aria-label="Open on the deal hub" />
            <th style={TH}>Contact</th>
            {showStage && <th style={TH}>Stage</th>}
            <SortTH
              label="Value" col="value" align="right"
              sort={sort} dir={dir} onSort={onSort}
            />
            <th style={TH}>Status</th>
            <th style={TH}>Owner</th>
            <th style={TH}>Tags</th>
            <SortTH label="Created" col="created" sort={sort} dir={dir} onSort={onSort} />
            {/* Was "Updated", which showed updated_at — a field the CRM's own
                sync touches, so it moved when nobody had spoken to the
                customer. This is the newest INBOUND message instead: the
                question a rep actually asks of this column. */}
            <SortTH
              label="Last customer message" col="lastCustomerMessage"
              sort={sort} dir={dir} onSort={onSort}
            />
            {/* No label: two icon buttons under the word "Actions" is a
                column header explaining itself. The buttons carry their own
                titles and aria-labels. */}
            <th style={{ ...TH, width: 92 }} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {deals.map((d, rowIndex) => {
            const value = Number(d.monetaryValue)
            const tone = STATUS_TONE[String(d.status || 'open').toLowerCase()] || STATUS_TONE.open
            const contactName = d.contact
              ? `${d.contact.firstName || ''} ${d.contact.lastName || ''}`.trim()
              : ''
            const tags = Array.isArray(d.tags) ? d.tags : []
            const td = rowIndex === deals.length - 1 ? TD_LAST : TD
            return (
              <tr
                key={d.id}
                style={{ cursor: 'pointer' }}
                onClick={() => onOpenDeal && onOpenDeal(d.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--surface-sunken)'
                }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <td style={{ ...td, fontWeight: 600, color: 'var(--text-heading)', maxWidth: 260 }}>
                  <Truncate style={{ display: 'block' }}>
                    {d.dealTag || d.opportunityName || 'Untitled deal'}
                  </Truncate>
                </td>

                {/* STRAIGHT TO THE DEAL HUB, beside the deal it opens.
                    Every other tab — Notes, Tasks, Businesses — reaches the
                    hub through this same green chip. The Deals table had only
                    a small icon at the far right of the row, past six other
                    columns: the one list that is entirely about deals was the
                    hardest place to open one from, and the control did not
                    look like the control that does this everywhere else. */}
                <td
                  style={{ ...td, width: 1, whiteSpace: 'nowrap' }}
                  // The row opens the EDITOR on click. Without this the chip
                  // would fire both and the editor would win.
                  onClick={(e) => e.stopPropagation()}
                >
                  <DealPill
                    name={d.dealTag || d.opportunityName}
                    onClick={onOpenInHub ? () => onOpenInHub(d.id) : undefined}
                  />
                </td>

                <td style={{ ...td, maxWidth: 200 }}>
                  {contactName
                    ? (
                      <button
                        onClick={(e) => {
                          // The row opens the deal; the contact cell opens the
                          // person. Without this the click reaches both.
                          e.stopPropagation()
                          onOpenContact && onOpenContact(d.contact.id)
                        }}
                        style={{
                          border: 'none', background: 'none', padding: 0,
                          fontFamily: 'inherit', fontSize: 'inherit',
                          color: 'var(--text-body)',
                          cursor: onOpenContact ? 'pointer' : 'default',
                          maxWidth: '100%',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                        }}
                      >
                        {contactName}
                      </button>
                    )
                    : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                </td>

                {showStage && (
                  <td style={td}>
                    {d.stage
                      ? <Pill bg="var(--tint-pine)" fg="var(--green-600)">{d.stage}</Pill>
                      : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                  </td>
                )}

                {/* Right-aligned and tabular so the column reads as a column
                    of figures. An unpriced deal says so rather than showing
                    £0, which reads as "worth nothing". */}
                <td style={{
                  ...td, textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  color: value > 0 ? 'var(--text-heading)' : 'var(--text-faint)',
                  fontWeight: value > 0 ? 600 : 400,
                  whiteSpace: 'nowrap'
                }}>
                  {value > 0 ? formatMoney(value, d.currency) : 'Not priced'}
                </td>

                <td style={td}>
                  <Pill bg={tone.bg} fg={tone.fg}>{d.status || 'open'}</Pill>
                </td>

                <td style={{ ...td, maxWidth: 160 }}>
                  <Truncate style={{ display: 'block', color: d.owner ? 'var(--text-body)' : 'var(--text-faint)' }}>
                    {d.owner || 'Unassigned'}
                  </Truncate>
                </td>

                {/* Two tags, then a count. A deal with a dozen tags would
                    otherwise set the width of the whole column. */}
                <td style={{ ...td, maxWidth: 180 }}>
                  {tags.length
                    ? (
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        {tags.slice(0, 2).map((t) => (
                          <Pill key={t} bg="var(--tint-gray)" fg="var(--text-muted)">{t}</Pill>
                        ))}
                        {tags.length > 2 && (
                          <span
                            title={tags.join(', ')}
                            style={{
                              fontSize: 'var(--text-sm)', fontWeight: 600,
                              color: 'var(--text-muted)'
                            }}
                          >
                            +{tags.length - 2}
                          </span>
                        )}
                      </span>
                    )
                    : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                </td>

                <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                  {shortDate(d.createdAt) || '—'}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                  {shortDate(d.lastCustomerContactAt) || '—'}
                </td>

                {/* Explicit actions. The whole row already opens the editor,
                    but a row that silently does something on click is a
                    guess — and there was no way at all to reach the deal hub
                    from here without opening the editor first. */}
                <td
                  style={{ ...td, width: 92, whiteSpace: 'nowrap' }}
                  // The row's own handler must not fire underneath these.
                  onClick={(e) => e.stopPropagation()}
                >
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <RowIcon
                      icon="edit"
                      title="Edit this deal"
                      onClick={() => onOpenDeal && onOpenDeal(d.id)}
                    />
                    <RowIcon
                      icon="space_dashboard"
                      title="Open on the deal hub"
                      onClick={onOpenInHub ? () => onOpenInHub(d.id) : undefined}
                    />
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


// A sortable column header.
//
// Falls back to a PLAIN header when no onSort is supplied, so a caller that
// does not wire sorting shows a label rather than a dead button.
//
// Clicking the active column flips direction; clicking a new one starts it
// descending — newest and largest first is what a rep wants on first click of
// a date or a money column, and starting ascending would open on the oldest
// and the cheapest.
function SortTH({ label, col, align = 'left', sort, dir, onSort }) {
  const active = sort === col;
  if (!onSort) return <th style={{ ...TH, textAlign: align }}>{label}</th>;
  return (
    <th style={{ ...TH, textAlign: align, padding: 0 }} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(col, active && dir === 'desc' ? 'asc' : 'desc')}
        title={`Sort by ${label.toLowerCase()}`}
        style={{
          // Inherits the header's type rather than restating it: a button
          // resets font and colour, so without this the sortable columns
          // rendered in the browser default face beside the plain ones.
          font: 'inherit', color: active ? 'var(--text-heading)' : 'inherit',
          letterSpacing: 'inherit', textTransform: 'inherit',
          display: 'flex', alignItems: 'center', gap: 4,
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
          width: '100%', padding: '11px var(--space-4)',
          border: 'none', background: 'none', cursor: 'pointer'
        }}
      >
        {label}
        {/* The inactive arrow is held at low opacity rather than hidden: a
            caret that appears on hover gives no hint the column sorts at all
            until the pointer is already on it, and removing it entirely makes
            the row jump sideways when a sort is applied. */}
        <span
          className="ms"
          aria-hidden="true"
          style={{ fontSize: 16, opacity: active ? 1 : 0.35 }}
        >
          {active && dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
        </span>
      </button>
    </th>
  );
}

// A row-level icon button. Inert without an onClick rather than rendering a
// pointer cursor over something that does nothing.
function RowIcon({ icon, title, onClick }) {
  const live = typeof onClick === 'function'
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={!live}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30,
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-card)',
        color: live ? 'var(--text-muted)' : 'var(--text-faint)',
        cursor: live ? 'pointer' : 'default'
      }}
    >
      <span className="ms" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}
