import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PanelHead from './PanelHead'
import { RichBody, StateMessage, AttachmentCount, formatDue, initialsFor } from '../shared/ListChrome'
import MessageAttachments from './MessageAttachments'
import AttachmentViewer from './AttachmentViewer'
import EmailThreadModal from './EmailThreadModal'
import EmailBody from './EmailBody'
import EmailThreadCard from './EmailThreadCard'
import MessageDealPill from './MessageDealPill'
import { noteColourStyle } from '../../utils/noteColour'
import { MentionText, commentHtmlToText } from '../../utils/mentions.jsx'
import { useAuth } from '../../context/AuthContext'
import { useModal } from '../../hooks/useModal'
import { COMMENT_TITLE } from './MessageComposer'

// One deal's merged message timeline.
//
// Row framing:
//   • the LEFT gutter square = the channel (email / sms / whatsapp / …)
//   • the CARD's top + bottom stripes = the channel accent (frames the row)
//   • the SENDER accent shows as a coloured dot beside the name
//   • the DEAL TAG lives on the bottom stripe as a pill footer
//
// The person filter narrows the merged thread (rule 7) but never splits it —
// group messages stay visible under every recipient, so filtering here is a
// simple boolean check per row, not a de-duplication.

// The soft fill behind a row's icon square and the darker accent that reads
// on it. accentVar gives the bare accent, which is fine for a glyph on
// gray-50 and NOT fine on its own tint — sky on tint-sky is 4.13:1, below AA.
// The -text variants exist for exactly this.
function tintVar(accent) {
  return !accent || accent === 'gray' ? 'var(--gray-50)' : `var(--tint-${accent})`
}
function accentTextVar(accent) {
  return !accent || accent === 'gray' ? 'var(--text-muted)' : `var(--accent-${accent}-text)`
}

const CH_LABEL = {
  EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp', IMESSAGE: 'iMessage',
  CALL: 'Call', NOTE: 'Note', ANALYSIS: 'Analysis', TASK: 'Task', SYSTEM: 'System',
  INTERNAL: 'Internal comment',
}

// An email in the timeline: subject, one preview line, expand for the rest.
//
// WHY IT NEEDS ITS OWN COMPONENT. Everything else here is a short message — an
// SMS, a WhatsApp line, a call summary — and a chat bubble suits all of them.
// An email is a document: GHL's payload for a three-paragraph update is 2KB of
// nested markup. Rendered as a bubble it pushed every surrounding row off
// screen, and the subject — the one thing a reader scans a mail list for — was
// not shown at all, because `subject` has been stored since migration 031 and
// the timeline query never selected it.
//
// DISPLAY ONLY, per the request. No reply, no forward: sending mail writes to
// GHL through a conversation-provider path this app does not have, and a
// button opening a composer we cannot send from is worse than no button.
// Group the timeline's emails by thread.
//
// Built once per message list and handed down, rather than each row scanning
// its siblings: a 200-row timeline would otherwise do 200 passes over 200
// rows on every render.
//
// Only threads with MORE THAN ONE message are returned. A thread of one is
// just an email — offering "1 in thread" on it would be a control that opens
// a dialog showing what the row already shows.
//
// Keyed by thread_id, which messageWriter reads from event.threadId. Emails
// without one (older syncs, or a channel that does not thread) simply never
// appear here and render as plain rows.
function buildThreads(list) {
  const byThread = new Map()
  for (const m of list) {
    if (m.channel !== 'EMAIL' || !m.threadId) continue
    const arr = byThread.get(m.threadId)
    if (arr) arr.push(m); else byThread.set(m.threadId, [m])
  }
  for (const [id, arr] of byThread) {
    if (arr.length < 2) byThread.delete(id)
  }
  return byThread
}


