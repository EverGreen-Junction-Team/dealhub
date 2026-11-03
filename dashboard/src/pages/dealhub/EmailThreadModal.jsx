import React, { useEffect, useMemo, useState } from 'react'
import { useModal } from '../../hooks/useModal'
import { Truncate } from '../shared/ListChrome'
import { htmlToText } from '../../utils/sanitiseHtml'
import AttachmentChip from './AttachmentChip'
import EmailFrame from './EmailFrame'
import AttachmentViewer from './AttachmentViewer'

// The full email thread, as a dialog.
//
// WHY A DIALOG AND NOT AN EXPANDING ROW. An email row already expands in place
// to show one message. A THREAD is a different question — "what has this
// conversation been?" — and answering it inline would push a five-message
// thread's worth of bodies into a timeline whose other rows are one-line SMS.
// Reading a conversation and scanning a timeline want opposite layouts, so the
// thread gets its own surface.
//
// WHY THE MESSAGES COME FROM THE TIMELINE, NOT AN ENDPOINT. The deal timeline
// query already returns every message mapped to this opportunity, each with
// its thread_id. So the thread is a group-by over data the page holds — a
// fetch would re-request rows already in memory and add a spinner to a click
// that can be instant. The tradeoff is honest and stated in the footer: this
// shows the messages ON THIS DEAL, so a reply that GHL mapped to a different
// opportunity is not here.
//
// DISPLAY ONLY, per the request: no reply, no forward.

