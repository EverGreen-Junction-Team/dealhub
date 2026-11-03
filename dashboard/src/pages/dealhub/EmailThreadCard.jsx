import React, { useEffect, useMemo, useState } from 'react'
import { useModal } from '../../hooks/useModal'
import { htmlToText } from '../../utils/sanitiseHtml'
import { EmailFull } from './EmailBody'

// One email THREAD as one card — the shape GHL's own conversation view uses,
// and what the client asked the timeline to match.
//
//   ┌ how are you                                  ⤢  ⌄ ┐   subject bar
//   │          ─────( + 4 messages earlier )─────       │   collapsed: the pill
//   │ (JS) J srini  ✉  Lorem ipsum…        12:06  ↩     │   + newest email, one line
//   └────────────────────────────────────────────────────┘
//
// Before this every email was its own timeline row with a "4 in thread" link
// to a modal, so a five-message exchange took five rows and the thread was
// a thing you opened elsewhere. Here the thread IS the row; the others fold
// into it.
//
// Three states, as GHL has them:
//   collapsed — pill + newest email (its body opens in place on click)
//   headers   — every email as a one-line row; the newest open. For a thread
//               of more than four: first · pill · second-newest · newest, with
//               the pill opening the full list.
//   each row  — click to open/close its body
//
// `mails` arrive NEWEST FIRST (timeline order); the card reads oldest → newest
// top to bottom, as a conversation does.

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase()
}

// 12-hour, as GHL's thread rows read ("10:03 PM"). The rest of the timeline
// keeps the house 24-hour clock; this card is a deliberate copy of GHL's.
function clock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function EmailThreadCard({
  mails, onOpenAttachment, onReplyEmail, selectedIds, onToggleSelect,
  // True when Reply opens a box INSIDE this card (Timeline's replyComposer).
  // Then full screen stays up and the box appears under the emails, where
  // the rep is already reading; only the Co-Pilot-seeding path, whose
  // composer is on the page beneath, has to drop out first.
  replyInline = false,
  // The open reply box for this thread, if Reply was clicked on one of its
  // emails — rendered at the foot of the card.
  inlineComposer = null
}) {
  // FULL SCREEN, as GHL does it: the SAME card, lifted into a white
  // 90vw × 90vh container over a dimmed page, with the thread opened to its
  // headers view. ⤢ on the card enters it; ⤡, Escape or the backdrop leave
  // it. Not the older thread dialog — that was a different design, and the
  // point of this view is that nothing changes except the room it has.
  const [fullScreen, setFullScreen] = useState(false)
  const modalRef = useModal({ active: fullScreen })
  useEffect(() => {
    if (!fullScreen) return
    const onKey = (e) => { if (e.key === 'Escape') setFullScreen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullScreen])
  const ordered = useMemo(() => [...mails].reverse(), [mails])   // oldest → newest
  const newest = ordered[ordered.length - 1]
  const count = ordered.length
  const subject = newest?.subject || ordered.find((m) => m.subject)?.subject || '(no subject)'

  // 'collapsed' | 'headers' | 'partial'
  //
  // Collapsed shows the newest email as a ONE-LINER — snippet, not body —
  // under the pill. Opening it is what the headers view (a click on the
  // subject bar) does; GHL draws it the same way.
  const [view, setView] = useState('collapsed')
  const [open, setOpen] = useState(() => new Set())

  const toggleOpen = (id) => setOpen((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const expandAll = () => {
    setView('headers')
    setOpen(new Set(ordered.map((m) => m.id)))
  }
  const openHeaders = () => {
    setOpen(new Set(newest ? [newest.id] : []))
    setView(count > 4 ? 'partial' : 'headers')
  }
  const collapse = () => {
    setView('collapsed')
    setOpen(new Set())
  }
  const onHeaderClick = () => (view === 'collapsed' ? openHeaders() : collapse())
  const enterFullScreen = () => {
    if (view === 'collapsed') openHeaders()
    setFullScreen(true)
  }

  // Which emails are on screen, and where the "+N earlier" pill sits.
  const rows = useMemo(() => {
    if (view === 'collapsed') return [{ pill: count - 1 }, newest].filter((r) => !(r.pill === 0))
    if (view === 'partial') {
      return [ordered[0], { pill: count - 3 }, ordered[count - 2], ordered[count - 1]]
    }
    return ordered
  }, [view, ordered, newest, count])

  const allExpanded = ordered.every((m) => open.has(m.id)) && view !== 'collapsed'

  const card = (
    <div className="pp-thread" style={fullScreen ? { boxShadow: 'none', margin: 0, borderColor: 'var(--gray-200)' } : undefined}>
      {/* Subject bar */}
      <div className="pp-thread-head" onClick={onHeaderClick} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHeaderClick() } }}>
        <span className="pp-thread-subject" title={subject}>{subject}</span>
        <span className="pp-thread-tools" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="pp-thread-tool"
            title={fullScreen ? 'Exit full screen' : 'Open full screen'}
            onClick={fullScreen ? () => setFullScreen(false) : enterFullScreen}>
            <span className="ms" style={{ fontSize: fullScreen ? 14 : 16 }}>{fullScreen ? 'close_fullscreen' : 'open_in_full'}</span>
          </button>
          {/* GHL hides the expand/collapse chevron in full screen for a thread
              of two or fewer — everything is already on screen. */}
          {!(fullScreen && count <= 2) && (
          <button type="button" className="pp-thread-tool"
            title={allExpanded ? 'Collapse thread' : 'Expand every email'}
            onClick={allExpanded ? collapse : expandAll}>
            <span className="ms" style={{ fontSize: 18 }}>{allExpanded ? 'expand_less' : 'expand_more'}</span>
          </button>
          )}
        </span>
      </div>

      {rows.map((r, i) => r.pill != null ? (
        // Directly under the subject bar the pill sits ON the bar's bottom
        // edge (no rule of its own); between rows it gets a rule.
        <div key={`pill-${i}`} className={`pp-thread-pillrow${i === 0 ? ' pp-thread-pillrow-top' : ''}`}>
          <button type="button" className="pp-thread-pill"
            onClick={view === 'collapsed' ? openHeaders : expandAll}
            title={view === 'collapsed' ? 'Show the earlier emails' : 'Show every email'}>
            <span className="pp-thread-plus">+</span>
            {r.pill} {r.pill === 1 ? 'message' : 'messages'} earlier
          </button>
        </div>
      ) : (
        <MailRow
          key={r.id}
          m={r}
          expanded={open.has(r.id)}
          onToggle={() => toggleOpen(r.id)}
          onOpenAttachment={onOpenAttachment}
          // Reply drops out of full screen first: the composer it seeds is on
          // the page underneath, and leaving an overlay up over it would hide
          // the very thing the click opened.
          onReply={onReplyEmail ? () => { if (!replyInline) setFullScreen(false); onReplyEmail(r) } : null}
          selected={selectedIds ? selectedIds.has(r.id) : null}
          onToggleSelect={onToggleSelect ? () => onToggleSelect(r) : null}
          last={i === rows.length - 1}
        />
      ))}

      {/* The reply box, inside the thread it answers — where GHL opens it. */}
      {inlineComposer && <div className="pp-thread-reply">{inlineComposer}</div>}
    </div>
  )

  if (!fullScreen) return card
  return (
    <>
      {/* The inline slot keeps its height while the card is lifted out, so
          the timeline does not reflow underneath the overlay. */}
      <div className="pp-thread" style={{ minHeight: 56, opacity: 0.35 }}>
        <div className="pp-thread-head"><span className="pp-thread-subject">{subject}</span></div>
      </div>
      <div
        className="pp-backdrop pp-backdrop-blur"
        style={{ zIndex: 60 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) setFullScreen(false) }}
      >
        <div
          ref={modalRef}
          className="pp-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`Email thread: ${subject}`}
          style={{
            width: '90vw', height: '90vh', maxWidth: 'none', maxHeight: 'none',
            padding: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden'
          }}
        >
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {card}
          </div>
        </div>
      </div>
    </>
  )
}

