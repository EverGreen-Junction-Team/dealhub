import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Select, Input, TimePicker, DatePicker, InputNumber, Checkbox, Button } from 'antd'
import {
  CloseOutlined, ClockCircleOutlined, UserOutlined, TeamOutlined,
  EnvironmentOutlined, CalendarOutlined, BellOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import ContactPicker from '../shared/ContactPicker'
import { useModal } from '../../hooks/useModal'
import { appointmentsAPI } from '../../api/appointments'
import { isoForSlot, DEFAULT_SLOT_MINUTES } from '../../utils/calendarTime'

// Book an appointment from the board, as Google Calendar's quick-create card.
//
// ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────
//
// The old version was an honest form: a stack of labelled fields, each with
// a sentence of help under it. Correct, and slow — eight labels and five
// hints to read before the first keystroke, for a job that is usually "half
// nine on Tuesday, Mrs Patel".
//
// Google's card is faster for one reason worth copying: the TITLE is the
// only thing with focus and the only thing that looks like an input.
// Everything else is a line of text beside an icon, already filled in from
// where you clicked, and you touch it only if it is wrong. The icons replace
// the labels — a clock, a person, a pin — which is what lets five rows fit
// in the space three labelled fields used to take.
//
// So the prefill is not a convenience here, it is the design. A card that
// opened empty would need all its labels back.
//
// ── IT SPRINGS FROM WHERE YOU CLICKED ────────────────────────────────
//
// Anchored to the click, not centred, because that is what connects "I
// clicked 12:30 on Tuesday" to the card now claiming Tuesday 12:30. A
// centred dialog makes you re-read the date to check it took. Opened from
// the toolbar button there is no click to anchor to, and it centres.
//
// ── THE TWO FIELDS GHL WILL NOT DO WITHOUT ───────────────────────────
//
// A calendar and a customer. Neither is obvious and both have a
// sensible-looking wrong answer: the calendar looks like a formality until
// you learn it carries the working hours and the timezone, and "no
// customer" looks reasonable until you learn that is blocked time, which
// lives somewhere else entirely. They keep their explanations — as one short
// line each, shown where the row is, not as permanent help text.
//
// ── WHY A SLOT PICKER WOULD BE WRONG ─────────────────────────────────
//
// GHL can list a calendar's free slots, and a customer-facing booking widget
// should certainly ask. This is a dispatcher putting a visit in the diary,
// usually on the phone to the customer, and they already know when. The
// calendar's availability rules still apply — the server does not override
// them — so a time outside working hours is refused by GHL and the reason is
// shown here. That is the right order: let the dispatcher say what they
// mean, and let the calendar object if it must.

const CARD_WIDTH = 428
// Keep the card this far from the viewport edge when it is nudged back in.
const EDGE_GUTTER = 12

export default function BookAppointment({
  // Prefilled from wherever the rep clicked: a time, a day, a person, and
  // the point on screen to spring from.
  initial,
  zone,
  resources,
  onClose,
  onBooked
}) {
  const modalRef = useModal()

  const [calendars, setCalendars] = useState([])
  const [calendarsError, setCalendarsError] = useState(null)
  const [loadingCalendars, setLoadingCalendars] = useState(true)

  const [calendarId, setCalendarId] = useState(null)
  const [contactId, setContactId] = useState(null)
  const [day, setDay] = useState(() => dayjs(initial?.day || undefined))
  const [time, setTime] = useState(() => (
    initial?.minutes != null
      ? dayjs().startOf('day').add(initial.minutes, 'minute')
      : dayjs().startOf('day').add(9 * 60, 'minute')
  ))
  const [duration, setDuration] = useState(DEFAULT_SLOT_MINUTES)
  const [assignedUserId, setAssignedUserId] = useState(initial?.userId || null)
  const [title, setTitle] = useState('')
  const [address, setAddress] = useState('')
  // OFF by default, and the only place in this app that offers to turn it
  // on. Booking is the one moment where emailing the customer is arguably
  // right — they have just agreed to the visit — so the choice is offered
  // here and nowhere else. Moving and cancelling never notify.
  const [notifyCustomer, setNotifyCustomer] = useState(false)

  // The optional half: a place and a confirmation email. Folded away because
  // most bookings use neither, and every row on this card costs a glance.
  // Google calls the same affordance "More options"; this one only expands,
  // because there is no fuller editor to send you to.
  const [more, setMore] = useState(false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Escape closes it. Bound here rather than in useModal — see that hook's
  // note: every dialog owns its own, guarded against firing mid-save so a
  // keypress cannot abandon a booking that is already on its way to the CRM.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  useEffect(() => {
    let live = true
    appointmentsAPI.calendars()
      .then((res) => {
        if (!live) return
        const list = res.calendars || []
        setCalendars(list)
        // One calendar is the common case in a small sub-account, and making
        // someone choose from a list of one is a click that teaches nothing.
        if (list.length === 1) setCalendarId(list[0].id)
      })
      .catch((err) => { if (live) setCalendarsError(err.message) })
      .finally(() => { if (live) setLoadingCalendars(false) })
    return () => { live = false }
  }, [])

  const assignable = useMemo(
    () => (resources || []).filter((r) => r.assignable && !r.isUnassigned),
    [resources]
  )

  const chosenCalendar = calendars.find((c) => c.id === calendarId)

  const submit = async () => {
    setError(null)
    if (!calendarId) return setError('Pick a calendar.')
    if (!contactId) return setError('Pick a customer.')

    setSaving(true)
    try {
      // Built through the same helper the drag path uses, so a booking and a
      // move cannot disagree about what "10:00 on the board" means. It
      // carries the offset, which is what stops GHL reinterpreting the time
      // against a calendar in another zone.
      const { startTime, endTime } = isoForSlot(
        day.format('YYYY-MM-DD'),
        time.hour() * 60 + time.minute(),
        duration,
        zone
      )
      const res = await appointmentsAPI.create({
        calendarId,
        contactId,
        startTime,
        endTime,
        assignedUserId: assignedUserId || undefined,
        title: title.trim() || undefined,
        address: address.trim() || undefined,
        notifyCustomer
      })
      onBooked?.(res.appointment, { notified: notifyCustomer })
    } catch (err) {
      // GHL's own words. For a booking the commonest refusal is the
      // calendar's availability — "outside working hours", "slot taken" —
      // and that names the thing the dispatcher has to change.
      setError(err.message || 'That booking was refused.')
      setSaving(false)
    }
  }

  const place = useAnchoredCard(initial?.anchor, modalRef)

  return (
    <div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        // Lighter than the app's other dialogs. This one points at a slot on
        // the grid behind it, and a heavy scrim hides the thing it is
        // pointing at.
        background: 'rgba(16,20,24,0.18)'
      }}
    >
      <style>{QUICK_CSS}</style>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Book an appointment"
        className="pp-quick"
        style={{
          position: 'absolute',
          ...place,
          // Divided by the zoom, like everywhere else in this app: vw/vh are
          // measured against the real viewport and then scaled down with the
          // rest of <body>, so an undivided 86vh is really 73% of the screen.
          width: `min(${CARD_WIDTH}px, calc(100vw / var(--app-zoom) - 24px))`,
          maxHeight: 'calc(86vh / var(--app-zoom))', overflowY: 'auto',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          padding: '10px var(--space-4) var(--space-4)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={saving}
            className="pp-quick-x"
          >
            <CloseOutlined />
          </button>
        </div>

        {/* THE ONLY THING THAT LOOKS LIKE AN INPUT, and it holds focus on
            open. Everything below is already filled in. */}
        <Input
          autoFocus
          variant="borderless"
          className="pp-quick-title"
          placeholder="Add title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={() => { if (!saving) submit() }}
        />
        <p className="pp-quick-sub">
          {/* Shortened. It sat directly under the one field with focus and
              was the longest sentence on the card, which made the first
              thing you read a caveat about a field you can skip. */}
          Optional — your CRM will name it.
        </p>

        <Row icon={<ClockCircleOutlined />} label="When">
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
            <DatePicker
              variant="borderless"
              value={day}
              onChange={(d) => d && setDay(d)}
              allowClear={false}
              // "Thursday, 26 November" at 160px was cut to "26 Novem|".
              // The full weekday is not worth a line of its own here — the
              // card springs from the day you clicked — so it is the short
              // form, and the box is wide enough for the longest of them.
              format="ddd, D MMM YYYY"
              suffixIcon={null}
              style={{ width: 150 }}
            />
            <TimePicker
              variant="borderless"
              value={time}
              onChange={(t) => t && setTime(t)}
              allowClear={false}
              format="HH:mm"
              minuteStep={15}
              suffixIcon={null}
              style={{ width: 64 }}
            />
            <span className="pp-quick-dim">for</span>
            <InputNumber
              variant="borderless"
              min={5}
              max={600}
              step={15}
              value={duration}
              onChange={(v) => setDuration(v || DEFAULT_SLOT_MINUTES)}
              controls={false}
              style={{ width: 46 }}
            />
            <span className="pp-quick-dim">min</span>
          </div>
          {/* Which clock these times are on. The board, the CRM and the rep's
              own machine can all be in different zones, and this is the one
              line that says which one these numbers mean. */}
          {zone && <Hint>Times are {zone.replace(/_/g, ' ')}</Hint>}
        </Row>

        <Row icon={<UserOutlined />} label="Customer">
          <ContactPicker value={contactId} onChange={setContactId} />
          {/* Was two sentences, the second explaining that holding time
              with nobody means blocking it out instead. True, and it was
              being read by everyone booking normally to answer a question
              almost none of them had. The short form says the rule; the
              rarer case is one the rep meets in GHL, not here. */}
          <Hint>Required — an appointment is always with somebody.</Hint>
        </Row>

        <Row icon={<TeamOutlined />} label="Who is going">
          <Select
            variant="borderless"
            style={{ width: '100%' }}
            allowClear
            placeholder="Unassigned"
            value={assignedUserId}
            onChange={setAssignedUserId}
            options={assignable.map((r) => ({ value: r.id, label: r.name }))}
          />
        </Row>

        <Row icon={<CalendarOutlined />} label="Calendar">
          <Select
            variant="borderless"
            style={{ width: '100%' }}
            loading={loadingCalendars}
            value={calendarId}
            onChange={setCalendarId}
            placeholder={loadingCalendars ? 'Loading…' : 'Choose a calendar'}
            options={calendars.map((c) => ({ value: c.id, label: c.name }))}
            notFoundContent={
              calendarsError || (loadingCalendars ? 'Loading…' : 'No calendars')
            }
          />
          <Hint>Sets the working hours and the timezone.</Hint>
          {calendarsError && <Problem>{calendarsError}</Problem>}
        </Row>

        {more && (
          <>
            <Row icon={<EnvironmentOutlined />} label="Where">
              <Input
                variant="borderless"
                placeholder="Add an address or a meeting link"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Row>

            <Row icon={<BellOutlined />} label="Confirmation">
              <Checkbox
                checked={notifyCustomer}
                onChange={(e) => setNotifyCustomer(e.target.checked)}
              >
                Email the customer a confirmation
              </Checkbox>
              {/* Said plainly, because it is the one irreversible thing on
                  this card. Everything else can be corrected by dragging. */}
              <Hint>
                Off by default. Moving or cancelling never emails anyone
                {chosenCalendar ? `; this uses ${chosenCalendar.name}'s own template` : ''}.
              </Hint>
            </Row>
          </>
        )}

        {error && <div style={{ marginTop: 'var(--space-3)' }}><Problem>{error}</Problem></div>}

        <div
          style={{
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-2)', marginTop: 'var(--space-3)'
          }}
        >
          <button
            type="button"
            className="pp-quick-more"
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            {more ? 'Fewer options' : 'More options'}
          </button>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="primary" shape="round" onClick={submit} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Where to put the card.
 *
 * ── WHY PERCENTAGES AND NOT PIXELS ───────────────────────────────────
 *
 * The whole app renders at `zoom: 0.85` on <body>, so a pixel offset given
 * to this card is NOT the pixel the click reported: the browser scales it.
 * A click at clientX 800 placed at `left: 800px` lands at about 680.
 *
 * The backdrop, though, is known to span the viewport whatever the zoom. So
 * the anchor is expressed as a percentage OF THAT, which survives the
 * scaling untouched, and the correction below is computed from real measured
 * pixels and converted back into percentages the same way.
 *
 * With no anchor — the toolbar's Book button — it centres.
 */
function useAnchoredCard(anchor, ref) {
  const [nudge, setNudge] = useState({ x: 0, y: 0 })
  // Measured once per anchor. Re-running on every render would fight itself:
  // each correction moves the card, which changes the measurement.
  const settled = useRef(null)

  const base = useMemo(() => {
    if (!anchor || typeof anchor.x !== 'number') return null
    return {
      left: (anchor.x / window.innerWidth) * 100,
      top: (anchor.y / window.innerHeight) * 100
    }
  }, [anchor])

  useLayoutEffect(() => {
    if (!base || !ref.current) return
    const key = `${base.left},${base.top}`
    if (settled.current === key) return
    settled.current = key

    const rect = ref.current.getBoundingClientRect()
    let dx = 0
    let dy = 0
    const overRight = rect.right - (window.innerWidth - EDGE_GUTTER)
    if (overRight > 0) dx -= (overRight / window.innerWidth) * 100
    if (rect.left + dx < EDGE_GUTTER) {
      dx += ((EDGE_GUTTER - rect.left) / window.innerWidth) * 100
    }
    const overBottom = rect.bottom - (window.innerHeight - EDGE_GUTTER)
    if (overBottom > 0) dy -= (overBottom / window.innerHeight) * 100
    if (rect.top + dy < EDGE_GUTTER) {
      dy += ((EDGE_GUTTER - rect.top) / window.innerHeight) * 100
    }
    if (dx || dy) setNudge({ x: dx, y: dy })
  }, [base, ref])

  if (!base) {
    return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
  }
  return {
    // A small offset off the click point so the card sits beside the cursor
    // rather than under it, the way Google's does.
    left: `calc(${base.left + nudge.x}% + 8px)`,
    top: `calc(${base.top + nudge.y}% - 12px)`
  }
}

/**
 * One labelled row: icon, name of the thing, the control.
 *
 * ── WHY THE LABELS CAME BACK ─────────────────────────────────────────
 *
 * The first version of this card dropped them, copying Google's, where an
 * icon and a filled-in value are enough. That works there because every
 * row is self-evident: a time reads as a time, and "Add guests" names
 * itself in its own placeholder.
 *
 * It did not work here. Two of these rows are PEOPLE — the customer being
 * visited and the person going — and one outline of a head is not
 * distinguishable from two. "Unassigned" sitting on its own said nothing
 * about what was unassigned. Worse, the controls are borderless until
 * hovered, so with no labels either, the whole card read as a paragraph of
 * grey text with nothing in it that looked editable.
 *
 * The labels are small and quiet, so the card is still a card rather than
 * a form, but every row now says what it is before you have to guess.
 */
function Row({ icon, label, children }) {
  return (
    <div className="pp-quick-row">
      <span className="pp-quick-icon" aria-hidden>{icon}</span>
      <div style={{ minWidth: 0 }}>
        {label && <div className="pp-quick-label">{label}</div>}
        {children}
      </div>
    </div>
  )
}

function Hint({ children }) {
  return <span className="pp-quick-hint">{children}</span>
}

function Problem({ children }) {
  return (
    <div
      role="alert"
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--status-stuck)',
        borderLeft: '3px solid var(--status-stuck)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--tint-rose)',
        fontSize: 'var(--text-sm)', color: 'var(--text-heading)'
      }}
    >
      {children}
    </div>
  )
}