// Compact one-line renderer for system events and TYPE_ACTIVITY_* rows
// (opp created, task completed, invoice paid, etc). No card, no checkbox,
// just a thin line with icon + label + date on the spine.
// One header per day, sticky so the date stays visible while you scroll that
// day's messages. Replaces the per-row date gutter, which printed "19 Aug"
// three times for messages minutes apart.
// "16:59". The day header carries the date, so each row only needs its time.
function formatClock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function DayHeader({ iso }) {
  const d = new Date(iso)
  const label = (() => {
    if (Number.isNaN(d.getTime())) return 'Unknown date'
    const now = new Date()
    const startOf = (x) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())
    const days = Math.round((startOf(now) - startOf(d)) / 86400000)
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const yr = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`
    return `${d.getDate()} ${M[d.getMonth()]}${yr}`
  })()

  return (
    <div
      style={{
        // Sticks under the shell's nav, which wraps to two rows on a narrow
        // frame — so its height is measured (DealHubShell), not assumed.
        // Sticks to the top of the timeline's own scroll box, which is what
        // the day markers scroll within.
        position: 'sticky', top: 0, zIndex: 1,
        // A date marker, not a section heading. The full-height grey band
        // took 44px per day and read as a panel header; this is a small
        // pill sitting on a hairline, 28px tall, so the days punctuate the
        // thread instead of dividing it. White behind it so it still reads
        // when stuck over scrolling rows.
        display: 'flex', alignItems: 'center', gap: 10,
        height: 28, padding: '0 16px',
        background: 'var(--surface-card)'
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
      <span
        style={{
          padding: '0 10px', height: 20, lineHeight: '20px',
          borderRadius: 'var(--radius-pill)',
          background: 'var(--gray-100)', border: '1px solid var(--border-default)',
          fontSize: 'var(--text-xs)', fontWeight: 600,
          letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
          color: 'var(--gray-600)', whiteSpace: 'nowrap'
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
    </div>
  )
}

function sameDay(a, b) {
  if (!a || !b) return false
  const x = new Date(a), y = new Date(b)
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return false
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate()
}

// ── Rows ──────────────────────────────────────────────────────────────
//
// Every row — message, note, task, event — sits on ONE grid:
//
//   [ select ] [ icon ] [ content ......................... ] [ time ]
//
// so the left edges line up all the way down and the eye can scan a single
// column. Separated by hairlines rather than boxed as cards: at card weight a
// twenty-message thread was six rows per screen and a wall of coloured
// stripes, when what a rep needs is to read the thread quickly.

// 20px tick · 36px icon square · content · time
const ROW_GRID = '20px 36px minmax(0, 1fr) auto'

// Shared row frame. `tone` shifts the background for the non-message kinds so
// a note doesn't read as something the customer said.
// `dim` is now used ONLY by the event row (stage changes, assignments), which
// sits behind real conversation on purpose.
//
// Messages and notes used to dim on `m.imported` — true for anything a sync
// sweep pulled in rather than a live webhook. That is a distinction the app
// cares about and a rep does not: a backfilled email is just an email, and
// fading it made whole days of history look disabled. The field is still
// returned; it is simply not a visual state any more.
function Row({ id, children, highlighted, tone, dim }) {
  return (
    <div
      id={id}
      style={{
        display: 'grid',
        gridTemplateColumns: ROW_GRID,
        gap: 'var(--space-3)',
        alignItems: 'start',
        // A chat, not a table: no rule between messages (GHL draws none —
        // the bubbles and the day markers are the structure), and less
        // vertical padding so an exchange reads as one conversation rather
        // than a list of boxed entries.
        padding: '8px 16px',
        // Every row on white. `tone="internal"` used to put notes and tasks
        // on gray-25 so an internal record read apart from the customer's
        // words; the design keeps one ground and lets the kind label and the
        // tinted icon square carry that distinction instead.
        background: highlighted ? 'var(--tint-gold)' : 'transparent',
        opacity: dim ? 0.6 : 1,
        transition: 'background 0.4s ease-out'
      }}
    >
      {children}
    </div>
  )
}

// The channel/kind icon. Colour carries the channel; there is no stripe, box or
// tint behind it, so six SMS rows no longer read as a wall of orange.
// `soft` is the kind's own tint (tintVar) — the design fills every square
// with its channel's pastel. `tint` is still the note author's chosen colour
// and wins when present.
// The sender as GHL's own inbox draws it: initials in a circle, with a small
// badge on the corner saying which channel carried the message — the custom
// sender's logo (WhatsApp QR, iMessage) when there is one, the channel glyph
// otherwise. Same shape as the thread card's email avatar (.pp-mail-avatar),
// so an SMS row and an email row read as the same kind of thing. Inbound is
// sky, outbound plum, matching the thread card.
// Two tooltips: the circle names the person (and which way the message
// went), the badge names the channel. The row's header line used to carry
// both as text; now the avatar is the header, so the facts live on hover.
function SenderAvatar({ name, inbound, icon, colour, image, title, badgeTitle }) {
  const [broken, setBroken] = useState(false)
  // Which tooltip is up: the circle's (who) or the badge's (which channel).
  // Drawn as the app's own dark pill, not the browser's title bubble — the
  // native one arrives late, in the OS font, and GHL's inbox uses a pill.
  const [tip, setTip] = useState(null)
  const showImage = image && !broken
  const pill = {
    position: 'absolute', bottom: 'calc(100% + 8px)', zIndex: 5,
    whiteSpace: 'nowrap', pointerEvents: 'none',
    padding: '6px 11px', borderRadius: 'var(--radius-sm)',
    background: 'var(--gray-800)', color: '#fff',
    fontSize: 'var(--text-sm)', fontWeight: 500, lineHeight: 1.2,
    boxShadow: 'var(--shadow-raised)'
  }
  return (
    <span
      className="pp-mail-avatar"
      data-inbound={inbound ? '1' : '0'}
      style={{ width: 36, height: 36 }}
      onMouseEnter={() => setTip('me')}
      onMouseLeave={() => setTip(null)}
    >
      {initialsFor(name || '?')}
      {tip === 'me' && title && (
        <span role="tooltip" style={{ ...pill, left: '50%', transform: 'translateX(-50%)' }}>{title}</span>
      )}
      <span
        className="pp-mail-avatar-badge"
        style={{ width: 18, height: 18, color: colour, overflow: 'visible' }}
        onMouseEnter={() => setTip('badge')}
        onMouseLeave={() => setTip('me')}
      >
        <span style={{ display: 'inline-flex', width: 18, height: 18, borderRadius: '50%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
          {showImage ? (
            <img src={image} alt="" onError={() => setBroken(true)}
              style={{ width: 14, height: 14, objectFit: 'contain', display: 'block' }} />
          ) : (
            <span className="ms" style={{ fontSize: 12 }}>{icon}</span>
          )}
        </span>
        {tip === 'badge' && badgeTitle && (
          <span role="tooltip" style={{ ...pill, right: -6 }}>{badgeTitle}</span>
        )}
      </span>
    </span>
  )
}

// `image` is a custom sender's own logo (conversation_providers.icon via the
// timeline API). A message through WhatsApp QR or iMessage is typed SMS by
// GHL, so the channel glyph alone drew a chat bubble over a WhatsApp
// conversation; the provider's logo says what it actually was. The glyph
// stays as the fallback — the logo is a URL on GHL's storage, and if it
// does not load the row must still show a channel.
function RowIcon({ icon, colour, title, tint = null, soft = null, image = null }) {
  const [broken, setBroken] = useState(false)
  const showImage = image && !broken
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 36, height: 36,
        borderRadius: 'var(--radius-md)',
        // `tint` is ONLY passed for a note whose author actually set a colour
        // — see the note on EntryRow. The neutral gray-50 default is what
        // keeps six SMS rows from reading as a wall of orange, so this stays
        // an exception rather than becoming the rule.
        background: showImage ? '#fff' : (tint || soft || 'var(--gray-50)'),
        border: showImage ? '1px solid var(--border-default)' : 'none',
        // On an author's pastel the channel accent loses contrast, so the
        // glyph goes dark. Only a normalised hex ever reaches here.
        color: tint ? 'var(--text-heading)' : colour
      }}
    >
      {showImage ? (
        <img
          src={image}
          alt=""
          onError={() => setBroken(true)}
          style={{ width: 22, height: 22, objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <span className="ms" style={{ fontSize: 18 }}>{icon}</span>
      )}
    </span>
  )
}

function SelectBox({ selected, onToggle, title }) {
  if (!onToggle) return <span />
  return (
    <input
      type="checkbox"
      checked={!!selected}
      onChange={onToggle}
      title={title}
      style={{
        width: 20, height: 20, marginTop: 8,
        accentColor: 'var(--brand-primary)', cursor: 'pointer'
      }}
    />
  )
}

// `inline` — when the time sits BESIDE something in a baseline-aligned flex
// row, rather than as a direct child of the top-aligned Row.
//
// The 3px nudge drops the time to the first text line of a row whose body box
// starts above its text. In a baseline-aligned row the browser already does
// that, so the nudge is 3px of double-counting.
function RowTime({ ts, inline = false }) {
  return (
    <span
      style={{
        marginTop: inline ? 0 : 3, flex: 'none',
        fontSize: 'var(--text-base)', color: 'var(--text-muted)',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {formatClock(ts)}
    </span>
  )
}

// A system event. Same grid, but muted and single-line — it's background, not
// something anyone said.
function EventRow({ m }) {
  // GHL's activity log line: a centred pill with the entity's icon, the
  // action in bold ("Opportunity james.co.uk created"), the context after
  // it in plain text ("in James - Initial contact made"), and the date on
  // the right. It was a left-aligned grey line with a cog, which read as a
  // system log entry rather than as a moment in the deal's story. GHL's
  // "Details" link is left out — there is nothing of ours for it to open.
  const label = m.eventLabel || m.channel || 'Event'
  const body = (m.body || '').trim()
  const text = body
    ? (body.toLowerCase().startsWith(label.toLowerCase()) ? body : `${label} · ${body}`)
    : label

  // "<what> <verb>" bold, the rest plain: GHL's own bodies are
  // "Opportunity X created in Pipeline - Stage", "Contact X updated", …
  const m2 = text.match(/^(.+?\b(?:created|updated|deleted|moved|changed|added|removed|completed|booked|cancelled|paid|sent|received|submitted|assigned|won|lost)\b)(.*)$/i)
  const bold = m2 ? m2[1] : text
  const rest = m2 ? m2[2] : ''

  const icon = {
    Opportunity: 'account_tree', Contact: 'person', Invoice: 'receipt_long',
    Appointment: 'event', Payment: 'payments', Form: 'description', Task: 'check_circle'
  }[label] || m.channelIcon || 'info'

  const d = m.ts ? new Date(m.ts) : null
  const when = d && !Number.isNaN(d.getTime())
    ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
    : ''

  return (
    <Row id={`tl-${m.id}`}>
      <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', minWidth: 0 }}>
        <div
          title={text}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 10, maxWidth: '100%',
            padding: '9px 16px', borderRadius: 999,
            border: '1px solid var(--border-default)', background: 'var(--surface-card)',
            fontSize: 'var(--text-md)', color: 'var(--text-body)', lineHeight: 1.3
          }}
        >
          <span className="ms" style={{ fontSize: 18, flex: 'none', color: 'var(--text-heading)' }}>{icon}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <strong style={{ fontWeight: 600, color: 'var(--text-heading)' }}>{bold}</strong>
            {rest}
          </span>
          {when && (
            <span style={{ flex: 'none', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{when}</span>
          )}
        </div>
      </div>
    </Row>
  )
}
// What to call this message's channel.
//
// A message routed through a CUSTOM conversation provider arrives with channel
// 'CUSTOM' — which told a rep nothing about what they were looking at. Name the
// provider when there is one.
//
// The CUSTOM check alone was not enough. A location can run a custom provider
// named for the channel it serves ("WhatsApp QR" on WhatsApp, "SMS Android" on
// SMS): those normalise to WHATSAPP/SMS, not CUSTOM, so they fell through to
// the generic channel label and read exactly like a native send. Two different
// senders, one word on screen. Whenever a provider name is present and differs
// from the channel's own label, it is the more specific truth — show it.
function channelLabelOf(m) {
  const base = CH_LABEL[m.channel] || m.channel
  if (!m.providerName) return base
  // GHL's own senders (twilio_provider, mailgun_provider, smtp_provider_*) are
  // rows in the catalogue too, but they ARE the native path — labelling an SMS
  // "Twilio" would be noise, not disambiguation.
  if (m.providerIsNative) return base
  if (m.channel === 'CUSTOM') return m.providerName
  // A provider whose name merely restates the channel ("WhatsApp" on WhatsApp)
  // adds no information as a label — but it IS the ambiguous case, so mark it
  // rather than silently showing the same word a native send would show.
  const same = String(m.providerName).trim().toLowerCase() === String(base).trim().toLowerCase()
  return same ? `${base} (provider)` : m.providerName
}

function MessageRow({
  m, highlighted, onOpenAttachment, selected, onToggleSelect, thread, onOpenThread,
  // Attribution: which deal we are on, the other deals this contact has, and
  // what to do once a message has been moved.
  dealId, dealTargets, onMessageMoved
}) {
  // The signed-in user: a comment that mentions THEM is drawn in blue.
  const meId = useAuth()?.session?.user?.id || null
  const inbound = m.direction === 'inbound'
  const many = m.toIds && m.toIds.length > 1

  // CHAT LAYOUT, as GHL's inbox: what the customer sent sits on the left
  // with their avatar beside it, what we sent sits on the right with ours,
  // and the time hangs under the bubble on its own side. The old layout gave
  // every message the full row width with the avatar always on the left, so
  // a conversation read as a list rather than an exchange — which way a
  // message went was a tooltip and a colour, not a glance.
  const isComment = m.channel === 'INTERNAL'
  const isEmail = m.channel === 'EMAIL'
  const hasText = !!m.body || (m.isCall && !m.body)
  const avatar = (
    <SenderAvatar
      name={m.senderName}
      inbound={inbound}
      icon={m.channelIcon}
      colour={accentTextVar(m.channelAccent)}
      // A custom sender's logo in the badge; native senders have none
      // and show the channel glyph.
      image={m.providerIsNative ? null : m.providerIcon}
      title={`${m.senderName || 'Unknown'} · ${inbound ? 'received from the customer' : 'sent by us'}`}
      badgeTitle={isComment ? 'Internal comment · only visible to your team' : channelLabelOf(m)}
    />
  )
  // Inbound grey, outbound the pale blue, an internal comment gold with its
  // border — GHL's three bubble colours. The corner nearest the avatar is
  // squared off so the bubble points at who said it.
  const bubble = isEmail ? {} : {
    maxWidth: '100%', boxSizing: 'border-box',
    padding: hasText ? '10px 14px' : 6,
    borderRadius: 12,
    ...(inbound ? { borderTopLeftRadius: 4 } : { borderTopRightRadius: 4 }),
    ...(isComment
      ? { background: 'var(--tint-gold)', border: '1px solid var(--accent-gold)' }
      : inbound
        ? { background: 'var(--gray-100)' }
        : { background: 'var(--tint-sky)' })
  }

  // The tick sits on the OUTSIDE of the avatar, level with its centre — an
  // outbound row reads bubble, avatar, tick; an inbound one tick, avatar,
  // bubble. At the row's edge it never crowds the bubble, and it stays put
  // while the bubble's height varies.
  const tick = (
    <span style={{ flex: 'none', alignSelf: 'flex-start', marginTop: 8 }}>
      <SelectBox
        selected={selected}
        onToggle={() => onToggleSelect && onToggleSelect(m)}
        title={
          selected
            ? 'Selected — the agent reads this message'
            : 'Not selected — the agent skips this message'
        }
      />
    </span>
  )

  return (
    <Row id={`tl-${m.id}`} highlighted={highlighted}>
      <div style={{
        gridColumn: '1 / -1', minWidth: 0,
        // The same 12px the row grid uses between its columns, so an inbound
        // bubble's left edge (tick, gap, avatar, gap) lands exactly where a
        // note's, a task's or an email card's content column starts.
        display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
        justifyContent: inbound ? 'flex-start' : 'flex-end'
      }}>
        {inbound && tick}
        {inbound && avatar}

        <div style={{
          display: 'flex', flexDirection: 'column', minWidth: 0,
          alignItems: inbound ? 'flex-start' : 'flex-end',
          // An email keeps the full width — it is a document, not a line of
          // chat. Everything else wraps at roughly two thirds, as GHL does.
          maxWidth: isEmail ? '100%' : 'min(72%, 760px)',
          flex: isEmail ? 1 : '0 1 auto'
        }}>
          {/* The two flags that have no other home. */}
          {(m.ambiguous || many) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
              {m.ambiguous && (
                <span
                  title="This contact has more than one open deal, so this message's filing is a guess"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 'var(--text-sm)', fontWeight: 600,
                    color: 'var(--accent-gold-text)'
                  }}
                >
                  <span className="ms" style={{ fontSize: 13 }}>help</span>
                  Which opportunity?
                </span>
              )}
              {many && (
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
                  to {m.toIds.length} people
                </span>
              )}
            </div>
          )}

          <div style={bubble}>
            {m.isCall && !m.body && (
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
                Call · {m.callDurationMin ? `${m.callDurationMin} min` : 'unknown length'}
                {' · '}no transcript, so the agent cannot read it
              </span>
            )}

            {/* An email that still reaches this row (every email normally
                draws as the thread card above) keeps its own card. */}
            {isEmail ? (
              <EmailBody
                m={m}
                thread={thread}
                onOpenThread={onOpenThread}
                onOpenAttachment={onOpenAttachment}
              />
            ) : m.body ? (
              <div
                style={{
                  fontSize: 'var(--text-lg)', lineHeight: 'var(--leading-normal)',
                  color: 'var(--text-heading)',
                  whiteSpace: 'pre-line', overflowWrap: 'anywhere'
                }}
              >
                {isComment ? <MentionText text={String(m.body).trim()} meId={meId} /> : String(m.body).trim()}
              </div>
            ) : null}

            {/* NOT for email: EmailBody renders those inside the card. */}
            {!isEmail && m.attachments?.length > 0 && (
              <MessageAttachments attachments={m.attachments} onOpen={onOpenAttachment} />
            )}
          </div>

          {/* Under the bubble, on its side: the time, then the deal pill
              (the reassignment control) further out. The old "Inbound /
              Outbound" word is gone — the side says it. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, lineHeight: 1,
            flexDirection: inbound ? 'row' : 'row-reverse'
          }}>
            <RowTime ts={m.ts} inline />
            {dealId && m.messageId && (
              <MessageDealPill
                message={m}
                dealId={dealId}
                targets={dealTargets}
                onMoved={onMessageMoved}
              />
            )}
          </div>
        </div>

        {!inbound && avatar}
        {!inbound && tick}
      </div>
    </Row>
  )
}

// Notes and tasks: the same row, on a tinted ground so an internal record is
// distinguishable from something the customer said.
function EntryRow({ m, highlighted, selected, onToggleSelect }) {
  const isNote = m.kind === 'note'
  const meId = useAuth()?.session?.user?.id || null
  // A comment a colleague left from our composer, saved as a note because
  // GHL's API has no way to create its own internal comments. Drawn as GHL
  // draws a comment — eye badge, gold bubble, no heading — rather than as a
  // note titled "Internal comment".
  const isComment = isInternalCommentRow(m)

  // A comment written from our composer is OURS, so it sits on the right
  // like every outbound message — same bubble, same avatar-on-the-right,
  // same time underneath — instead of the full-width note layout.
  if (isComment) {
    const author = m.senderName && m.senderName !== 'Unknown' ? m.senderName : ''
    return (
      <Row id={`tl-${m.id}`} highlighted={highlighted} tone="internal">
        <div style={{ gridColumn: '1 / -1', minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 0, maxWidth: 'min(72%, 760px)' }}>
            {m.body && (
              <div style={{
                maxWidth: '100%', boxSizing: 'border-box', padding: '10px 14px',
                borderRadius: 12, borderTopRightRadius: 4,
                background: 'var(--tint-gold)', border: '1px solid var(--accent-gold)',
                fontSize: 'var(--text-lg)', lineHeight: 'var(--leading-normal)',
                color: 'var(--text-heading)', whiteSpace: 'pre-line', overflowWrap: 'anywhere'
              }}>
                <MentionText text={commentHtmlToText(m.body).trim()} meId={meId} />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, lineHeight: 1, flexDirection: 'row-reverse' }}>
              <RowTime ts={m.ts} inline />
              {author && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{author}</span>}
            </div>
          </div>
          <SenderAvatar
            name={author}
            inbound={false}
            icon="visibility"
            colour={accentTextVar('gold')}
            title={author || 'Unknown author'}
            badgeTitle="Internal comment · only visible to your team"
          />
          <span style={{ flex: 'none', alignSelf: 'flex-start', marginTop: 8 }}>
            <SelectBox
              selected={selected}
              onToggle={() => onToggleSelect && onToggleSelect(m)}
              title={selected ? 'Selected — the agent reads this comment' : 'Not selected — the agent skips this comment'}
            />
          </span>
        </div>
      </Row>
    )
  }
  // A note's own colour, when its author set one.
  //
  // ON THE ICON SQUARE ONLY, deliberately. The rail gives a coloured note a
  // left edge stripe, but the rail is a short list of notes; this timeline
  // interleaves them with messages, tasks and events on one grid, and its
  // rows carry no stripes precisely so a long thread does not read as a wall
  // of colour (see the comment above ROW_GRID). Tinting the 26px square that
  // is already there says the same thing without breaking that.
  const noteCol = isNote ? noteColourStyle(m.color) : { tint: null, name: null }

  return (
    <Row id={`tl-${m.id}`} highlighted={highlighted} tone="internal">
      {/* Notes and tasks are evidence the agent reads (rule 7), so they get the
          same selection control as a message. Before this a rep could deselect
          a message but not the note beside it. */}
      <SelectBox
        selected={selected}
        onToggle={() => onToggleSelect && onToggleSelect(m)}
        title={
          selected
            ? `Selected — the agent reads this ${isNote ? 'note' : 'task'}`
            : `Not selected — the agent skips this ${isNote ? 'note' : 'task'}`
        }
      />
      {isComment ? (
        // The author's avatar with the eye badge, as GHL draws a comment —
        // the same avatar an SMS or WhatsApp row uses, so a comment reads
        // as something a person wrote, not a system square.
        <SenderAvatar
          name={m.senderName && m.senderName !== 'Unknown' ? m.senderName : ''}
          inbound={false}
          icon="visibility"
          colour={accentTextVar('gold')}
          title={m.senderName && m.senderName !== 'Unknown' ? m.senderName : 'Unknown author'}
          badgeTitle="Internal comment · only visible to your team"
        />
      ) : (
        <RowIcon
          icon={m.channelIcon}
          colour={accentTextVar(m.channelAccent)}
          soft={tintVar(m.channelAccent)}
          tint={noteCol.tint}
          title={noteCol.name ? `${noteCol.name} note` : (isNote ? 'Note' : 'Task')}
        />
      )}

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            flexWrap: 'wrap', marginBottom: 1
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-sm)', fontWeight: 600,
              letterSpacing: 'var(--tracking-label)',
              // The -text accent, not the bare one: the design's NOTE is a
              // readable dark gold, and bare gold on white is 3.4:1.
              textTransform: 'uppercase', color: accentTextVar(m.channelAccent)
            }}
          >
            {isComment ? 'Internal comment' : isNote ? 'Note' : 'Task'}
          </span>
          {isComment && m.senderName && m.senderName !== 'Unknown' && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {m.senderName}
            </span>
          )}
          {isNote && m.isAi && <Badge tone="sky" icon="auto_awesome">AI note</Badge>}
          {/* GHL omits attachments from note webhooks, so noteWriter fetches
              GET /notes/:id and the server counts them out of raw_note. */}
          {isNote && <AttachmentCount count={m.attachmentCount} />}
          {!isNote && m.status === 'completed' && <Badge tone="pine" icon="check">Done</Badge>}
          {!isNote && m.overdue && m.status !== 'completed' && (
            <Badge tone="rose" icon="schedule">Overdue</Badge>
          )}
        </div>

        {!isComment && (
          <div
            style={{
              fontSize: 'var(--text-lg)', fontWeight: 600,
              lineHeight: 'var(--leading-snug)', color: 'var(--text-heading)'
            }}
          >
            {m.title || (isNote ? 'Note' : 'Task')}
          </div>
        )}

        {/* The most read-heavy text on the page — a customer's note runs to a
            paragraph or more. 14px on the body against 13px on the title's row
            of metadata, and text-body rather than muted: at 13px muted it was
            the smallest, faintest thing on screen while being the thing you
            actually came to read. */}
        {m.body && isComment && (
          // GHL's yellow comment bubble. The body was saved as HTML by the
          // composer (a <p> per line) — turned back into text here so the
          // mentions in it can be drawn as mentions.
          <div style={{
            marginTop: 4, display: 'inline-block', maxWidth: '100%',
            padding: '8px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--tint-gold)', border: '1px solid var(--accent-gold)',
            fontSize: 'var(--text-lg)', lineHeight: 'var(--leading-normal)',
            color: 'var(--text-heading)', whiteSpace: 'pre-line', overflowWrap: 'anywhere'
          }}>
            <MentionText text={commentHtmlToText(m.body)} meId={meId} />
          </div>
        )}
        {m.body && !isComment && (
          <div style={{ marginTop: 2 }}>
            {/* Snug leading: at 1.55 on 15px the kind label, title, body and
                meta line sat far enough apart to read as four items. */}
            <RichBody
              html={m.body}
              color="var(--text-body)"
              size="var(--text-lg)"
              leading="var(--leading-snug)"
              maxWidth={720}
            />
          </div>
        )}

        {/* No meta line on a comment: the author is on the label, the time is
            in the right-hand column, and "added manually" plus the contact
            chip are facts about a NOTE's filing that a comment does not
            need — GHL shows a comment as avatar, bubble, time. */}
        {!isComment && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            marginTop: 6, fontSize: 'var(--text-base)', color: 'var(--text-muted)'
          }}
        >
          <span>
            {[
              isNote
                ? (m.senderName ? `by ${m.senderName}` : null)
                : (m.assignee ? `assigned to ${m.assignee}` : 'unassigned'),
              // formatDue, not the server's duePhrase. That field came
              // through as the raw ISO date, so the row read "due
              // 2026-10-28" beside a design that says "due 29 Sep". The ISO
              // is on the row already; the house formatter also handles
              // today / tomorrow / N days ago the same way the Tasks tab does.
              !isNote && m.dueAt ? formatDue(m.dueAt) : null,
              m.manual ? 'added manually' : null
            ].filter(Boolean).join(' · ')}
          </span>
          {/* WHO IT IS FILED AGAINST. Both notes and tasks are stored against
              a contact in GHL, and this line named only the author or the
              assignee — neither of which answers "who is this about" on a
              deal with several people. */}
          {m.contact?.name && (
            <span
              title={`Filed against ${m.contact.name}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                maxWidth: '100%',
                height: 26, padding: '0 11px',
                borderRadius: 'var(--radius-pill)',
                // A BLUE OUTLINED CHIP, per the client's design — and the
                // same sky accent a contact already wears everywhere else in
                // the app (ContactChip, the People panel's band).
                //
                // It was a grey fill with muted text, which made the person
                // the row is filed against read as quieter than the row's own
                // metadata — the opposite of what it is. -text, not the bare
                // accent: sky on its own tint is 4.13:1, below AA.
                border: '1px solid var(--accent-sky)',
                background: 'var(--tint-sky)',
                fontWeight: 500, color: 'var(--accent-sky-text)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}
            >
              <span className="ms" style={{ fontSize: 15, flex: 'none' }}>person</span>
              {m.contact.name}
            </span>
          )}
        </div>
        )}
      </div>

      <RowTime ts={m.ts} />
    </Row>
  )
}