export default function EmailThreadModal({ messages, initialId, subject, onClose }) {
  const modalRef = useModal()

  // Oldest first. A conversation reads top-down, and the timeline hands these
  // over newest-first (ORDER BY message_timestamp DESC).
  const ordered = useMemo(
    () => [...messages].sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0)),
    [messages]
  )

  // Which bodies are open. Gmail's rule, and the right one: the newest message
  // is what you came to read, the earlier ones are context you open if you
  // need them.
  //
  // The message CLICKED is opened too, when it isn't the newest — clicking the
  // 11:44 email and landing on a dialog showing only 12:10 expanded would lose
  // the thing the click was about.
  const [openIds, setOpenIds] = useState(() => {
    const newest = ordered[ordered.length - 1]
    const ids = new Set()
    if (newest) ids.add(newest.id)
    if (initialId) ids.add(initialId)
    return ids
  })

  const toggle = (id) => setOpenIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  // Escape closes. Bound here rather than in useModal, which deliberately does
  // no key handling — see the note in that hook.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The attachment being previewed, or null. Held on the dialog rather than
  // per-message so only one viewer is ever mounted; it renders at z-index 65,
  // above this dialog's 60, because it opens from here.
  const [viewing, setViewing] = useState(null)

  const allOpen = openIds.size === ordered.length

  return (
    <div
      className="pp-backdrop"
      // Below ConfirmDialog's 70: a confirm can be raised over anything, and
      // this is a read-only view that nothing is raised from.
      style={{ zIndex: 60 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={modalRef}
        className="pp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Email thread: ${subject || '(no subject)'}`}
        // Wider than the editors: this is prose to be read, and email bodies
        // carry their own line breaks. Capped so lines stay readable rather
        // than running the full width of a desktop screen.
        style={{ width: 'min(760px, 100%)', display: 'flex', flexDirection: 'column' }}
      >
        <header
          className="pp-modal-head"
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <span className="ms" style={{ fontSize: 20, color: 'var(--text-faint)', flex: 'none' }}>
            forum
          </span>
          <h2 className="pp-modal-title" style={{ flex: 1, minWidth: 0 }}>
            {/* The subject is the thread's name. Truncated rather than wrapped:
                a two-line header would shift the message list down on open. */}
            <Truncate style={{ display: 'block' }}>
              {subject || '(no subject)'}
            </Truncate>
          </h2>

          {/* Expand/collapse all. Earns its place on a long thread: opening
              six messages one at a time to search for a sentence is the
              obvious frustration with the Gmail default. */}
          {ordered.length > 1 && (
            <button
              type="button"
              className="pp-thread-allbtn"
              onClick={() => setOpenIds(allOpen ? new Set() : new Set(ordered.map((x) => x.id)))}
              title={allOpen ? 'Collapse every message' : 'Expand every message'}
            >
              <span className="ms" style={{ fontSize: 16 }}>
                {allOpen ? 'unfold_less' : 'unfold_more'}
              </span>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}

          <button
            type="button"
            className="pp-thread-x"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <span className="ms" style={{ fontSize: 20 }}>close</span>
          </button>
        </header>

        <div
          className="pp-modal-body"
          // Scrolls independently of the page, which useModal has locked.
          style={{ padding: 0, overflowY: 'auto', maxHeight: '68vh' }}
        >
          {ordered.map((m, i) => (
            <ThreadMessage
              key={m.id}
              m={m}
              index={i}
              total={ordered.length}
              open={openIds.has(m.id)}
              onToggle={() => toggle(m.id)}
              onOpenAttachment={(list, idx) => {
                const arr = list.filter((a) => a && a.url)
                if (arr.length === 0) return
                const at = Math.max(0, arr.indexOf(list[idx]))
                setViewing({ attachments: arr, index: at })
              }}
            />
          ))}
        </div>

        <footer
          className="pp-modal-foot"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px var(--space-4)',
            borderTop: '1px solid var(--border-default)',
            background: 'var(--gray-25)',
            fontSize: 'var(--text-sm)', color: 'var(--text-muted)'
          }}
        >
          <span className="ms" style={{ fontSize: 15, color: 'var(--text-faint)' }}>info</span>
          {/* Says what the view is scoped to. Without this a rep could read a
              two-message thread as complete when GHL mapped a third reply to
              another deal — and would have no way to know. */}
          <span>
            {ordered.length} {ordered.length === 1 ? 'message' : 'messages'} on this deal
          </span>
        </footer>
      </div>

      {viewing && (
        <AttachmentViewer
          attachments={viewing.attachments}
          index={viewing.index}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

// One message in the thread. Collapsed: sender, time, one line of body.
// Expanded: the addresses and the full body.
function ThreadMessage({ m, index, total, open, onToggle, onOpenAttachment }) {
  // htmlToText, not textContent — the latter fuses block boundaries and turns
  // `<p>Hi</p><p>Thanks</p>` into "HiThanks".
  const preview = useMemo(() => htmlToText(m.body || ''), [m.body])
  const inbound = m.direction === 'inbound'

  // Fetched at ingest by messageWriter — an email webhook never carries them.
  // Empty for anything synced before that changed, so this must degrade to
  // "no attachment section" rather than to an empty labelled box.
  const atts = Array.isArray(m.attachments) ? m.attachments : []
  const attTitle = atts.length
    ? `${atts.length} ${atts.length === 1 ? 'file' : 'files'}: ${atts.map((a) => a.name).join(', ')}`
    : undefined

  return (
    <article className={index < total - 1 ? 'pp-thread-msg pp-thread-msg-div' : 'pp-thread-msg'}>
      <button
        type="button"
        className="pp-thread-head"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Collapse this message' : 'Show this message'}
      >
        {/* Direction, not an avatar. Whether we sent it or they did is the
            fact that orients you in a conversation; initials in a circle look
            richer and say less. */}
        <span
          className="ms pp-thread-dir"
          style={{ color: inbound ? 'var(--accent-pine-text)' : 'var(--text-faint)' }}
          title={inbound ? 'Received' : 'Sent'}
        >
          {inbound ? 'call_received' : 'call_made'}
        </span>

        <span className="pp-thread-lines">
          <span className="pp-thread-who">
            <span className="pp-thread-name">{m.senderName || (inbound ? 'Contact' : 'Team member')}</span>
            <span className="pp-thread-time">{fullClock(m.ts)}</span>
          </span>
          {!open && preview && <span className="pp-thread-prev">{preview}</span>}
        </span>

        {/* A count on the collapsed header, so a rep scanning a long thread
            can see which message carried the files without opening each. */}
        {atts.length > 0 && (
          <span className="pp-thread-clip" title={attTitle}>
            <span className="ms" style={{ fontSize: 13 }}>attach_file</span>
            {atts.length}
          </span>
        )}
        <span className="ms pp-thread-chev">{open ? 'expand_less' : 'expand_more'}</span>
      </button>

      {open && (
        <div className="pp-thread-full">
          {(m.emailFrom || m.emailTo) && (
            <div className="pp-email-addr">
              {m.emailFrom && (
                <span><span className="pp-email-addr-k">From</span>{m.emailFrom}</span>
              )}
              {m.emailTo && (
                <span><span className="pp-email-addr-k">To</span>{m.emailTo}</span>
              )}
            </div>
          )}
          {m.body ? (
            // RichBody sanitises: the body is HTML (the server's cleanEmail
            // strips the head and inline styles but keeps the tags), and this
            // is the single audited innerHTML site in the app.
            <EmailFrame html={m.body} />
          ) : (
            <p className="pp-thread-nobody">This email has no body text.</p>
          )}

          {atts.length > 0 && (
            <div className="pp-email-atts">
              <span className="pp-email-atts-h">
                <span className="ms" style={{ fontSize: 14 }}>attach_file</span>
                {atts.length} {atts.length === 1 ? 'attachment' : 'attachments'}
              </span>
              <div className="pp-email-atts-list">
                {atts.map((att, i) => (
                  <AttachmentChip
                    key={`${att.name}-${i}`}
                    att={att}
                    channelAccent="sky"
                    // Previewed in a dialog rather than a new tab: a rep
                    // checking which quote went out should not lose the
                    // thread they are reading.
                    onClick={() => onOpenAttachment(atts, i)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

// Date and time. The timeline's own clock shows time only, because a day
// header supplies the date — inside a thread there are no day headers, and a
// bare "11:44 AM" on a message from March would be misread as today.
function fullClock(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], {
    day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit'
  })
}
