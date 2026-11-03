import React, { useEffect, useState } from 'react'
import { dealsAPI } from '../../api/deals'
import { useAuth } from '../../context/AuthContext'

// Home — the landing page the client's nav adds (Oct 2026 design).
//
// A SWITCHBOARD, not a dashboard. Every card is a door to one tab, with the
// location-wide count the nav chips already show and one line saying what is
// behind it. There is nothing here to fetch beyond the signed-in user's name
// — the counts arrive from the shell, which already loads them for the nav.
//
// Grouped the way the design groups them: records → work → insights →
// settings, each with a label and a one-line reading of what the group is
// for. The order is deliberate — a rep lands here and reads "people, then
// deals, then questions about them".

// Where each card goes, what it is called, and how it is coloured. `accent`
// names a --panel-head-* band (the same solid the tab's own header wears, so
// a card and the page it opens read as one colour); `tint` draws the band
// as the accent's pale wash instead, for the two the design sets back.
const GROUPS = [
  {
    label: 'Records', blurb: 'People, companies and activity',
    cards: [
      { tab: 'contacts',   label: 'Contacts',   icon: 'group',        accent: 'sky',  count: 'contacts',
        blurb: 'People, their details and every deal they are linked to.' },
      { tab: 'businesses', label: 'Businesses', icon: 'domain',       accent: 'plum', count: 'businesses',
        blurb: 'Companies and households, with contacts, deals and tasks grouped.' },
      { tab: 'tasks',      label: 'Tasks',      icon: 'task_alt',     accent: 'clay', count: 'tasks',
        blurb: 'Open, overdue and completed tasks across all deals.' },
      { tab: 'notes',      label: 'Notes',      icon: 'sticky_note_2', accent: 'brown', count: 'notes',
        blurb: 'Every note, colour-coded and searchable.' }
    ]
  },
  {
    label: 'Work', blurb: 'Where deals get done',
    cards: [
      { tab: 'hub',   label: 'Deal hub', icon: 'space_dashboard', accent: 'pine',
        blurb: 'Everything on one deal: stage, people, tasks, notes and Co-Pilot.' },
      { tab: 'deals', label: 'Deals',    icon: 'sell',            accent: 'pine', count: 'deals',
        blurb: 'Pipeline board and list, filters, bulk actions.' }
    ]
  },
  {
    label: 'Insights', blurb: 'Ask questions and track trends',
    cards: [
      { tab: 'copilot',  label: 'Insights AI', icon: 'auto_awesome', accent: 'teal',
        blurb: 'Ask questions about your pipeline in plain English.' },
      { tab: 'insights', label: 'Insights',    icon: 'insights',     accent: 'plum', tint: true,
        blurb: 'Saved insight cards and pipeline trends.' }
    ]
  },
  {
    label: 'Settings', blurb: 'Configure the workspace',
    cards: [
      { tab: 'control', label: 'Control panel', icon: 'tune', accent: 'gray', tint: true,
        blurb: 'Pipelines, stages, fields and business context files.' }
    ]
  }
]

// "Good morning" until noon, "afternoon" until six, "evening" after.
function greetingFor(d = new Date()) {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// "Saturday 11 October 2026" — the design's long form. Intl rather than a
// hand-rolled formatter: the house formatDate is the short "11 Oct 2026"
// every list uses, and this is the one place the full date is the point.
const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
})

// First name only, title-cased — GHL stores whatever was typed ("jaladanki
// srinivas"), and a greeting wants "Jaladanki", not the whole record.
function firstNameOf(full) {
  const first = String(full || '').trim().split(/\s+/)[0]
  return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : null
}