function MailRow({ m, expanded, onToggle, onOpenAttachment, onReply, selected, onToggleSelect, last }) {
  const preview = useMemo(() => htmlToText(m.body || ''), [m.body])
  const atts = Array.isArray(m.attachments) ? m.attachments : []
  const inbound = m.direction === 'inbound'
  const name = m.senderName || (inbound ? 'Customer' : 'Us')

  return (
    <div className={`pp-mail${last ? ' pp-mail-last' : ''}`}>
      <div className="pp-mail-head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}>
        {/* Deal AI selection, per email — the thread replaced one checkbox
            per timeline row, so the control moves inside. */}
        {onToggleSelect && (
          <input type="checkbox" className="pp-mail-tick" checked={!!selected}
            onClick={(e) => e.stopPropagation()} onChange={onToggleSelect}
            title={selected ? 'Co-Pilot reads this email' : 'Co-Pilot skips this email'} />
        )}
        <span className="pp-mail-avatar" data-inbound={inbound ? '1' : '0'}>
          {initialsOf(name)}
          <span className="ms pp-mail-avatar-badge">{inbound ? 'mail' : 'outgoing_mail'}</span>
        </span>
        <span className="pp-mail-who">
          <span className="pp-mail-name">{name}</span>
          {expanded
            ? <span className="pp-mail-to">{m.emailTo ? `To: ${m.emailTo}` : (m.emailFrom ? `From: ${m.emailFrom}` : '')}</span>
            : <span className="pp-mail-snippet">{preview || (atts.length ? `${atts.length} attachment${atts.length === 1 ? '' : 's'}` : '')}</span>}
        </span>
        <span className="pp-mail-time">{clock(m.ts)}</span>
        {onReply && (
          <button type="button" className="pp-mail-replyicon" title="Reply"
            onClick={(e) => { e.stopPropagation(); onReply() }}>
            <span className="ms" style={{ fontSize: 18 }}>reply</span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="pp-mail-body">
          {/* The same opened-email markup a single email uses — see
              EmailBody.EmailFull — so a reply inside a thread and an email
              on its own look like the same thing. */}
          <EmailFull m={m} onOpenAttachment={onOpenAttachment} />
          {onReply && (
            <div className="pp-mail-actions">
              <button type="button" className="pp-mail-reply" onClick={onReply}>
                <span className="ms" style={{ fontSize: 17 }}>reply</span> Reply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
