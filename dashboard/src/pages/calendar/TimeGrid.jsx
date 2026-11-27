import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppointmentCard from './AppointmentCard'
import DraftSlot from './DraftSlot'
import { colourOfAppointment, BLOCKED_HATCH } from './calendarColours'
import {
  DAY_START_MIN, DAY_END_MIN, WORK_START_MIN, WORK_END_MIN,
  boardHeightPx, hourMarks, clampToWindow,
  groupByDay, isLong, longSpan, longStartPiece, longEndPiece, dailyWindow, dailyPieces, minutesForDrop, isRealMove, movePatch, PIXELS_PER_MINUTE
} from './boardLayout'
import {
  isoForSlot, minutesNow, dayKeyNow, inZone, zoneAbbrev, dayKey, clockTime
} from '../../utils/calendarTime'
import { offsetY } from './pointer'
import { Popover } from 'antd'
import AppointmentDetail from './AppointmentDetail'

// The day and week views — the shape everybody already knows from Google
// Calendar: days across the top, hours down the side, appointments in the
// grid where they fall.
//
// ── HOW THIS DIFFERS FROM THE RESOURCE BOARD ─────────────────────────
//
// Both draw a time grid, and they answer different questions, which is why
// both exist rather than one being a setting on the other:
//
//   this        a column per DAY, everyone's work together. "What is
//               happening this week?" Dragging moves work in TIME.
//   the board   a column per PERSON, one day at a time. "Who should take
//               this?" Dragging sideways moves work between PEOPLE.
//
// So a drop here never changes who owns an appointment. Moving it to
// Thursday should not also reassign it to whoever happens to be in the
// column you dropped on — there is no such person; the column is a day.
//
// ── OVERLAPS MATTER MORE HERE ────────────────────────────────────────
//
// A week column holds every rep's bookings at once, so four people out at
// 10am is the normal case rather than the exception. The lane packing from
// boardLayout puts them abreast; stacked, three of the four would be
// invisible and the day would look quiet.

const HEADER_H = 58
const GUTTER_W = 56