// Is this note an internal comment from the timeline composer? EntryRow draws
// those as GHL draws a comment (avatar with the eye, gold bubble). Two
// signals, either enough: the server flags it (isInternalComment — it also
// clears the title, so the title test alone would miss it), and an older
// server that does not flag it still sends the title.
const isInternalCommentRow = (m) => m.kind === 'note'
  && (m.isInternalComment === true || String(m.title || '').trim() === COMMENT_TITLE)

function Badge({ children, tone, icon }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 9px',
        borderRadius: 'var(--radius-pill)',
        background: `var(--tint-${tone})`,
        color: `var(--accent-${tone})`,
        fontSize: 'var(--text-sm)', fontWeight: 600, whiteSpace: 'nowrap'
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 13 }}>{icon}</span>}
      {children}
    </span>
  )
}


export default function Timeline({
  messages,
  highlightedId = null,
  // OPTIONAL. Nothing ever passed this — DealHubTab renders <Timeline> without
  // it — so every attachment chip in the timeline was a dead click. The
  // built-in viewer below is now the default, and a caller can still override
  // to do something else.
  onJumpAttachment = null,
  onToggleSelect,
  onSelectAll,
  // Empty-state wording depends on WHY the list is empty, and only the caller
  // knows: it holds the unfiltered set and the active filters. `totalCount` is
  // every row before filtering; `filtersActive` says chips are narrowing it.
  totalCount = null,
  filtersActive = false,
  onClearFilters = null,
  // Attribution controls. Absent (e.g. on a contact record) the pill is not
  // rendered — there is no deal in scope to move a message off.
  dealId = null,
  dealTargets = [],
  onMessageMoved = null,
  // Reply on an email thread card. Seeds the Co-Pilot composer with a reply
  // request for that email — the draft itself goes through the AI's reply
  // path (replyToMessageId), so it threads correctly.
  onReplyEmail = null,
  // (message, close) => a reply box. When given, Reply on an email opens it
  // inside that email's thread card, as GHL does, and onReplyEmail is unused.
  replyComposer = null,
  // Rendered at the foot of the card — the Deal Hub passes its composer.
  footer = null,
  // Infinite scroll. `hasMore` says older rows exist on the server;
  // `onLoadMore` fetches the next older page (the caller appends it to
  // `messages`); `loadingMore` is true while it is in flight.
  hasMore = false,
  loadingMore = false,
  onLoadMore = null,
}) {
  // The email whose thread has its reply box open — one at a time.
  const [replyTo, setReplyTo] = useState(null)

  // FULL SCREEN for the whole timeline — the same treatment a thread card
  // gets: the card lifted into a 90vw × 90vh dialog over a blurred page,
  // the rows filling it, the composer docked at the bottom. ⤢ in the
  // header enters; ⤡, Escape or the backdrop leave. A long deal is easier
  // to read with the whole screen than inside an 80vh box on a busy page.
  const [fullScreen, setFullScreen] = useState(false)
  const modalRef = useModal({ active: fullScreen })
  useEffect(() => {
    if (!fullScreen) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      // A thread card's own full screen (or an attachment viewer) may be open
      // on top; its Escape handler owns that press.
      if (document.querySelectorAll('.pp-backdrop').length > 1) return
      setFullScreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullScreen])
  // The header counts each kind separately — tasks and notes now share the
  // stream, and folding them into "23 messages" would overstate the thread.
  const msgCount = messages.filter((m) => !m.kind && !m.event).length
  const taskCount = messages.filter((m) => m.kind === 'task').length
  const noteCount = messages.filter((m) => m.kind === 'note').length
  const unreadable = messages.filter((m) => !m.kind && !m.event && !m.readable).length
  const peopleCount = new Set(
    messages.map((m) => m.senderId).filter(Boolean)
  ).size

  // Email threads, indexed once for the whole list — see buildThreads.
  const threads = useMemo(() => buildThreads(messages), [messages])

  // The rows actually drawn: each multi-message email thread collapses to ONE
  // entry — its newest reply, which carries the card — and its other replies
  // are dropped from the stream (the card shows them). Everything else passes
  // through, and the result is put oldest-first (see below).
  const rows = useMemo(() => {
    const newest = new Map()
    for (const [id, arr] of threads) {
      newest.set(id, arr.reduce((a, b) => (new Date(b.ts) > new Date(a.ts) ? b : a)))
    }
    const kept = messages.filter((m) => !(m.threadId && newest.has(m.threadId)) || newest.get(m.threadId) === m)
    // OLDEST FIRST, newest at the bottom — a conversation, as GHL and every
    // chat reads, with the composer under the latest message. The server
    // sends newest-first, so reverse, then a stable sort by time settles any
    // row the merge left out of place. A thread sits at its NEWEST email, so
    // a reply to an email higher up moves the whole thread to the bottom —
    // the inbox behaviour.
    const t = (m) => { const v = new Date(m.ts).getTime(); return Number.isNaN(v) ? 0 : v }
    return kept.slice().reverse().sort((a, b) => t(a) - t(b))
  }, [messages, threads])

  // Open at the BOTTOM, where the newest message now is — and stay there as
  // the thread grows (a sent message arriving by webhook), unless the rep has
  // scrolled up to read. Emails render in iframes that size themselves a
  // moment after mount, so for 2s after the rows change, content growth keeps
  // it pinned too; after that a card the rep expands is left where it is.
  const scrollRef = useRef(null)
  const contentRef = useRef(null)
  const atBottom = useRef(true)
  const pinUntil = useRef(0)
  const pinBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  useEffect(() => { atBottom.current = true }, [dealId])

  // INFINITE SCROLL. A sentinel at the TOP of the list — the oldest end —
  // asks for the next older page as it comes within 300px of view. The
  // scroll height before the request is remembered, so when the older rows
  // land above, the view is moved down by exactly what was added and the row
  // the rep was reading stays put instead of jumping.
  const sentinelRef = useRef(null)
  const anchor = useRef(null)
  const requestMore = () => {
    if (!hasMore || loadingMore || !onLoadMore) return
    const el = scrollRef.current
    anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null
    onLoadMore()
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!anchor.current || !el) return
    el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height)
    anchor.current = null
  }, [rows])

  useLayoutEffect(() => {
    if (!atBottom.current) return
    pinUntil.current = Date.now() + 2000
    pinBottom()
  }, [rows])
  // Re-attached when the list first appears (the box is not rendered while
  // the timeline is empty).
  const hasRows = rows.length > 0
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      if (atBottom.current && Date.now() < pinUntil.current) pinBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [hasRows])

  // Re-created whenever loading settles, so a sentinel STILL in view after a
  // page lands (a short page, or a filter showing few rows) asks again — an
  // observer only reports changes, and "still visible" is not one.
  useEffect(() => {
    const target = sentinelRef.current
    const root = scrollRef.current
    if (!target || !root || !hasMore || loadingMore || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) requestMore() },
      { root, rootMargin: '300px 0px 0px 0px' }
    )
    io.observe(target)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRows, hasMore, loadingMore])

  // The attachment being previewed: { attachments, index } or null.
  //
  // Held here rather than per-row so only one viewer exists, and so an
  // attachment opened from the thread dialog and one opened from a row use
  // the same component and the same stacking.
  const [viewing, setViewing] = useState(null)

  // One place that decides what a chip click does. `onJumpAttachment` wins if
  // a caller supplied it; otherwise the built-in viewer opens.
  const openAttachment = (list, idx) => {
    const arr = Array.isArray(list) ? list.filter((a) => a && a.url) : []
    if (arr.length === 0) return
    if (onJumpAttachment) { onJumpAttachment(arr[idx] || arr[0]); return }
    // The index must point into the FILTERED array, or dropping a urlless
    // entry would open the wrong file.
    const target = list[idx]
    const at = Math.max(0, arr.indexOf(target))
    setViewing({ attachments: arr, index: at })
  }

  // The email whose thread is open in the dialog, or null. Holding the MESSAGE
  // rather than the thread id keeps track of which row was clicked, so the
  // dialog can open that message expanded as well as the newest.
  const [threadOf, setThreadOf] = useState(null)

  // The dialog reads from `threads`, so a re-sync that drops the clicked
  // message would otherwise leave a dialog with nothing in it.
  const openThread = threadOf ? threads.get(threadOf.threadId) : null

  // Everything the agent can read: messages, notes and tasks. Events are
  // excluded — a "stage changed" row has no content to cite.
  const selectable = messages.filter((m) => !m.event)
  const selectedCount = selectable.filter((m) => m.included !== false).length
  const allSelected = selectable.length > 0 && selectedCount === selectable.length
  const someSelected = selectedCount > 0

  const summary = [
    // "18 of 20 selected" when some are excluded — the number that decides what
    // the agent reads, so it belongs in the header rather than being something
    // you count by eye.
    selectedCount === selectable.length
      ? `${msgCount} ${msgCount === 1 ? 'message' : 'messages'}`
      // Counts every readable item, not just messages — a deselected note is
      // as much a gap in the answer as a deselected message.
      : `${selectedCount} of ${selectable.length} selected`,
    taskCount ? `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}` : null,
    noteCount ? `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : null,
    unreadable ? `${unreadable} ${unreadable === 1 ? 'call' : 'calls'} unreadable` : null,
    `${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`
  ].filter(Boolean).join(' · ')

  const fullScreenButton = (
    <button
      type="button"
      onClick={() => setFullScreen((v) => !v)}
      title={fullScreen ? 'Exit full screen' : 'Open the timeline full screen'}
      aria-label={fullScreen ? 'Exit full screen' : 'Open the timeline full screen'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, border: 0, borderRadius: 'var(--radius-sm)',
        background: 'rgba(255,255,255,0.18)', color: '#fff', cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 18 }}>{fullScreen ? 'close_fullscreen' : 'open_in_full'}</span>
    </button>
  )

  const card = (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: 'var(--accent-teal-text)',
        ['--panel-tint']: 'var(--tint-teal)',
        borderRadius: 'var(--radius-md)',
        // clip, not hidden: hidden makes this card a scroll container, and the
        // day headers would stick to it — that is, never — instead of the page.
        overflow: 'clip',
        background: '#fff',
        // Full screen: the card IS the dialog, so it fills it and its scroll
        // box takes whatever height the header, bar and composer leave.
        ...(fullScreen ? {
          height: '100%', display: 'flex', flexDirection: 'column',
          border: 'none', boxShadow: 'none', borderRadius: 0
        } : {})
      }}
    >
      <PanelHead icon="forum" title="Timeline" subtitle={summary} accent="teal" action={fullScreenButton} />

      {/* A bar that says what the checkboxes are for. They were unlabelled, so
          nothing on screen explained that ticking one changes what the agent
          reads.

          Hidden when there is nothing to tick: a "select every message"
          checkbox above an empty list is a control that cannot do anything,
          and it was the only thing rendered on an empty timeline. */}
      {selectable.length > 0 && (
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-default)',
          background: '#fff'
        }}
      >
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
          onChange={() => onSelectAll && onSelectAll(!allSelected)}
          disabled={!onSelectAll}
          title={allSelected ? 'Deselect every message' : 'Select every message'}
          style={{
            width: 20, height: 20,
            accentColor: 'var(--brand-primary)',
            cursor: onSelectAll ? 'pointer' : 'default'
          }}
        />
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-body)' }}>
          Ticked messages are the ones Co-Pilot reads
        </span>
      </div>
      )}

      {/* Empty states. messages.map over [] rendered NOTHING, so an empty
          timeline was a header above a large blank panel — the one place in the
          app that looked broken rather than empty.

          Three cases, because they need different words and only one is
          actionable:
            filters hide everything → offer to clear them
            nothing on the deal yet → explain what will appear here
            (a deal with rows) → the list
          `totalCount` is null when the caller doesn't pass it, in which case
          we can't tell the two apart and give the neutral wording. */}
      {messages.length === 0 ? (
        <StateMessage
          empty
          inline
          emptyIcon={filtersActive ? 'filter_alt_off' : 'forum'}
          emptyTitle={filtersActive ? 'Nothing matches those filters' : 'No conversation yet'}
          emptyText={
            filtersActive
              ? totalCount
                ? `This deal has ${totalCount} ${totalCount === 1 ? 'row' : 'rows'}, but none match what you've selected above.`
                : 'Try selecting fewer chips above.'
              : 'Messages, notes, tasks and stage changes will appear here as the deal progresses.'
          }
          action={filtersActive && onClearFilters ? (
            <button
              onClick={onClearFilters}
              style={{
                height: 34, padding: '0 14px',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                background: '#fff',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                fontWeight: 600, color: 'var(--text-heading)',
                cursor: 'pointer'
              }}
            >
              Clear filters
            </button>
          ) : null}
        />
      ) : (
      <div
        className="pp-timeline-scroll"
        style={{
          position: 'relative',
          // 80% of the screen, with its own scrollbar — and NEVER taller than
          // the screen. The old box was at least 860px, which inside GHL's
          // iframe was taller than the visible area: the wheel was always
          // over it, so a rep had to scroll through every message before the
          // page itself would move. At 80vh the box always fits, the wheel
          // reaches its end and hands over to the page, and the 20% of page
          // around it scrolls the page directly. Day headers stick to the
          // top of this box.
          overflowY: 'auto', overscrollBehavior: 'auto',
          ...(fullScreen ? { flex: 1, minHeight: 0 } : { maxHeight: '80vh' })
        }}
        ref={scrollRef}
        // "At the bottom" within a row's height — the pin follows the rep:
        // scroll up to read and new rows stop yanking the view down.
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {/* A plain wrapper, so the pin can watch the content's height. */}
        <div ref={contentRef}>
        {/* The oldest end: the infinite-scroll sentinel, and a quiet line
            while the next older page is on its way. */}
        <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
        {hasMore && loadingMore && (
          <div style={{
            padding: '10px 0', textAlign: 'center',
            fontSize: 'var(--text-sm)', color: 'var(--text-muted)'
          }}>
            Loading earlier messages…
          </div>
        )}
        {/* `rows`, not `messages`: a multi-message email thread is one row
            here — its newest email — and the thread card draws the rest. */}
        {rows.map((m, i) => {
          const prev = i > 0 ? rows[i - 1] : null
          const newDay = !prev || !sameDay(prev.ts, m.ts)
          // EVERY email draws as the thread card, a lone one included: the
          // grey subject bar with its tools, then the sender row with avatar,
          // snippet and time. A single email used to take a different shape
          // (subject inline, no sender row), so two emails on one deal could
          // look like two kinds of thing. One card, whatever the count.
          if (m.channel === 'EMAIL') {
            const found = m.threadId ? threads.get(m.threadId) : null
            const thread = found && found.length ? found : [m]
            return (
              <React.Fragment key={`thread-${m.threadId || m.id}`}>
                {newDay && m.ts && <DayHeader iso={m.ts} />}
                <Row id={`tl-${m.id}`} highlighted={thread.some((t) => t.id === highlightedId)}>
                  {/* ONE tick for the whole thread, in the row's tick column
                      where a note's or a task's is — not one per email inside
                      the card. Ticking it includes or excludes every email in
                      the thread together. */}
                  {onToggleSelect ? (
                    <SelectBox
                      selected={thread.every((t) => t.included !== false)}
                      onToggle={() => {
                        const allOn = thread.every((t) => t.included !== false)
                        for (const t of thread) {
                          if (allOn ? t.included !== false : t.included === false) onToggleSelect(t)
                        }
                      }}
                      title={thread.every((t) => t.included !== false)
                        ? 'Selected — the agent reads this email thread'
                        : 'Not selected — the agent skips this email thread'}
                    />
                  ) : <span />}
                  <RowIcon icon="mail" colour={accentTextVar('sky')} soft={tintVar('sky')} title={thread.length > 1 ? 'Email thread' : 'Email'} />
                  <div style={{ minWidth: 0 }}>
                    <EmailThreadCard
                      mails={thread}
                      onOpenAttachment={openAttachment}
                      // With a reply composer, Reply opens it INSIDE this
                      // card; without one, the caller's handler runs.
                      onReplyEmail={replyComposer ? setReplyTo : onReplyEmail}
                      replyInline={!!replyComposer}
                      inlineComposer={replyComposer && replyTo && thread.some((t) => t.id === replyTo.id)
                        ? replyComposer(replyTo, () => setReplyTo(null))
                        : null}
                      // No per-email ticks: the row's tick covers the thread.
                      selectedIds={null}
                      onToggleSelect={null}
                    />
                  </div>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'start', whiteSpace: 'nowrap' }}>
                    {dealId && m.messageId && (
                      <MessageDealPill message={m} dealId={dealId} targets={dealTargets} onMoved={onMessageMoved} />
                    )}
                    <RowTime ts={m.ts} inline />
                  </span>
                </Row>
              </React.Fragment>
            )
          }
          return (
            <React.Fragment key={m.id}>
              {newDay && m.ts && <DayHeader iso={m.ts} />}
              {m.kind === 'task' || m.kind === 'note' ? (
                <EntryRow
                  m={m}
                  highlighted={highlightedId === m.id}
                  selected={m.included !== false}
                  onToggleSelect={onToggleSelect}
                />
              ) : m.event ? (
                <EventRow m={m} />
              ) : (
                <MessageRow
                  m={m}
                  highlighted={highlightedId === m.id}
                  dealId={dealId}
                  dealTargets={dealTargets}
                  onMessageMoved={onMessageMoved}
                  onOpenAttachment={openAttachment}
                  // undefined for anything that isn't a multi-message email
                  // thread, which is what suppresses the affordance.
                  thread={m.threadId ? threads.get(m.threadId) : undefined}
                  onOpenThread={setThreadOf}
                  // Absence of a flag means selected: a newly-synced message
                  // defaults IN, matching message_ai_exclusions (migration 051),
                  // which stores exclusions rather than inclusions.
                  selected={m.included !== false}
                  onToggleSelect={onToggleSelect}
                />
              )}
            </React.Fragment>
          )
        })}
        </div>
      </div>
      )}

      {/* Under the rows, inside the card — where GHL docks its composer.
          Outside the scroll box so it stays in reach however long the
          thread is, and after the empty state too: a deal with no history
          is exactly where a rep sends the first message. */}
      {footer}

      {viewing && (
        <AttachmentViewer
          attachments={viewing.attachments}
          index={viewing.index}
          onClose={() => setViewing(null)}
        />
      )}

      {openThread && openThread.length > 1 && (
        <EmailThreadModal
          messages={openThread}
          initialId={threadOf.id}
          subject={threadOf.subject}
          onClose={() => setThreadOf(null)}
        />
      )}
    </section>
  )

  if (!fullScreen) return card
  return (
    <>
      {/* The card's slot keeps a little height while it is lifted out, so
          the page does not collapse under the overlay. */}
      <section style={{
        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
        minHeight: 120, opacity: 0.35, overflow: 'clip', background: '#fff'
      }}>
        <PanelHead icon="forum" title="Timeline" subtitle={summary} accent="teal" />
      </section>
      <div
        className="pp-backdrop pp-backdrop-blur"
        style={{ zIndex: 55 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) setFullScreen(false) }}
      >
        <div
          ref={modalRef}
          className="pp-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Timeline"
          style={{
            width: '94vw', height: '92vh', maxWidth: 'none', maxHeight: 'none',
            padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden'
          }}
        >
          {card}
        </div>
      </div>
    </>
  )
}
