import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { DatePicker, Segmented, Select, Button } from 'antd'
import dayjs from 'dayjs'
import ResourceBoard from '../calendar/ResourceBoard'
import { appointmentsAPI } from '../../api/appointments'
import { boardZone } from '../../utils/calendarTime'
import { Shell, StateMessage } from '../shared/ListChrome'

// The operations calendar — option B: a board with a column per person.
//
// ── WHAT THIS TAB OWNS ───────────────────────────────────────────────
//
// Fetching the window, holding the optimistic state while a move is in
// flight, and turning a failed write back into the truth. ResourceBoard owns
// the drawing and boardLayout owns the arithmetic; keeping the three apart is
// what makes the geometry testable without a browser.
//
// ── WHY A BOARD AND NOT A SHARED WEEK ────────────────────────────────
//
// The difference is not cosmetic. A shared calendar answers "what is
// booked"; a column each answers "who should take this". So moving work
// between people is the primary gesture here — you drag sideways — and the
// layout is built around making that legible rather than around fitting
// seven days on screen.
//
// ── OPTIMISTIC, BUT HONESTLY SO ──────────────────────────────────────
//
// A dragged card moves immediately and the write goes out behind it. That is
// the only way a board feels usable; waiting a round trip before the card
// lands makes every move feel broken.
//
// The cost is that the card can be wrong for a second, and GHL refuses moves
// for real reasons — a slot outside the calendar's working hours, a clash, a
// rep who is not on that calendar. So a refusal puts the card back exactly
// where it was AND says why, in GHL's own words. A board that silently
// reverted would be worse than one that never moved, because the rep would
// believe the move had landed.

const KIND_OPTIONS = [
  // 'Everything' first and default. A board that hides blocked time presents
  // a rep's travel afternoon as free, which is the one thing a scheduling
  // view must never do.
  { label: 'Everything', value: 'all' },
  { label: 'Appointments', value: 'appointment' },
  { label: 'Blocked time', value: 'blocked' }
]