export default function TimeGrid({
  appointments, resources = [], zone, fromDay, days = 7,
  // Map(calendarId → colour) from calendarColours.js: each booking is drawn
  // in its calendar's colour.
  calendarColours = null,
  onOpenDeal, onMove, onSetStatus, onOpenLinks, onBookAt, busyIds,
  // The slot currently being booked, if the card is open: see DraftSlot.
  draft,
  // The sticky toolbar above. The grid's height is the room below it, and
  // that cannot be worked out from the grid alone once the page scrolls.
  topRef
}) {
  const dragging = useRef(null)
  const [hover, setHover] = useState(null)
  // Where the pointer went down, so a click that was really the end of a
  // drag does not open the booking form. Google opens on a plain click and
  // so do we, which only works if the two are told apart.
  const pressedAt = useRef(null)

  const dayKeys = useMemo(() => {
    const out = []
    for (let i = 0; i < days; i++) out.push(fromDay.add(i, 'day').format('YYYY-MM-DD'))
    return out
  }, [fromDay, days])

  // Days-long appointments, two kinds (see dailyWindow in boardLayout):
  //   daily     a window like 10:30–11:00 across several days — drawn at
  //             that window on EVERY day it covers, in the timeline
  //   spanning  genuinely all-day — a bar in the strip under the headings,
  //             with start and end markers in the timeline
  const timed = useMemo(() => appointments.filter((a) => !isLong(a)), [appointments])
  const daily = useMemo(
    () => appointments.filter((a) => isLong(a) && dailyWindow(a, zone)),
    [appointments, zone]
  )
  const long = useMemo(
    () => appointments.filter((a) => isLong(a) && !dailyWindow(a, zone)),
    [appointments, zone]
  )
  // ── ONE BAR, NOT A CARD PER DAY ────────────────────────────────────
  // A daily-window booking (10:30–11:00 from Tuesday to Monday) was six
  // identical cards side by side. GHL draws the same booking as ONE bar,
  // and that is clearer: one thing, one shape. So when it can be, it is a
  // single bar across the days it covers, sitting in its 10:30–11:00 row.
  //
  // "When it can be": nothing else on any of those days may overlap that
  // window — a bar spanning the columns cannot lane-pack, and would sit on
  // top of whatever else is at 10:30. A booking that would collide falls
  // back to one card per day, which CAN share the slot with its
  // neighbours. A one-day view has nothing to combine.
  const minutesFromMidnightOf = (iso) => { const t = inZone(iso, zone); return t.hour() * 60 + t.minute() }

  const { cells, combined } = useMemo(() => {
    const markers = [
      ...long.map(longStartPiece),
      ...long.map((a) => longEndPiece(a, zone)).filter(Boolean)
    ]
    const piecesOf = new Map(daily.map((a) => [a.id, dailyPieces(a, dayKeys, zone)]))
    const overlaps = (x, y) => Date.parse(x.startsAt) < Date.parse(y.endsAt)
      && Date.parse(x.endsAt) > Date.parse(y.startsAt)
    const others = (id) => [
      ...timed, ...markers,
      ...daily.filter((d) => d.id !== id).flatMap((d) => piecesOf.get(d.id))
    ]
    const bars = []
    const loose = []
    for (const a of daily) {
      const pieces = piecesOf.get(a.id)
      const rest = others(a.id)
      const clash = pieces.some((p) => rest.some((o) => overlaps(p, o)))
      if (pieces.length >= 2 && !clash) {
        const first = dayKey(pieces[0].startsAt, zone)
        const last = dayKey(pieces[pieces.length - 1].startsAt, zone)
        bars.push({
          a,
          from: dayKeys.indexOf(first),
          to: dayKeys.indexOf(last),
          piece: pieces[0],
          clippedStart: dayKey(a.startsAt, zone) < dayKeys[0],
          clippedEnd: dayKey(a.endsAt, zone) > dayKeys[dayKeys.length - 1]
        })
      } else {
        loose.push(...pieces)
      }
    }
    return {
      cells: groupByDay([...timed, ...loose, ...markers], zone),
      combined: bars
    }
  }, [timed, daily, long, dayKeys, zone])

  const [nowMin, setNowMin] = useState(() => minutesNow(zone))
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(minutesNow(zone)), 60000)
    return () => window.clearInterval(id)
  }, [zone])
  const todayKey = dayKeyNow(zone)

  const height = boardHeightPx()
  const marks = hourMarks()

  // Open where the work is, not at 07:00.
  //
  // Google scrolls to roughly now, and the reason is the same here: the top
  // of the grid is the hour least likely to hold anything, so a view that
  // opens there spends its first impression on empty space. An hour before
  // now gives a little context behind the current time; outside working
  // hours it falls back to 08:00 rather than parking at midnight-adjacent
  // emptiness.
  const scroller = useRef(null)

  // ── HOW TALL THE GRID IS ALLOWED TO BE, MEASURED ────────────────────
  //
  // It was `calc(100vh / var(--app-zoom) - 250px)`. The 250 was a guess at
  // the chrome above the grid, and a guess is exactly what it could not
  // be: the toolbar, the Shell padding and the GHL iframe's own header all
  // changed since it was written, so the grid ran past the bottom of the
  // window and the last hours were unreachable — the scroll looked broken
  // because the thing it was scrolling inside was already too tall.
  //
  // Measuring the scroller's own top removes the guess entirely. Whatever
  // is above it, of whatever height, this is the room that is left.
  //
  // DIVIDED BY THE ZOOM, because getBoundingClientRect and innerHeight are
  // real pixels while a px height set on an element inside the zoomed body
  // is scaled by it. The zoom is read from the custom property so it
  // follows the Appearance setting rather than assuming 0.85.
  const [maxH, setMaxH] = useState(null)
  useEffect(() => {
    const measure = () => {
      const el = scroller.current
      if (!el) return
      const zoom = Number(
        getComputedStyle(document.documentElement).getPropertyValue('--app-zoom')
      ) || 1

      // ── WHY THE PREVIOUS MEASUREMENT WAS STILL WRONG ──────────────
      //
      // It used the scroller's own top, measured once. But THE PAGE
      // SCROLLS: as you scroll down, the grid's top rises towards zero
      // and then past it, so the room below it appears to grow and the
      // grid was sized for space it did not have. Hence still cut off,
      // and worse the further down you had scrolled.
      //
      // The grid can never actually rise above the sticky chrome — the
      // app nav and the calendar toolbar are pinned there — so the real
      // ceiling is the bottom of that chrome, not the element's own
      // position. Measured from the toolbar itself rather than assumed,
      // since its height changes when the row wraps.
      const chromeBottom = topRef?.current?.getBoundingClientRect().bottom ?? 0
      const top = Math.max(el.getBoundingClientRect().top, chromeBottom)
      // A little air under the grid so it does not sit flush on the edge.
      const room = window.innerHeight - top - 16
      setMaxH(Math.max(360, room / zoom))
    }
    // Twice: once now, once after layout has settled. Fonts and the
    // sidebar arriving a frame later both move the chrome, and a single
    // early measurement banks a top that is about to change.
    measure()
    const raf = requestAnimationFrame(measure)

    window.addEventListener('resize', measure)
    // THE SCROLL LISTENER IS THE FIX, not an optimisation: the numbers
    // above are only true for the current scroll position.
    window.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measure)
      : null
    if (ro && topRef?.current) ro.observe(topRef.current)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [topRef])

  const scrolledOnce = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || scrolledOnce.current) return
    scrolledOnce.current = true
    // An hour before now, so the next appointment is in view rather than
    // level with the top edge.
    //
    // There is no longer an "outside the window" case to fall back from —
    // the grid covers the whole day — and with 24 hours on it, WHERE IT
    // OPENS is what keeps the working day on screen. That is the job the
    // 07:00–20:00 window used to do by hiding the rest.
    el.scrollTop = Math.max(0, (nowMin - 60 - DAY_START_MIN) * PIXELS_PER_MINUTE)
    // Mount only: re-running would yank the grid back every minute when the
    // now-line ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = useCallback((e, day) => {
    e.preventDefault()
    const drag = dragging.current
    setHover(null)
    if (!drag) return
    dragging.current = null

    const minutes = minutesForDrop(offsetY(e, e.currentTarget), drag.grabOffset)
    // THE OWNER IS CARRIED, NOT TAKEN FROM THE COLUMN. See the note above:
    // a column here is a day, not a person, so there is nobody to reassign
    // to. Passing the appointment's own owner means movePatch sees no change
    // and sends only the times.
    const target = { day, minutes, userId: drag.appointment.assignedUserId || null }

    if (!isRealMove(drag.appointment, target, zone)) return
    const patch = movePatch(drag.appointment, target, zone, isoForSlot)
    if (Object.keys(patch).length === 0) return
    onMove?.(drag.appointment, patch, target)
  }, [zone, onMove])

  const colWidth = `calc((100% - ${GUTTER_W}px) / ${days})`

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--surface-card)'
      }}
    >
      {/* Day headings. Sticky so they survive scrolling a tall day. */}
      <div
        style={{
          display: 'flex',
          position: 'sticky', top: 0, zIndex: 3,
          background: 'var(--surface-card)',
          borderBottom: '1px solid var(--border-default)'
        }}
      >
        {/* Lines up with the hour gutter below, and names the zone those
            hours are in — where Google puts it, and the only place it can
            go that a reader cannot mistake for anything else: directly
            above the column of times it qualifies.

            Read for the FIRST DAY DRAWN, not for today. A week in July is
            labelled BST even when it is looked at in January; see
            zoneAbbrev. The full IANA name is on the title, because three
            letters say "not your clock" but do not say which clock. */}
        <div
          title={`Times shown in ${zone}`}
          style={{
            width: GUTTER_W, flex: `0 0 ${GUTTER_W}px`,
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
            boxSizing: 'border-box',
            padding: '0 6px 6px 0',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-faint)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}
        >
          {zoneAbbrev(zone, dayKeys[0] ? `${dayKeys[0]}T12:00:00Z` : undefined)}
        </div>
        {dayKeys.map((day) => {
          const d = inZone(`${day}T12:00:00`, zone)
          const isToday = day === todayKey
          return (
            <div
              key={day}
              style={{
                flex: `0 0 ${colWidth}`, width: colWidth,
                boxSizing: 'border-box',
                height: HEADER_H,
                padding: '6px 4px',
                borderLeft: '1px solid var(--border-default)',
                textAlign: 'center'
              }}
            >
              <div
                style={{
                  fontSize: 'var(--text-xs)',
                  letterSpacing: 'var(--tracking-label)',
                  textTransform: 'uppercase',
                  color: isToday ? 'var(--brand-primary)' : 'var(--text-faint)'
                }}
              >
                {d.format('ddd')}
              </div>
              {/* Today's date in a filled disc, as Google draws it — the one
                  piece of chrome everybody already reads without thinking. */}
              <div
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 26, height: 26, marginTop: 2,
                  borderRadius: 'var(--radius-pill)',
                  background: isToday ? 'var(--brand-primary)' : 'transparent',
                  color: isToday ? '#fff' : 'var(--text-heading)',
                  fontSize: 'var(--text-lg)',
                  fontWeight: isToday ? 'var(--weight-semibold)' : 'var(--weight-regular)'
                }}
              >
                {d.format('D')}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── THE MULTI-DAY STRIP ──────────────────────────────────────
          One bar per appointment that lasts a day or more, across the
          days it covers, the way Google draws them. Outside the scroller,
          so it stays in view while the hours scroll — and it is measured
          automatically, since the grid sizes itself from its own top. */}
      {(() => {
        const bars = long
          .map((a) => ({ a, span: longSpan(a, dayKeys, zone) }))
          .filter((b) => b.span)
        if (bars.length === 0) return null
        return (
          <div
            style={{
              position: 'relative',
              padding: '4px 0',
              borderBottom: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
              display: 'grid', gap: 3
            }}
          >
            <div
              aria-hidden
              style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: GUTTER_W,
                borderRight: '1px solid var(--border-default)'
              }}
            />
            {bars.map(({ a, span }) => {
              const accent = colourOfAppointment(calendarColours, a._whole || a)
              const cancelled = (a.status || '').toLowerCase() === 'cancelled'
              const name = a.contactName || a.title || 'Appointment'
              return (
                <div key={a.id} style={{ position: 'relative', height: 24 }}>
                  <Popover
                    content={<AppointmentDetail appointment={a} zone={zone} accent={accent} />}
                    trigger="hover"
                    mouseEnterDelay={0.35}
                    rootClassName="pp-portal"
                    styles={{ body: { padding: 'var(--space-4)' } }}
                  >
                    <button
                      type="button"
                      className={cancelled ? undefined : 'pp-appt'}
                      data-noclip=""
                      onClick={() => { if (a.dealId) onOpenDeal?.(a.dealId) }}
                      style={{
                        '--pp-accent': accent,
                        position: 'absolute', top: 0, bottom: 0,
                        left: `calc(${GUTTER_W}px + (100% - ${GUTTER_W}px) * ${span.from} / ${days} + 2px)`,
                        width: `calc((100% - ${GUTTER_W}px) * ${span.to - span.from + 1} / ${days} - 4px)`,
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '0 8px',
                        border: '1px solid var(--border-strong)',
                        borderLeft: `4px solid ${accent}`,
                        // A bar that carries on past the visible days says
                        // so with a square edge on that side.
                        borderRadius: `${span.clippedStart ? 0 : 6}px ${span.clippedEnd ? 0 : 6}px ${span.clippedEnd ? 0 : 6}px ${span.clippedStart ? 0 : 6}px`,
                        background: cancelled ? 'var(--surface-card)' : undefined,
                        backgroundImage: a.kind === 'blocked' ? BLOCKED_HATCH : undefined,
                        fontSize: 'var(--text-xs)', color: 'var(--text-heading)',
                        fontWeight: 'var(--weight-semibold)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        textDecoration: cancelled ? 'line-through' : 'none',
                        cursor: a.dealId ? 'pointer' : 'default',
                        textAlign: 'left'
                      }}
                    >
                      {span.clippedStart && <span aria-hidden>←</span>}
                      {/* The NAME keeps its room; the dates give theirs up.
                          On a week where the booking covers one day the bar
                          is one column wide, and the dates — which do not
                          shrink by default — squeezed the name to nothing:
                          a bar of times with no one's name on it. */}
                      <span style={{ flex: '0 1 auto', minWidth: 40, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                      <span
                        style={{
                          flex: '0 100 auto', minWidth: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          fontWeight: 'var(--weight-regular)', color: 'var(--text-muted)'
                        }}
                      >
                        {inZone(a.startsAt, zone).format('ddd D MMM HH:mm')}
                        {' → '}
                        {inZone(a.endsAt, zone).format('ddd D MMM HH:mm')}
                      </span>
                      {span.clippedEnd && <span aria-hidden style={{ marginLeft: 'auto' }}>→</span>}
                    </button>
                  </Popover>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* THE GRID SCROLLS INSIDE ITSELF, and the day headings above do not.
          
          Thirteen hours at this scale is about 860 pixels, which inside the
          GHL iframe is taller than the viewport — so the grid was being cut
          off at both ends with no way to reach either. Letting the PAGE
          scroll instead would take the day headings away with it, and a week
          grid whose columns are unlabelled is unreadable.

          The height is MEASURED rather than calculated from a guess at the
          chrome above — see the note on maxH. The floor keeps it usable on
          a short window rather than collapsing to nothing. */}
      <div
        ref={scroller}
        style={{
          display: 'flex', position: 'relative',
          maxHeight: maxH ? `${Math.round(maxH)}px` : '70vh',
          overflowY: 'auto'
        }}
      >
        <div
          style={{
            width: GUTTER_W, flex: `0 0 ${GUTTER_W}px`,
            height,
            background: 'var(--surface-card)',
            borderRight: '1px solid var(--border-default)',
            // Sticky, so the hours stay readable while the week is scrolled
            // sideways on a narrow window. Without it the gutter slides
            // away and you are reading an unlabelled grid.
            position: 'sticky', left: 0, zIndex: 3
          }}
        >
          {/* ── THE LABEL SITS BELOW ITS LINE, NOT ABOVE IT ────────
              It was `m.top - 7`, centred on the hour line — which looks
              right everywhere except the first one, where it is 7px
              outside the scroll box and gets sliced in half. Padding the
              box only moved the problem; the geometry was the problem.

              Below is also what Google does, and it is better for a
              different reason: a label under the line belongs to the hour
              it opens, so "09:00" sits at the top of the 9 o'clock slot
              rather than straddling the boundary between 8 and 9. The last
              mark is the only one that then has nothing under it, so it is
              dropped — "24:00" labelled a zero-height slot. */}
          {marks.slice(0, -1).map((m) => (
            <div
              key={m.minutes}
              style={{
                position: 'absolute', top: m.top + 3, right: 8,
                fontSize: 'var(--text-xs)',
                color: m.minutes >= WORK_START_MIN && m.minutes < WORK_END_MIN
                  ? 'var(--text-muted)'
                  // The working day, now that no shading says it. With the
                  // grid one flat white, the gutter is where 09:00 is told
                  // from 03:00 — so the hours inside it are set a step
                  // darker and the night recedes. It is the whole
                  // off-hours cue in two tokens.
                  : 'var(--text-faint)',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {m.label}
            </div>
          ))}
        </div>

        {dayKeys.map((day) => {
          const items = cells.get(day) || []
          const isToday = day === todayKey
          return (
            <div
              key={day}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (hover !== day) setHover(day)
              }}
              onDragLeave={() => setHover((h) => (h === day ? null : h))}
              onDrop={(e) => handleDrop(e, day)}
              onMouseDown={(e) => {
                pressedAt.current = { x: e.clientX, y: e.clientY, target: e.target }
              }}
              onClick={(e) => {
                // A SINGLE click books, the way Google does — but only a real
                // click on empty grid. Two guards, both earned: a click that
                // travelled more than a few pixels was the tail of a drag,
                // and a click that started on a card belongs to the card.
                if (!onBookAt) return
                const down = pressedAt.current
                pressedAt.current = null
                if (!down) return
                if (down.target !== e.currentTarget) return
                if (e.target !== e.currentTarget) return
                const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y)
                if (moved > 4) return
                onBookAt({
                  day,
                  minutes: minutesForDrop(offsetY(e, e.currentTarget)),
                  userId: null,
                  // Where to spring the card from, so it reads as belonging
                  // to the slot that was clicked rather than to the page.
                  anchor: { x: e.clientX, y: e.clientY }
                })
              }}
              style={{
                flex: `0 0 ${colWidth}`, width: colWidth,
                boxSizing: 'border-box',
                position: 'relative', height,
                borderLeft: '1px solid var(--border-default)',
                // ── TODAY IS NOT A TINTED COLUMN ────────────────────
                //
                // It was var(--tint-sky) down the whole height, which is
                // what Google's week view looks like it does and does not.
                // Google's day columns are all the same white; the pale
                // blue strips in its grid are the gaps BETWEEN columns, on
                // every day equally. Today is marked once, in the header,
                // by the circled date — and by the red now-line, which
                // says where in today you are as well as which day it is.
                //
                // The tint cost more than it looked. A column with a
                // background is a column whose cards sit on a different
                // colour from every other day's, so the status tints that
                // tell a cancelled visit from a confirmed one read
                // differently on today than on tomorrow. The one day a
                // dispatcher looks at hardest was the one day the colour
                // coding was off.
                background: hover === day
                  ? 'var(--surface-selected)'
                  : 'var(--surface-card)',
                cursor: onBookAt ? 'cell' : 'default',
                transition: 'background 90ms linear'
              }}
            >
              {/* ── ONE WHITE SURFACE ────────────────────────────────
                  There were three greys here and they are all gone: two
                  bands shading the hours outside 07:00–20:00, and a half
                  strength wash over Saturday and Sunday.

                  Each was defensible on its own and together they made the
                  grid a patchwork — five different backgrounds across one
                  week, so a card at 6am on a Saturday sat on a third
                  colour that no card at 10am on a Tuesday ever sat on.
                  Google's week is one white sheet and the structure comes
                  entirely from the rules: hairlines between the days,
                  hairlines between the hours. That is enough, and it is
                  the only version where every card is on the same ground.

                  What the off-hours shading did well — finding the working
                  day in a 24 hour column — the hour labels and the
                  half-hour rules still do: half-hour lines are drawn
                  inside working hours only, so the part of the day that
                  matters is visibly finer-grained than 3am. */}
              {marks.map((m) => (
                <React.Fragment key={m.minutes}>
                  <div
                    style={{
                      position: 'absolute', top: m.top, left: 0, right: 0,
                      borderTop: '1px solid var(--border-default)',
                      pointerEvents: 'none'
                    }}
                  />
                  {/* The half-hour, inside working hours only. It is a
                      drop target guide, and at 3am there is nothing to
                      guide — 48 lines down an empty night was just noise.
                      Dropped to a faint solid: a dotted rule at this
                      spacing shimmers against the hour lines. */}
                  {m.minutes >= WORK_START_MIN && m.minutes < WORK_END_MIN && (
                    <div
                      style={{
                        position: 'absolute',
                        top: m.top + 30 * PIXELS_PER_MINUTE,
                        left: 0, right: 0,
                        borderTop: '1px solid var(--gray-100)',
                        pointerEvents: 'none'
                      }}
                    />
                  )}
                </React.Fragment>
              ))}

              {isToday && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN && (
                <div
                  aria-hidden
                  style={{
                    position: 'absolute', left: 0, right: 0,
                    top: (nowMin - DAY_START_MIN) * PIXELS_PER_MINUTE,
                    borderTop: '2px solid var(--status-stuck)',
                    pointerEvents: 'none', zIndex: 2
                  }}
                >
                  {/* The dot on the left, as Google has it — it is what makes
                      the line read as "now" rather than as a divider. */}
                  <span
                    style={{
                      position: 'absolute', left: -5, top: -5,
                      width: 9, height: 9, borderRadius: '50%',
                      background: 'var(--status-stuck)'
                    }}
                  />
                </div>
              )}

              {/* The slot being booked, drawn before the real cards so a
                  booking that overlaps one is visibly on top of it. */}
              {draft && draft.day === day && (() => {
                const start = draft.minutes
                const end = start + (draft.duration || 30)
                const geo = clampToWindow(start, end)
                return (
                  <DraftSlot
                    top={geo.top}
                    height={geo.height}
                    startMin={start}
                    endMin={end}
                    title={draft.title}
                    colour={draft.colour}
                  />
                )
              })()}

              {items.map((item) => {
                const geo = clampToWindow(item.startMin, item.endMin)
                return (
                  <AppointmentCard
                    key={item.id}
                    appointment={item}
                    zone={zone}
                    top={geo.top}
                    height={geo.height}
                    clippedBefore={geo.clippedBefore}
                    clippedAfter={geo.clippedAfter}
                    lane={item.lane}
                    lanes={item.lanes}
                    busy={busyIds?.has(item.id)}
                    onOpenDeal={onOpenDeal}
                    onSetStatus={onSetStatus}
                    onOpenLinks={onOpenLinks}
                    showOwner
                    accent={colourOfAppointment(calendarColours, item._whole || item)}
                    onDragStart={(appointment, grabOffset) => {
                      dragging.current = { appointment, grabOffset }
                    }}
                  />
                )
              })}
            </div>
          )
        })}

        {/* Daily-window bookings that combine into one bar — see the note
            on `combined` above. In the scroller, so they scroll with the
            hours; positioned on the same minute scale as the cards. */}
        {combined.map(({ a, from, to, piece, clippedStart, clippedEnd }) => {
          const accent = colourOfAppointment(calendarColours, a._whole || a)
          const startMin = minutesFromMidnightOf(piece.startsAt)
          const endMin = startMin + Math.round((Date.parse(piece.endsAt) - Date.parse(piece.startsAt)) / 60000)
          const cancelled = (a.status || '').toLowerCase() === 'cancelled'
          return (
            <Popover
              key={`bar-${a.id}`}
              content={<AppointmentDetail appointment={a} zone={zone} accent={accent} />}
              trigger="hover"
              mouseEnterDelay={0.35}
              rootClassName="pp-portal"
              styles={{ body: { padding: 'var(--space-4)' } }}
            >
              <button
                type="button"
                className={cancelled ? undefined : 'pp-appt'}
                data-noclip=""
                onClick={() => { if (a.dealId) onOpenDeal?.(a.dealId) }}
                style={{
                  '--pp-accent': accent,
                  position: 'absolute', zIndex: 2,
                  top: (startMin - DAY_START_MIN) * PIXELS_PER_MINUTE,
                  height: Math.max(22, (endMin - startMin) * PIXELS_PER_MINUTE),
                  left: `calc(${GUTTER_W}px + (100% - ${GUTTER_W}px) * ${from} / ${days} + 2px)`,
                  width: `calc((100% - ${GUTTER_W}px) * ${to - from + 1} / ${days} - 4px)`,
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '0 10px',
                  border: '1px solid var(--border-strong)',
                  borderLeft: `4px solid ${accent}`,
                  borderRadius: `${clippedStart ? 0 : 6}px ${clippedEnd ? 0 : 6}px ${clippedEnd ? 0 : 6}px ${clippedStart ? 0 : 6}px`,
                  background: cancelled ? 'var(--surface-card)' : undefined,
                  backgroundImage: a.kind === 'blocked' ? BLOCKED_HATCH : undefined,
                  textDecoration: cancelled ? 'line-through' : 'none',
                  fontSize: 'var(--text-xs)', color: 'var(--text-heading)',
                  textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden',
                  cursor: a.dealId ? 'pointer' : 'default'
                }}
              >
                {clippedStart && <span aria-hidden>←</span>}
                <span style={{ fontWeight: 'var(--weight-semibold)', flex: '0 1 auto', minWidth: 40, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {clockTime(piece.startsAt, zone)}–{clockTime(piece.endsAt, zone)} {a.contactName || a.title || 'Appointment'}
                </span>
                <span style={{ color: 'var(--text-muted)', flex: '0 100 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Daily, {inZone(a.startsAt, zone).format('ddd D MMM')} → {inZone(a.endsAt, zone).format('ddd D MMM')}
                </span>
                {clippedEnd && <span aria-hidden style={{ marginLeft: 'auto' }}>→</span>}
              </button>
            </Popover>
          )
        })}
      </div>
    </div>
  )
}
