import React from 'react'
import {
  ClockCircleOutlined, UserOutlined, EnvironmentOutlined,
  DollarOutlined, FileTextOutlined, GlobalOutlined
} from '@ant-design/icons'
import { clockTime, durationMinutes, inZone, zoneNote } from '../../utils/calendarTime'
import { formatMoney } from '../../utils/money'

// What you see when you point at a booking.
//
// ── WHY THIS REPLACED THE TOOLTIP ────────────────────────────────────
//
// It was an antd Tooltip: dark grey, about 200px wide, every line the same
// size and weight. Five facts set as five identical lines of small pale
// text on charcoal, and the most important one — WHO — was no bigger than
// "Status: confirmed". It also printed the name twice whenever the
// appointment's title was the contact's name, which in GHL is the common
// case, because the check compared the strings exactly and GHL pads and
// re-cases them.
//
// Google answers the same hover with a white card about 400px wide: the
// title large, the time under it, then one row per fact with an icon in a
// fixed gutter. That shape is better for a reason, not by taste — the eye
// reads the title, then scans the icon column for the one fact it wanted,
// and never has to read the others. So this is that shape.
//
// ── WIDTH ─────────────────────────────────────────────────────────────
//
// 340px. Wide enough that a deal name and its value sit on one line, and
// an address of a normal length does not wrap three times. Narrower than
// Google's because the app runs at 85% zoom inside GHL's frame and this
// floats over the grid it is describing.

export const DETAIL_WIDTH = 340

const STATUS_LABEL = {
  confirmed: 'Confirmed',
  showed: 'Attended',
  noshow: 'No-show',
  cancelled: 'Cancelled',
  invalid: 'Invalid',
  new: 'New'
}

// Same idea as the card: status is a word first. The dot is a second cue,
// never the only one.
const STATUS_DOT = {
  confirmed: 'var(--accent-teal)',
  showed: 'var(--accent-pine)',
  noshow: 'var(--accent-clay)',
  cancelled: 'var(--gray-400)',
  invalid: 'var(--gray-400)'
}

// GHL pads, re-cases and sometimes suffixes titles, so "SPYFU.COM" and
// "SpyFu.com " are the same thing to a reader and must be to this check.
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

// "8670 min" is a number to divide, not a length to read. Days and hours,
// down to minutes only where they are the whole story.
export function humanDuration(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return null
  // GHL ends a whole-day booking at 23:59, so 00:00 Monday to 23:59
  // Saturday is 8,639 minutes — "5 days 23 hr" for what is six days.
  // One minute short of a whole day counts as the whole day.
  if (mins >= 1439 && (mins + 1) % 1440 === 0) mins += 1
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const parts = []
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`)
  if (h) parts.push(`${h} hr`)
  if (m && !d) parts.push(`${m} min`)
  return parts.join(' ') || `${mins} min`
}

export default function AppointmentDetail({
  appointment: a, zone, accent,
  // The board clips at its edges; say so here, since the card's arrow is
  // the only other sign and it is easy to miss.
  clippedBefore = false, clippedAfter = false
}) {
  const isBlocked = a.kind === 'blocked'
  const status = (a.status || '').toLowerCase()
  const label = isBlocked
    ? (a.title || 'Blocked time')
    : (a.contactName || a.title || 'Appointment')
  const start = inZone(a.startsAt, zone)
  const end = a.endsAt ? inZone(a.endsAt, zone) : null
  // A booking that ends on another day must say WHICH day, or
  // "10:30–11:00" reads as half an hour.
  const multiDay = end && !end.isSame(start, 'day')
  const mins = a.endsAt ? durationMinutes(a.startsAt, a.endsAt) : null
  const otherZone = zoneNote(a.timezone, zone)

  return (
    <div style={{ width: DETAIL_WIDTH, maxWidth: '80vw', display: 'grid', gap: 'var(--space-3)' }}>
      {/* Title. The swatch is the card's own colour, so the reader can
          match this to the block they are pointing at. */}
      <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 'var(--space-3)', alignItems: 'start' }}>
        <span
          aria-hidden
          style={{
            width: 14, height: 14, marginTop: 5, borderRadius: 4,
            background: isBlocked ? 'var(--gray-400)' : (accent || 'var(--accent-teal)'),
            justifySelf: 'center'
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 'var(--text-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-heading)',
              lineHeight: 1.3,
              overflowWrap: 'anywhere',
              textDecoration: status === 'cancelled' ? 'line-through' : 'none'
            }}
          >
            {label}
          </div>
          <div style={{ marginTop: 2, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
            {multiDay
              ? (
                <>
                  {start.format('ddd D MMM, HH:mm')}
                  {' → '}
                  {end.format('ddd D MMM, HH:mm')}
                </>
                )
              : (
                <>
                  {start.format('dddd D MMMM')}
                  {' · '}
                  {clockTime(a.startsAt, zone)}
                  {a.endsAt ? `–${clockTime(a.endsAt, zone)}` : ''}
                </>
                )}
            {mins ? <span style={{ color: 'var(--text-muted)' }}>{` (${humanDuration(mins)})`}</span> : null}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        {!isBlocked && status && (
          <Fact icon={<ClockCircleOutlined />}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                aria-hidden
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: STATUS_DOT[status] || 'var(--accent-sky)'
                }}
              />
              {/* An unknown status shows its own name, never a guess. */}
              {STATUS_LABEL[status] || a.status}
            </span>
          </Fact>
        )}

        <Fact icon={<UserOutlined />}>
          {a.assignedUserName || <Muted>Unassigned</Muted>}
        </Fact>

        {!isBlocked && (
          <Fact icon={<DollarOutlined />}>
            {a.dealName
              ? (
                <>
                  {a.dealName}
                  {a.dealValue != null && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {` · ${formatMoney(a.dealValue, a.dealCurrency)}`}
                    </span>
                  )}
                </>
                )
              // Shown, not hidden — see migration 143. NULL is the common,
              // correct state when the customer has several open deals.
              : <Muted>No deal linked</Muted>}
          </Fact>
        )}

        {a.address && <Fact icon={<EnvironmentOutlined />}>{a.address}</Fact>}

        {/* The title only when it says something the name did not. */}
        {a.title && !same(a.title, label) && (
          <Fact icon={<FileTextOutlined />}>{a.title}</Fact>
        )}

        {otherZone && (
          <Fact icon={<GlobalOutlined />}>
            <Muted>Booked in {otherZone}</Muted>
          </Fact>
        )}

        {(clippedBefore || clippedAfter) && (
          <Fact icon={<ClockCircleOutlined />}>
            <Muted>
              {clippedBefore && clippedAfter
                ? 'Runs past both ends of the board'
                : clippedBefore ? "Starts before the board's first hour" : "Runs past the board's last hour"}
            </Muted>
          </Fact>
        )}
      </div>

      {!isBlocked && a.dealId && (
        <div
          style={{
            paddingTop: 'var(--space-2)',
            borderTop: '1px solid var(--border-default)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-link)'
          }}
        >
          Click to open the deal
        </div>
      )}
    </div>
  )
}

function Fact({ icon, children }) {
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '20px 1fr',
        gap: 'var(--space-3)', alignItems: 'start',
        fontSize: 'var(--text-sm)', color: 'var(--text-body)',
        lineHeight: 1.45
      }}
    >
      <span aria-hidden style={{ color: 'var(--text-muted)', justifySelf: 'center', paddingTop: 2 }}>
        {icon}
      </span>
      <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  )
}

function Muted({ children }) {
  return <span style={{ color: 'var(--text-muted)' }}>{children}</span>
}
