import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { DatePicker, Segmented, Button } from 'antd'
import dayjs from 'dayjs'
import ResourceBoard from '../calendar/ResourceBoard'
import TimeGrid from '../calendar/TimeGrid'
import MonthGrid from '../calendar/MonthGrid'
import { monthWeeks, UNASSIGNED } from '../calendar/boardLayout'
import CalendarPeople from '../calendar/CalendarPeople'
import BookAppointment from '../calendar/BookAppointment'
import { appointmentsAPI } from '../../api/appointments'
import { boardZone } from '../../utils/calendarTime'
import { Shell, StateMessage } from '../shared/ListChrome'
import { useTabState } from '../../hooks/useTabState'

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
  // REMEMBERED, like every other tab's filters. The shell unmounts tabs, so
  // plain state would send a dispatcher back to today-everyone-everything
  // each time they stepped out to look at a deal.
  //
  // The day is stored as 'YYYY-MM-DD' rather than a dayjs object, because the
  // snapshot goes through JSON and a dayjs instance does not survive that —
  // it would come back as a string that every date call then mishandled.
  const [fromDayKey, setFromDayKey] = useTabState(
    'calendar', 'day', dayjs().startOf('day').format('YYYY-MM-DD')
  )
  const fromDay = useMemo(() => dayjs(fromDayKey).startOf('day'), [fromDayKey])
  const setFromDay = useCallback(
    (d) => setFromDayKey(d.startOf('day').format('YYYY-MM-DD')),
    [setFromDayKey]
  )

  // WHICH VIEW. Day, Week and Month are the three everybody already knows;
  // People is the resource board — a column per person — which answers a
  // different question and is why it stays rather than being replaced.
  //
  //   Day / Week   days across, hours down. "What is happening?"
  //   Month        which DAY a thing is on; no room for time, by design.
  //   People       who should take it. Dragging sideways reassigns.
  const [view, setView] = useTabState('calendar', 'view', 'week')

  // Only the People board uses this — 1 or 3 columns of people.
  const [days, setDays] = useTabState('calendar', 'days', 1)
  const [kind, setKind] = useTabState('calendar', 'kind', 'all')
  // WHO IS TICKED. null means everyone, which is not the same as [] meaning
  // nobody — see CalendarPeople. Replaces a single-select "Everyone / one
  // person" dropdown that could not express "the two surveyors, not the
  // marketing logins", which is the only question worth asking on an account
  // whose user list is mostly system logins.
  const [people, setPeople] = useTabState('calendar', 'people', null)

  // Hide people with nothing booked. ON by default, and that default is the
  // whole reason this control exists.
  //
  // The column list is every active account user, which on a real
  // sub-account is the surveyors PLUS the marketing logins, the enquiries
  // inbox and anything with a seat. One live account draws twelve columns,
  // perhaps three of which ever take an appointment — so the board opened on
  // a wall of empty lanes with the day's actual bookings scrolled off to the
  // side.
  //
  // Off shows everyone, which is the right answer to "who is free this
  // afternoon". That question is real, so this is a toggle rather than a
  // filter applied once and forgotten.
  const [hideEmpty, setHideEmpty] = useTabState('calendar', 'hideEmpty', true)

  const [data, setData] = useState({ appointments: [], resources: [], timezone: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  // Cards with a write in flight. A Set rather than a boolean: two moves can
  // overlap, and a single flag would unlock the first card when the second
  // finished.
  const [busyIds, setBusyIds] = useState(() => new Set())
  // null = closed. An object = open, prefilled from wherever the rep asked
  // to book (a double-clicked slot, or the toolbar button with nothing
  // prefilled but the day on screen).
  const [booking, setBooking] = useState(null)

  const zone = useMemo(() => boardZone(data.timezone), [data.timezone])

  const say = useCallback((text, tone = 'error') => {
    setToast({ text, tone })
    window.setTimeout(() => setToast(null), tone === 'done' ? 2200 : 5000)
  }, [])

  // THE WINDOW TO FETCH, which is not the same as the window on screen.
  //
  // A week view starts on Monday whatever day you picked, and a month grid
  // draws whole weeks — so it reaches into the month either side and can span
  // 42 days. Asking for exactly what is drawn, rather than for the nominal
  // month, is what stops the first and last rows rendering empty.
  const span = useMemo(() => {
    if (view === 'week') {
      const start = fromDay.startOf('week').add(1, 'day')
      // dayjs weeks start on Sunday; the board starts on Monday, which is how
      // a working week reads here. If picking the Sunday pushed us forward a
      // week, step back one.
      const monday = start.isAfter(fromDay, 'day') ? start.subtract(7, 'day') : start
      return { from: monday, days: 7 }
    }
    if (view === 'month') {
      const weeks = monthWeeks(fromDay)
      return { from: dayjs(weeks[0][0]), days: weeks.length * 7 }
    }
    if (view === 'day') return { from: fromDay, days: 1 }
    return { from: fromDay, days }
  }, [view, fromDay, days])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await appointmentsAPI.list({
        from: span.from.startOf('day').toISOString(),
        to: span.from.add(span.days, 'day').startOf('day').toISOString(),
        kind
        // No assignedTo. The window is fetched for EVERYONE and the ticks
        // filter it in the browser, so a tick is instant — no request, no
        // spinner, no flash of an empty grid. That is what makes a checkbox
        // list feel like one.
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
  }, [span, kind])

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

  // Cancel, reinstate, or record an outcome.
  //
  // Not optimistic, unlike a move. A drag has already shown the rep where
  // the card went and reverting it is visible; a status change would alter
  // only a colour, and a colour that flickers back is easy to miss — so this
  // waits for the server and then reloads. It is one click, not a gesture,
  // so the wait costs nothing in feel.
  const handleSetStatus = useCallback(async (appointment, appointmentStatus) => {
    const id = appointment.id
    setBusyIds((s) => new Set(s).add(id))
    try {
      await appointmentsAPI.update(id, { appointmentStatus })
      await load()
      say(
        appointmentStatus === 'cancelled' ? 'Cancelled — the customer was not emailed'
          : appointmentStatus === 'confirmed' ? 'Reinstated'
            : 'Saved',
        'done'
      )
    } catch (err) {
      say(err.message || 'That did not save.')
    } finally {
      setBusyIds((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }, [load, say])

  // A new appointment is NOT in our database when the POST resolves — GHL
  // has it, and the AppointmentCreate webhook writes our row a moment later.
  // So reloading immediately usually shows nothing, which reads as "the
  // booking failed".
  //
  // Poll briefly instead, backing off. Most land on the first or second try.
  // After about eight seconds give up and SAY so rather than spinning: the
  // appointment really does exist, and an honest "it will appear shortly"
  // beats a board that looks broken.
  const waitForBooking = useCallback(async (createdId) => {
    const delays = [600, 1200, 2200, 4000]
    for (const ms of delays) {
      await new Promise((r) => window.setTimeout(r, ms))
      const res = await appointmentsAPI.list({
        from: span.from.startOf('day').toISOString(),
        to: span.from.add(span.days, 'day').startOf('day').toISOString(),
        kind
      }).catch(() => null)
      if (!res) continue
      setData({
        appointments: res.appointments || [],
        resources: res.resources || [],
        timezone: res.timezone || null
      })
      if (!createdId || (res.appointments || []).some((a) => a.id === createdId)) return true
    }
    return false
  }, [span, kind])

  const handleBooked = useCallback(async (created, { notified }) => {
    setBooking(null)
    say(
      notified
        ? 'Booked — the customer has been emailed'
        : 'Booked — the customer was not emailed',
      'done'
    )
    const landed = await waitForBooking(created?.id)
    if (!landed) {
      say('Booked in your CRM — it will appear on the board shortly.', 'done')
    }
  }, [waitForBooking, say])

  // How many each person has in this window. Counted BEFORE the filter, or
  // unticking somebody would zero their own count and the list would stop
  // telling you who is busy.
  const counts = useMemo(() => {
    const m = new Map()
    for (const a of data.appointments) {
      const id = a.assignedUserId || UNASSIGNED
      m.set(id, (m.get(id) || 0) + 1)
    }
    return m
  }, [data.appointments])

  const visible = useMemo(() => {
    if (people == null) return data.appointments
    const set = new Set(people)
    return data.appointments.filter(
      (a) => set.has(a.assignedUserId || UNASSIGNED)
    )
  }, [data.appointments, people])

  // The People board's columns follow the ticks too, or you would untick
  // somebody and still be looking at their empty lane.
  const visibleResources = useMemo(() => {
    if (people == null) return data.resources
    const set = new Set(people)
    return data.resources.filter((r) => set.has(r.id))
  }, [data.resources, people])

  // ← and → move by whatever the view shows, which is the only behaviour
  // that does not feel broken: a month view that steps by one day, or a week
  // view that steps by three, makes the arrows useless.
  const step = useCallback((dir) => {
    setFromDay((d) => {
      if (view === 'month') return d.add(dir, 'month')
      if (view === 'week') return d.add(dir * 7, 'day')
      if (view === 'day') return d.add(dir, 'day')
      return d.add(dir * days, 'day')
    })
  }, [view, days, setFromDay])

  // An empty DAY is not an empty board.
  //
  // A board with columns and no cards is the most useful thing a dispatcher
  // can be shown on a quiet day: it says who is free, and it can be
  // double-clicked to book. Hiding it behind "nothing booked" would make the
  // one screen that answers "who can take this" disappear exactly when the
  // answer is "anyone".
  //
  // So the empty state is reserved for having nobody to draw columns for at
  // all — which is a real and different problem (no synced users, or a
  // filter narrowed to one person with nothing on).
  // Appointments OR people is enough to draw a board.
  //
  // Not people alone, which is what this tested. Filtering to Unassigned now
  // returns no PEOPLE by design — the Unassigned column is added by the board
  // itself — so a board holding nothing but unassigned work would have been
  // hidden behind an empty state while the work sat there unallocated. That
  // is the one view where hiding it is worst: unowned appointments are the
  // ones most likely to be missed.
  const hasBoard = !error && (data.resources.length > 0 || data.appointments.length > 0)
  const empty = !loading && !error && !hasBoard

  return (
    <Shell>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)',
          alignItems: 'center'
        }}
      >
        <Button onClick={() => step(-1)} aria-label="Previous">←</Button>
        <DatePicker
          value={fromDay}
          onChange={(d) => d && setFromDay(d.startOf('day'))}
          allowClear={false}
          format="ddd D MMM YYYY"
        />
        <Button onClick={() => step(1)} aria-label="Next">→</Button>
        <Button onClick={() => setFromDay(dayjs().startOf('day'))}>Today</Button>

        <Segmented
          value={view}
          onChange={setView}
          options={[
            { label: 'Day', value: 'day' },
            { label: 'Week', value: 'week' },
            { label: 'Month', value: 'month' },
            { label: 'People', value: 'people' }
          ]}
        />

        {/* Only the People board has a span to choose — the others are named
            after theirs. */}
        {view === 'people' && (
          <Segmented
            value={days}
            onChange={setDays}
            options={[{ label: '1 day', value: 1 }, { label: '3 days', value: 3 }]}
          />
        )}
        <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />

        <Button
          type="primary"
          onClick={() => setBooking({ day: fromDay.format('YYYY-MM-DD') })}
        >
          Book
        </Button>

        <Segmented
          value={hideEmpty ? 'busy' : 'all'}
          onChange={(v) => setHideEmpty(v === 'busy')}
          options={[
            { label: 'Busy only', value: 'busy' },
            { label: 'Everyone', value: 'all' }
          ]}
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
        emptyTitle="Nobody to show"
        emptyText={
          'No active users have synced from your CRM yet, so there is nobody to draw.'
        }
      />

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        {hasBoard && (
          <CalendarPeople
            resources={data.resources}
            selected={people}
            onChange={setPeople}
            counts={counts}
          />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
      {hasBoard && view === 'month' && (
        <MonthGrid
          appointments={visible}
          zone={zone}
          fromDay={fromDay}
          busyIds={busyIds}
          onOpenDeal={onOpenDeal}
          onMove={handleMove}
          onBookAt={setBooking}
          // "+N more" drops into that day rather than trying to grow the
          // cell — a month row that expands pushes the weeks below it off
          // screen, which is worse than one more click.
          onOpenDay={(day) => { setFromDay(dayjs(day)); setView('day') }}
        />
      )}

      {hasBoard && (view === 'day' || view === 'week') && (
        <TimeGrid
          appointments={visible}
          resources={data.resources}
          zone={zone}
          fromDay={span.from}
          days={span.days}
          busyIds={busyIds}
          onOpenDeal={onOpenDeal}
          onMove={handleMove}
          onSetStatus={handleSetStatus}
          onBookAt={setBooking}
        />
      )}

      {hasBoard && view === 'people' && (
        <ResourceBoard
          appointments={visible}
          resources={visibleResources}
          zone={zone}
          fromDay={fromDay}
          days={days}
          busyIds={busyIds}
          hideEmpty={hideEmpty}
          onOpenDeal={onOpenDeal}
          onMove={handleMove}
          onSetStatus={handleSetStatus}
          onBookAt={setBooking}
        />
      )}

        </div>
      </div>

      {booking && (
        <BookAppointment
          initial={booking}
          zone={zone}
          resources={data.resources}
          onClose={() => setBooking(null)}
          onBooked={handleBooked}
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