export default function HomeTab({ counts, onOpenTab }) {
  const { session } = useAuth()

  // /me, not /users — same reason as the Co-Pilot sidebar: the users list is
  // the rep picker and excludes agency staff, who are often the ones signed
  // in. Quietly nameless on failure; "Good morning" alone is still right.
  const [name, setName] = useState(null)
  useEffect(() => {
    if (!session?.user?.id) return
    dealsAPI.me()
      .then((r) => setName(firstNameOf(r?.user?.name)))
      .catch(() => {})
  }, [session?.user?.id])

  return (
    <div style={{
      // The design's page: generous top margin, content on the left, the
      // grid capped so four record cards do not stretch across an ultrawide.
      padding: '40px 40px 56px',
      maxWidth: 1640, minWidth: 0
    }}>
      <h1 style={{
        margin: 0,
        fontSize: 'var(--text-display)', fontWeight: 600,
        letterSpacing: '-0.02em', lineHeight: 1.2,
        color: 'var(--text-heading)'
      }}>
        {greetingFor()}{name ? `, ${name}` : ''}
      </h1>
      <p style={{
        margin: '8px 0 0',
        fontSize: 'var(--text-lg)', color: 'var(--text-muted)'
      }}>
        {LONG_DATE.format(new Date())} · Where do you want to go?
      </p>

      {GROUPS.map((g) => (
        <section key={g.label} style={{ marginTop: 36 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 12,
            paddingBottom: 10, marginBottom: 20,
            borderBottom: '1px solid var(--border-default)'
          }}>
            <span style={{
              fontSize: 'var(--text-sm)', fontWeight: 600,
              letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
              color: 'var(--text-muted)'
            }}>
              {g.label}
            </span>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
              {g.blurb}
            </span>
          </div>

          <div style={{
            display: 'grid',
            // Fixed-width columns packed from the left, as the design lays
            // them: four records across, two work cards, one settings card —
            // never a lone card stretched to the page's full width.
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 385px))',
            gap: 20
          }}>
            {g.cards.map((c) => (
              <HomeCard
                key={c.tab}
                card={c}
                count={c.count && typeof counts?.[c.count] === 'number' ? counts[c.count] : null}
                onOpen={() => onOpenTab && onOpenTab(c.tab)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function HomeCard({ card, count, onOpen }) {
  const [lit, setLit] = useState(false)
  const { accent, tint } = card
  // The band: the tab's own solid header colour, or its pale tint for the
  // two cards the design sets back (Insights, Control panel). Grey has no
  // panel-head token; it falls through to the neutral pair.
  const band = tint
    ? (accent === 'gray' ? 'var(--gray-100)' : `var(--tint-${accent})`)
    : `var(--panel-head-${accent}, var(--accent-${accent}))`
  const ink = tint
    ? (accent === 'gray' ? 'var(--text-muted)' : `var(--accent-${accent}-text)`)
    : '#fff'
  // The card's own colour as its border when pointed at — the design's
  // "selected" state. A solid colour, not the band's tint, so the two
  // washed-out cards still get a definite edge.
  const edge = accent === 'gray' ? 'var(--border-strong)' : `var(--accent-${accent})`

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setLit(true)}
      onMouseLeave={() => setLit(false)}
      onFocus={() => setLit(true)}
      onBlur={() => setLit(false)}
      title={`Open ${card.label}`}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'stretch',
        padding: 0, textAlign: 'left',
        // 1.5px either way, so lighting the edge moves nothing.
        border: `1.5px solid ${lit ? edge : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        boxShadow: lit ? 'var(--shadow-raised)' : 'var(--shadow-card)',
        overflow: 'hidden', cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        transition: 'border-color 120ms ease, box-shadow 120ms ease'
      }}
    >
      <span style={{
        display: 'flex', alignItems: 'center', gap: 10,
        height: 64, padding: '0 20px',
        background: band, color: ink,
        borderBottom: tint ? '1px solid var(--border-default)' : 'none'
      }}>
        <span className="ms" style={{ fontSize: 22, flex: 'none' }}>{card.icon}</span>
        <span style={{ fontSize: 'var(--text-xl)', fontWeight: 600, minWidth: 0 }}>
          {card.label}
        </span>
        <span style={{ marginLeft: 'auto', flex: 'none', display: 'inline-flex' }}>
          {count != null ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              height: 26, padding: '0 12px',
              borderRadius: 'var(--radius-pill)',
              // A translucent white pill on the solid band, so the count
              // reads as part of the band rather than a sticker on it.
              background: 'rgba(255,255,255,0.22)',
              fontSize: 'var(--text-base)', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums'
            }}>
              {count}
            </span>
          ) : (
            <span className="ms" style={{ fontSize: 22 }}>arrow_forward</span>
          )}
        </span>
      </span>
      <span style={{
        display: 'block', padding: '20px 22px 22px',
        fontSize: 'var(--text-lg)', lineHeight: 1.5,
        color: 'var(--text-body)'
      }}>
        {card.blurb}
      </span>
    </button>
  )
}