// ── The look ──────────────────────────────────────────────────────────
//
// Scoped under .pp-quick so nothing here escapes into the rest of the app.
//
// The controls are borderless until you point at one. That is the trick that
// makes a card of eight inputs read as a card of eight FACTS — the boxes
// appear only for the row you are about to change. It needs CSS rather than
// props because ContactPicker's Select is inside another component and takes
// no styling of its own; one rule here covers every control on the card and
// keeps them consistent, which eight separate `variant` props would not.
const QUICK_CSS = `
/* ── Borderless, but not INVISIBLE ───────────────────────────────────
 *
 * The first version made every control fully transparent until hovered,
 * so the card read as a paragraph of grey text with nothing in it that
 * looked like it could be changed. "Unassigned" and "Choose a calendar"
 * were indistinguishable from the help text beneath them.
 *
 * A faint fill fixes that at no cost to the look: the row still reads as
 * a fact rather than a form field, but the shape of the box tells you
 * where the fact ends and where you can click. Hover darkens it, focus
 * draws a real border — three steps instead of two. */
.pp-quick .ant-select-selector,
.pp-quick .ant-picker,
.pp-quick .ant-input-number,
.pp-quick .ant-input {
  background: var(--surface-sunken);
  border-color: transparent !important;
  box-shadow: none !important;
  transition: background 110ms linear, border-color 110ms linear;
}
.pp-quick .ant-select:hover .ant-select-selector,
.pp-quick .ant-picker:hover,
.pp-quick .ant-input-number:hover,
.pp-quick .ant-input:hover {
  background: var(--gray-100);
}
/* Focus still draws a real border. Hover is a hint that something is
   editable; focus has to say exactly which box the keyboard is in. */
.pp-quick .ant-select-focused .ant-select-selector,
.pp-quick .ant-picker-focused,
.pp-quick .ant-input-number-focused,
.pp-quick .ant-input:focus {
  background: var(--surface-card);
  border-color: var(--brand-primary) !important;
}
.pp-quick .ant-picker-input > input { cursor: pointer; }

.pp-quick-title.ant-input {
  /* The exception: it already has focus and an underline, so a fill as
     well would make the loudest thing on the card louder still. */
  background: transparent;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  color: var(--text-heading);
  padding-left: 6px;
  border-bottom: 1px solid var(--border-default) !important;
  border-radius: 0;
}
.pp-quick-title.ant-input:focus {
  border-bottom: 2px solid var(--brand-primary) !important;
  background: transparent;
}
.pp-quick-sub {
  margin: 4px 0 var(--space-3) 6px;
  font-size: var(--text-xs);
  color: var(--text-faint);
}

.pp-quick-row {
  display: grid;
  grid-template-columns: 26px 1fr;
  align-items: start;
  gap: 6px;
  /* minWidth 0 so a long calendar or contact name truncates inside its
     control instead of widening the grid column and the card with it. */
  min-width: 0;
  padding: 3px 0;
}
/* Small, quiet, and above its control — enough to name the row without
   turning the card back into a stack of form fields. */
.pp-quick-label {
  margin: 0 0 1px 12px;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--text-muted);
}

.pp-quick-icon {
  display: flex;
  justify-content: center;
  /* Aligns with the LABEL now, not with the control below it. */
  padding-top: 2px;
  font-size: 15px;
  color: var(--text-muted);
}
.pp-quick-hint {
  display: block;
  margin: 1px 0 0 12px;
  font-size: var(--text-xs);
  color: var(--text-faint);
}

.pp-quick-x {
  border: none;
  background: none;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.pp-quick-x:hover { background: var(--surface-sunken); }
.pp-quick-more {
  border: none;
  background: none;
  padding: 0;
  font-size: var(--text-sm);
  color: var(--text-link);
  cursor: pointer;
}
.pp-quick-more:hover { text-decoration: underline; }
.pp-quick-dim {
  font-size: var(--text-sm);
  color: var(--text-faint);
  padding: 0 2px;
}
`