export default function CalendarTab({ onOpenDeal }) {
  const [fromDay, setFromDay] = useState(() => dayjs().startOf('day'))
  const [days, setDays] = useState(1)
  const [kind, setKind] = useState('all')
  const [personFilter, setPersonFilter] = useState(null)

  const [data, setData] = useState({ appointments: [], resources: [], timezone: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  // Cards with a write in flight. A Set rather than a boolean: two moves can
  // overlap, and a single flag would unlock the first card when the second
  // finished.
  const [busyIds, setBusyIds] = useState(() => new Set())

  const zone = useMemo(() => boardZone(data.timezone), [data.timezone])

  const say = useCallback((text, tone = 'error') => {
    setToast({ text, tone })
    window.setTimeout(() => setToast(null), tone === 'done' ? 2200 : 5000)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await appointmentsAPI.list({
        from: fromDay.startOf('day').toISOString(),
        to: fromDay.add(days, 'day').startOf('day').toISOString(),
        kind,
        ...(personFilter ? { assignedTo: personFilter } : {})
      })
      setData({
        appointments: res.appointments || [],
        resources: res.resources || [],
        timezone: res.timezone || null
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [fromDay, days, kind, personFilter])

  useEffect(() => { load() }, [load])

  // Move, reassign, or both at once. See the optimistic note above.
  const handleMove = useCallback(async (appointment, patch) => {
    const id = appointment.id
    const before = appointment

    // Redraw from the patch we are about to send, not from a guess about
    // what the server will make of it.
    setData((d) => ({
      ...d,
      appointments: d.appointments.map((a) => (
        a.id === id
          ? {
            ...a,
            ...(patch.startTime ? { startsAt: patch.startTime, endsAt: patch.endTime } : {}),
            ...('assignedUserId' in patch ? { assignedUserId: patch.assignedUserId } : {})
          }
          : a
      ))
    }))
    setBusyIds((s) => new Set(s).add(id))

    try {
      await appointmentsAPI.update(id, patch)
      // Refetch rather than trusting the echo to be complete.
      //
      // The write landed in GHL; our row is written by the AppointmentUpdate
      // webhook a moment later. A reload picks up whatever actually got
      // stored — including anything GHL normalised on the way through, and
      // including the new owner's NAME, which the echo does not carry and
      // the card needs to render.
      await load()
      say('Moved', 'done')
    } catch (err) {
      // Put it back. Exactly back, not near where it was.
      setData((d) => ({
        ...d,
        appointments: d.appointments.map((a) => (a.id === id ? before : a))
      }))
      // GHL's own reason, which usually names the rule that was broken —
      // far more useful than anything we could invent. "Outside the
      // calendar's available hours" tells a rep what to do next.
      say(err.message || 'That move was refused — the card has been put back.')
    } finally {
      setBusyIds((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }, [load, say])

  const people = useMemo(
    () => (data.resources || []).map((r) => ({ value: r.id, label: r.name })),
    [data.resources]
  )

  const empty = !loading && !error && data.appointments.length === 0

  return (
    <Shell>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)',
          alignItems: 'center'
        }}
      >
        <Button onClick={() => setFromDay((d) => d.subtract(days, 'day'))} aria-label="Previous">←</Button>
        <DatePicker
          value={fromDay}
          onChange={(d) => d && setFromDay(d.startOf('day'))}
          allowClear={false}
          format="ddd D MMM YYYY"
        />
        <Button onClick={() => setFromDay((d) => d.add(days, 'day'))} aria-label="Next">→</Button>
        <Button onClick={() => setFromDay(dayjs().startOf('day'))}>Today</Button>

        <Segmented
          value={days}
          onChange={setDays}
          options={[{ label: 'Day', value: 1 }, { label: '3 days', value: 3 }]}
        />
        <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />

        <Select
          allowClear
          placeholder="Everyone"
          style={{ minWidth: 180 }}
          value={personFilter}
          onChange={setPersonFilter}
          options={[{ value: 'unassigned', label: 'Unassigned only' }, ...people]}
        />

        <span
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--text-xs)', color: 'var(--text-faint)'
          }}
        >
          {/* The zone is stated, always. A board silently drawn in the wrong
              timezone looks exactly like one drawn in the right timezone, so
              saying which is the only defence a reader has. */}
          Times shown in {zone}
          {data.timezone == null ? ' — this sub-account has no timezone set' : ''}
        </span>
      </div>

      <StateMessage
        loading={loading && data.appointments.length === 0}
        error={error}
        empty={empty}
        loadingText="Loading the board…"
        emptyIcon="event_busy"
        emptyTitle="Nothing booked in this window"
        emptyText={
          kind === 'appointment'
            ? 'Blocked time is hidden by the filter — switch to Everything to see it.'
            : 'Try another day, or widen the filters.'
        }
      />

      {!error && data.appointments.length > 0 && (
        <ResourceBoard
          appointments={data.appointments}
          resources={data.resources}
          zone={zone}
          fromDay={fromDay}
          days={days}
          busyIds={busyIds}
          onOpenDeal={onOpenDeal}
          onMove={handleMove}
        />
      )}

      {toast && <Toast tone={toast.tone}>{toast.text}</Toast>}
    </Shell>
  )
}

const TOAST_TONES = {
  done: { icon: 'check_circle', colour: 'var(--status-done)' },
  error: { icon: 'error', colour: 'var(--status-stuck)' }
}

function Toast({ children, tone = 'error' }) {
  const { icon, colour } = TOAST_TONES[tone] || TOAST_TONES.error
  return (
    <div
      role="status"
      style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 40,
        display: 'flex', alignItems: 'center', gap: 7,
        maxWidth: 420,
        padding: '10px 14px',
        border: `1px solid ${colour}`,
        borderRadius: 'var(--radius-md)',
        background: '#fff', boxShadow: 'var(--shadow-overlay)',
        fontSize: 'var(--text-md)', color: 'var(--text-heading)'
      }}
    >
      <span className="ms" style={{ fontSize: 17, color: colour, flex: 'none' }}>
        {icon}
      </span>
      {children}
    </div>
  )
}
