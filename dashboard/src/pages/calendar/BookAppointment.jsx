import React, { useEffect, useMemo, useState } from 'react'
import { Select, Input, TimePicker, DatePicker, InputNumber, Checkbox, Button } from 'antd'
import dayjs from 'dayjs'
import ContactPicker from '../shared/ContactPicker'
import { useModal } from '../../hooks/useModal'
import { appointmentsAPI } from '../../api/appointments'
import { isoForSlot, DEFAULT_SLOT_MINUTES } from '../../utils/calendarTime'

// Book an appointment from the board.
//
// ── WHY THIS IS A FORM AND NOT A SLOT PICKER ─────────────────────────
//
// GHL can tell you a calendar's free slots, and a customer-facing booking
// widget should certainly ask. This is not that: it is a dispatcher putting
// a visit in the diary, usually while on the phone to the customer, and they
// already know when. Making them step through available slots would be
// slower than the thing it replaces, which is typing it into the CRM.
//
// The calendar's availability rules still apply — the server does not
// override them — so a time outside working hours is refused by GHL and the
// reason is shown here. That is the right order: let the dispatcher say what
// they mean, and let the calendar object if it must.
//
// ── THE TWO FIELDS GHL WILL NOT DO WITHOUT ───────────────────────────
//
// A calendar and a customer. Both are explained where they are asked for,
// because neither is obvious and both have a sensible-looking wrong answer:
// the calendar looks like a formality until you learn it carries the working
// hours and the timezone, and "no customer" looks reasonable until you learn
// that is blocked time, which lives somewhere else entirely.

export default function BookAppointment({
  // Prefilled from wherever the rep clicked: a time, a day and a person.
  // Clicking an empty slot is the fast path — the three fields that take
  // longest to fill are already right.
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

  return (
    <div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(16,20,24,0.38)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-4)'
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Book an appointment"
        style={{
          width: 'min(520px, 100%)', maxHeight: '90vh', overflowY: 'auto',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          padding: 'var(--space-5)',
          display: 'grid', gap: 'var(--space-4)'
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-heading)'
          }}
        >
          Book an appointment
        </h2>

        <Field
          label="Calendar"
          hint="Sets the working hours, the timezone and who gets notified."
        >
          <Select
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
          {calendarsError && <Problem>{calendarsError}</Problem>}
        </Field>

        <Field
          label="Customer"
          hint="Your CRM cannot store an appointment without one. To hold time with nobody, block it out in the calendar instead."
        >
          <ContactPicker value={contactId} onChange={setContactId} />
        </Field>

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Field label="Date" grow>
            <DatePicker
              style={{ width: '100%' }}
              value={day}
              onChange={(d) => d && setDay(d)}
              allowClear={false}
              format="ddd D MMM YYYY"
            />
          </Field>
          <Field label="Start">
            <TimePicker
              value={time}
              onChange={(t) => t && setTime(t)}
              allowClear={false}
              format="HH:mm"
              minuteStep={15}
            />
          </Field>
          <Field label="Minutes">
            <InputNumber
              min={5}
              max={600}
              step={15}
              value={duration}
              onChange={(v) => setDuration(v || DEFAULT_SLOT_MINUTES)}
            />
          </Field>
        </div>

        <Field label="Who is going" hint="Leave empty to book it unassigned and allocate it on the board.">
          <Select
            style={{ width: '100%' }}
            allowClear
            placeholder="Unassigned"
            value={assignedUserId}
            onChange={setAssignedUserId}
            options={assignable.map((r) => ({ value: r.id, label: r.name }))}
          />
        </Field>

        <Field label="Title" hint="Optional — your CRM names it from the calendar's own template if you leave this empty.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <Field label="Where" hint="Optional. An address, or a meeting link.">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <Checkbox
          checked={notifyCustomer}
          onChange={(e) => setNotifyCustomer(e.target.checked)}
        >
          Email the customer a confirmation
        </Checkbox>
        <p style={{ margin: '-8px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
          {/* Said plainly, because it is the one irreversible thing on this
              form. Everything else can be corrected by dragging the card. */}
          Off by default. Moving or cancelling an appointment never emails
          anyone{chosenCalendar ? `; this uses ${chosenCalendar.name}'s own template` : ''}.
        </p>

        {error && <Problem>{error}</Problem>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="primary" onClick={submit} loading={saving}>
            Book it
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children, grow }) {
  return (
    <div style={{ display: 'grid', gap: 4, flex: grow ? '1 1 200px' : undefined }}>
      <label
        style={{
          fontSize: 'var(--text-xs)',
          fontWeight: 'var(--weight-semibold)',
          letterSpacing: 'var(--tracking-label)',
          textTransform: 'uppercase',
          color: 'var(--text-muted)'
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
          {hint}
        </span>
      )}
    </div>
  )
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
