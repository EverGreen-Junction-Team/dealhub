import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Segmented, Button } from 'antd'
import dayjs from 'dayjs'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import ResourceBoard from '../calendar/ResourceBoard'
import TimeGrid from '../calendar/TimeGrid'
import MonthGrid from '../calendar/MonthGrid'
import { monthWeeks, UNASSIGNED } from '../calendar/boardLayout'
import CalendarSidebar from '../calendar/CalendarSidebar'
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
// ── WHY THE CALENDAR SETS ITS OWN TYPE SIZES ─────────────────────────
//
// The app renders at `zoom: 0.85` on <body>, which is right for a page of
// cards and lists and wrong for this one. Everywhere else the text that
// shrank was already comfortable; here the body token is --text-xs — 11px,
// so 9.4px once zoomed — because an appointment card is a box a few dozen
// pixels tall and has always had to make do with the smallest size in the
// scale. Shrinking THAT by another 15% took it below readable.
//
// So the calendar raises the three sizes it actually uses by roughly the
// reciprocal of the zoom (11 ÷ 0.85 ≈ 13), which lands them back at the
// size the design intended. It is not making the calendar bigger than the
// rest of the app; it is undoing a reduction that happened to fall hardest
// on the one page whose text was already at the floor.
//
// Re-pointing the tokens on this element covers every `var(--text-sm)`
// inside the tab — the grids, the cards, the sidebar, the booking card —
// without editing a single one of them, and keeps the ones that are already
// right (--text-lg and up, used only for headings here) exactly as they are.
//
// The grid grew with it: see PIXELS_PER_MINUTE in boardLayout. Bigger text
// in boxes of the same height would clip the second line of a short booking.
//
// Multiplied by --app-text-scale like every other token (see index.css), so
// a person who raises the text size in Settings raises the calendar's too
// rather than pinning it at these three numbers.
const CALENDAR_TYPE_SCALE = {
  '--text-xs': 'calc(13px * var(--app-text-scale))',
  '--text-sm': 'calc(14px * var(--app-text-scale))',
  '--text-md': 'calc(16px * var(--app-text-scale))',

  // ── THE CALENDAR IS WHITE, AND THE REST OF DEAL HUB IS NOT ─────────
  //
  // Everywhere else the page is a cool grey (#eef1f5) and white cards sit
  // on it, which is right for a page that IS a stack of cards. A calendar
  // is not: it is one sheet, and the grey only ever showed as a frame
  // around the sheet and a gutter between the sheet and the rail. That
  // frame is what made the toolbar's controls look washed out — a grey
  // background behind a grey Segmented track — and what made the grid
  // look like a widget dropped onto a page rather than the page itself.
  //
  // Overridden as a TOKEN rather than a background, so everything inside
  // that reads --surface-page (the rail, the toolbar, the grid's own
  // chrome) follows without each one being told separately.
  '--surface-page': 'var(--white)',
  background: 'var(--white)'
}

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
  // nobody — see CalendarSidebar. Replaces a single-select "Everyone / one
  // person" dropdown that could not express "the two surveyors, not the
  // marketing logins", which is the only question worth asking on an account
  // whose user list is mostly system logins.
  const [people, setPeople] = useTabState('calendar', 'people', null)

  // WHICH CALENDARS. Same null-means-everything rule as people.
  //
  // The list comes from the CRM, not from our database — we hold no
  // calendars table, only a calendar_id on each appointment — so it is
  // fetched once per visit and kept here rather than per modal open. The
  // booking form asks for its own copy; one extra call on open is cheaper
  // than threading this down into it.
  const [calendars, setCalendars] = useState([])
  const [selectedCalendars, setSelectedCalendars] = useTabState(
    'calendar', 'calendars', null
  )

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
  // TWO KINDS OF LOADING, and conflating them is what made the calendar
  // jump.
  //
  //   loading     the FIRST load, when there is nothing on screen yet. A
  //               message is the right answer: there is nothing to look at.
  //   refreshing  every other fetch — changing view, stepping a week, the
  //               reload after a drag, the poll after a booking. There IS
  //               something on screen, and replacing it with "Loading the
  //               board…" threw the grid away, pushed the layout down, and
  //               then put it all back a moment later. On a view switch that
  //               happens several times a minute.
  //
  // So a refresh keeps the old grid up and says so in a 2px strip that takes
  // no layout space at all.
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // A REF, not the state itself. load() is memoised on [span, kind], so it
  // closes over whatever `data` was when it was built — empty, on the first
  // render. Reading state there would make every later refresh believe it
  // was the first load and blank the grid again, which is the bug this
  // whole change exists to fix.
  const hasDrawn = useRef(false)
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
  // The slot the open booking card is currently aiming at, so the grid can
  // draw it. Separate from `booking`, which is where the rep CLICKED and
  // never changes — this one follows the card's own date, time and
  // duration as they are edited. See DraftSlot.
  const [draft, setDraft] = useState(null)
  // The sticky toolbar, so the grid can measure the room left below it.
  const toolbarRef = useRef(null)

  // Where the sidebar should stick: directly under the toolbar.
  //
  // It was `top: 118`, a hand-added figure for the app nav plus the bar —
  // and the bar's height has changed three times since, each time leaving
  // the sidebar either floating in a gap or sliding under it. Measured, it
  // tracks whatever the bar becomes, including the taller wrapped row on a
  // narrow window.
  const [stickyTop, setStickyTop] = useState(118)
  useEffect(() => {
    const measure = () => {
      const el = toolbarRef.current
      if (!el) return
      // The bar is itself sticky at the nav's height, so its own bottom —
      // once it is pinned — is exactly where the sidebar's top belongs.
      // Read in CSS pixels, since that is what `top` takes here.
      const zoom = Number(
        getComputedStyle(document.documentElement).getPropertyValue('--app-zoom')
      ) || 1
      setStickyTop(el.getBoundingClientRect().height / zoom + 60)
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (ro && toolbarRef.current) ro.observe(toolbarRef.current)
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])


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

  // What the bar is titled. DECLARED AFTER `span`, which it reads:
  // `const` is not hoisted, so a useMemo placed above span's
  // declaration threw "Cannot access 'span' before initialization" on
  // the first render and took the whole tab down with it. The build and
  // the linter both passed — neither of them runs the component.
  //
  // What the bar is titled. Named from the SPAN, not from fromDay, so it
  // says what is actually on screen: picking Wednesday in week view shows
  // Mon–Sun and the title has to agree with the seven columns, not with
  // the day that was clicked.
  const rangeLabel = useMemo(() => {
    if (view === 'month') return fromDay.format('MMMM YYYY')
    // One day is a DATE, whichever view it came from. The People board on
    // "1 day" was titled "25 – 25 November 2026" — a range from a day to
    // itself.
    if (view === 'day' || span.days === 1) return span.from.format('ddd D MMMM YYYY')
    const to = span.from.add(span.days - 1, 'day')
    // "24 – 30 November 2026" rather than repeating the month and the year
    // on both ends, except across a boundary where both are needed.
    if (span.from.isSame(to, 'month')) {
      return `${span.from.format('D')} – ${to.format('D MMMM YYYY')}`
    }
    if (span.from.isSame(to, 'year')) {
      return `${span.from.format('D MMM')} – ${to.format('D MMM YYYY')}`
    }
    return `${span.from.format('D MMM YYYY')} – ${to.format('D MMM YYYY')}`
  }, [view, fromDay, span])

  const load = useCallback(async () => {
    // Already showing something? Then this is a refresh, not a load.
    if (hasDrawn.current) setRefreshing(true)
    else setLoading(true)
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
      hasDrawn.current = true
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [span, kind])

  useEffect(() => { load() }, [load])

  // The calendar list, once. It changes about never, and a failure here is
  // survivable: no Calendars section, everything still drawn, which is
  // better than an error over a filter.
  useEffect(() => {
    let live = true
    appointmentsAPI.calendars()
      .then((res) => { if (live) setCalendars(res.calendars || []) })
      .catch(() => { /* no section; the board is unaffected */ })
    return () => { live = false }
  }, [])

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

  const calendarCounts = useMemo(() => {
    const m = new Map()
    for (const a of data.appointments) {
      if (a.calendarId) m.set(a.calendarId, (m.get(a.calendarId) || 0) + 1)
    }
    return m
  }, [data.appointments])

  // Both cuts, applied together: a calendar narrows what KIND of thing is
  // shown, a person narrows WHO is going.
  const visible = useMemo(() => {
    const byPerson = people == null ? null : new Set(people)
    const byCalendar = selectedCalendars == null ? null : new Set(selectedCalendars)
    // Which calendars we actually have boxes for. An appointment on a
    // calendar that is NOT in the list — deleted in the CRM, or created
    // before it was — has no box to untick, so filtering it out would hide
    // it with no way to bring it back. Those always show.
    const known = new Set(calendars.map((c) => c.id))

    if (!byPerson && !byCalendar) return data.appointments
    return data.appointments.filter((a) => {
      if (byPerson && !byPerson.has(a.assignedUserId || UNASSIGNED)) return false
      if (byCalendar && a.calendarId && known.has(a.calendarId)
          && !byCalendar.has(a.calendarId)) return false
      return true
    })
  }, [data.appointments, people, selectedCalendars, calendars])

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
    <Shell style={CALENDAR_TYPE_SCALE}>
      <style>{REFRESH_CSS}</style>
      {/* STICKY. The month grid is six rows tall and the page scrolls behind
          it, which took the date, the view switcher and Book off the top of
          the screen — and the screenshot that reported this had the toolbar
          half cut off. The app's own nav is sticky at 60px, so this sits
          directly under it rather than at 0.

          The negative margins and matching padding let the background run
          to the full width of the page while the controls stay aligned with
          the grid: without them a card sliding under a transparent toolbar
          shows through it. */}
      <div
        ref={toolbarRef}
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)',
          alignItems: 'center',
          position: 'sticky', top: 60, zIndex: 6,
          // Padding left at space-2: the sidebar sticks at top 118, which
          // is the nav plus this bar, and growing it would slide the
          // sidebar underneath.
          margin: '0 -20px', padding: 'var(--space-2) 20px',
          // WHITE, not the page grey. antd's Segmented draws its own track
          // in a light grey, so on a grey bar the unselected options were
          // grey on grey — darkening the text helped and could not fix the
          // underlying problem, which was that the control had no edge. On
          // white the track reads as a control and its options separate
          // from it.
          //
          // It also makes the bar a bar. Sticky chrome that shares the
          // page's own colour does not look pinned, it looks like content
          // that failed to scroll.
          background: 'var(--surface-card)',
          borderBottom: '1px solid var(--border-default)'
        }}
      >
        {/* ── THREE ZONES, NOT SEVEN CONTROLS IN A ROW ─────────────
            Every control had the same weight, so the bar read as a pile of
            pills and Book — the only thing here that writes anything — was
            buried in the middle of it. Now: where you are on the left, how
            you are looking at it on the right, and the one action last.

            THE DATE PICKER IS GONE. It duplicated the sidebar's month,
            which is a better picker in every way — you can see the month
            while you choose from it. What the bar needed in its place was
            not another control but a TITLE, which is also what stops it
            looking assembled rather than designed. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Button onClick={() => setFromDay(dayjs().startOf('day'))}>Today</Button>
          {/* Icons, not the ‹ › characters: at this size a guillemet is a
              four-pixel mark in a 32px button and reads as a speck. */}
          <Button onClick={() => step(-1)} aria-label="Previous" icon={<LeftOutlined />} />
          <Button onClick={() => step(1)} aria-label="Next" icon={<RightOutlined />} />
        </div>

        {/* ONE LINE in every view. The zone note used to sit on a second
            line in Month only, so switching Week → Month made the whole
            page jump down ten pixels. It now sits beside the title. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--text-xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-heading)',
              whiteSpace: 'nowrap'
            }}
          >
            {rangeLabel}
          </h2>
          {/* The zone is stated ALWAYS, and exactly ONCE.
              
              A board silently drawn in the wrong timezone looks exactly
              like one drawn in the right timezone, so naming it is the
              only defence a reader has. But the time views now carry it at
              the head of their own hour gutter, which is a better place
              for it — beside the hours rather than up in the chrome — so
              repeating it here would just be two labels for one fact.

              The month view has no gutter to put it in, and a missing
              sub-account timezone is a WARNING rather than a label, so
              both of those still say it here. */}
          {(view === 'month' || data.timezone == null) && (
            <span
              title={`Times shown in ${zone}`}
              style={{
                fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0
              }}
            >
              Times shown in {zone}
              {data.timezone == null ? ' — this sub-account has no timezone set' : ''}
            </span>
          )}
        </div>

        <div
          style={{
            marginLeft: 'auto',
            display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            justifyContent: 'flex-end',
            // Allowed to shrink, so it WRAPS. As a flex item with the
            // default min-width it could not, and on the People board —
            // two extra controls — it overflowed the frame instead and
            // took Book off the right edge, where it could not be reached.
            flex: '1 1 auto', minWidth: 0,
            gap: 'var(--space-2)'
          }}
        >
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

          <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />

          {/* Only the People board has a span to choose, or empty columns
              worth hiding — the other views are named after their span and
              have no per-person columns at all. */}
          {view === 'people' && (
            <>
              <Segmented
                value={days}
                onChange={setDays}
                options={[{ label: '1 day', value: 1 }, { label: '3 days', value: 3 }]}
              />
              <Segmented
                value={hideEmpty ? 'busy' : 'all'}
                onChange={(v) => setHideEmpty(v === 'busy')}
                options={[
                  { label: 'Busy only', value: 'busy' },
                  { label: 'Everyone', value: 'all' }
                ]}
              />
            </>
          )}

          <Button
            type="primary"
            onClick={() => setBooking({ day: fromDay.format('YYYY-MM-DD') })}
          >
            Book
          </Button>
        </div>
      </div>

      <StateMessage
        loading={loading}
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
          <CalendarSidebar
            resources={data.resources}
            selected={people}
            onChange={setPeople}
            counts={counts}
            calendars={calendars}
            selectedCalendars={selectedCalendars}
            onChangeCalendars={setSelectedCalendars}
            calendarCounts={calendarCounts}
            day={fromDay}
            span={span}
            zone={zone}
            onPickDay={setFromDay}
            stickyTop={stickyTop}
            maxHeight={`calc(100vh / var(--app-zoom) - ${Math.round(stickyTop) + 12}px)`}
          />
        )}

        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {/* A refresh in progress. Absolute, so it costs no layout — the
              grid does not move by a pixel while it is up, which is the
              whole point. */}
          {refreshing && (
            <div
              role="status"
              aria-label="Updating"
              style={{
                position: 'absolute', top: -3, left: 0, right: 0, height: 3,
                borderRadius: 'var(--radius-pill)',
                overflow: 'hidden', zIndex: 5,
                background: 'var(--border-default)'
              }}
            >
              <span className="pp-cal-refresh" />
            </div>
          )}

      {hasBoard && view === 'month' && (
        <MonthGrid
          appointments={visible}
          zone={zone}
          fromDay={fromDay}
          // Same list the week view colours its bars from, so a rep is the
          // same colour in both — the dot and the bar must agree or the
          // colour coding is worse than none.
          resources={data.resources}
          busyIds={busyIds}
          onOpenDeal={onOpenDeal}
          onMove={handleMove}
          onBookAt={setBooking}
          // "+N more" drops into that day rather than trying to grow the
          // cell — a month row that expands pushes the weeks below it off
          // screen, which is worse than one more click.
          onOpenDay={(day) => { setFromDay(dayjs(day)); setView('day') }}
          draft={draft}
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
          draft={draft}
          topRef={toolbarRef}
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
          maxHeight={`calc(100vh / var(--app-zoom) - ${Math.round(stickyTop) + 20}px)`}
          onOpenDeal={onOpenDeal}
          onMove={handleMove}
          onSetStatus={handleSetStatus}
          onBookAt={setBooking}
          draft={draft}
        />
      )}

        </div>
      </div>

      {booking && (
        <BookAppointment
          initial={booking}
          onDraft={setDraft}
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

// An indeterminate strip: we do not know how long the fetch will take, so a
// percentage would be a lie. It travels rather than fills.
//
// prefers-reduced-motion gets a static tinted bar instead — still visible as
// "something is happening", with nothing moving. A looping animation is
// exactly what that setting exists to switch off.
const REFRESH_CSS = `
/* ── A BOOKED SLOT IS COLOURED, AND IT IS ONE COLOUR ─────────────────
 *
 * White cards on a white grid made every booking the same object and
 * left the grid reading as empty at a glance — which is the one thing a
 * week view must never do. So a live booking is filled again.
 *
 * It is filled with a WASH OF ITS OWN BAR, not with a second colour.
 * That is the whole point: --pp-accent is set once, inline, from the
 * person (time views) or the status (resource board, where the column
 * already says who), and both the fill and the 4px edge are derived
 * from that one value. They cannot drift apart the way a hand-paired
 * tint and bar did.
 *
 * The first declaration is the fallback. color-mix landed in Chrome
 * 111, Safari 16.2 and Firefox 113; anything older ignores the second
 * line and gets the white card, which is legible rather than broken.
 *
 * 14% measured across all nine hues in PERSON_COLOURS: the heading
 * (--text-heading) sits at 12.6:1 at worst, the second line
 * (--text-body) at 9.6:1. The card's second line used to be
 * --text-muted, which is 4.69:1 on plain white and fell to 4.12 on
 * these fills — so it moved to --text-body rather than the fill being
 * weakened. Any tint at all breaks --text-muted here; that is a fact
 * about the token, not about this percentage.
 */
.pp-appt {
  background: var(--surface-card);
  background: color-mix(in srgb, var(--pp-accent) 14%, #fff);
}
/* The chips in a month cell, same rule at half strength — four of these
 * stack in one 116px cell, and at full strength the cell became a block
 * of colour whose shape said nothing. */
.pp-appt-chip {
  background: var(--surface-card);
  background: color-mix(in srgb, var(--pp-accent) 10%, #fff);
}

@keyframes pp-cal-refresh {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
.pp-cal-refresh {
  display: block;
  width: 25%;
  height: 100%;
  background: var(--brand-primary);
  animation: pp-cal-refresh 1.1s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .pp-cal-refresh {
    width: 100%;
    animation: none;
    opacity: 0.55;
  }
}
`
