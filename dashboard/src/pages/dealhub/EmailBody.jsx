import React, { useMemo, useState } from 'react'
import { htmlToText } from '../../utils/sanitiseHtml'
import EmailFrame from './EmailFrame'
import AttachmentChip from './AttachmentChip'

// The collapsed/expandable email card used by the deal timeline AND the
// contact record.
//
// EXTRACTED so there is one implementation. It lived inside Timeline.jsx and
// the contact view grew its own plainer card, so the same email rendered two
// different ways depending on which page you were on — subject-and-chevron in
// one, a flat paragraph in the other.
//
export default function EmailBody({ m, thread, onOpenThread, onOpenAttachment }) {
  const [open, setOpen] = useState(false)

  // THE BODY IS HTML, not text.
  //
  // cleanMessageBody on the server runs cleanEmail for this channel, which
  // strips the <head>, the <style> block and the inline font stacks — but it
  // KEEPS the tags: a three-paragraph email arrives as
  // `<div><p>…</p><p>…</p></div>`. Verified against the real webhook payload.
  // So it renders through RichBody (which sanitises, the single audited
  // innerHTML site) — as text it would show literal <p> tags to the rep.
  //
  // And the preview needs htmlToText, not textContent: textContent fuses
  // block boundaries, turning `<p>Hi</p><p>Thanks</p>` into "HiThanks". That
  // exact bug has bitten this codebase twice.
  const preview = useMemo(() => htmlToText(m.body || ''), [m.body])

  // Worth showing once expanded: on a deal with three contacts, "which of
  // these people did we actually email" is the question, and the row's sender
  // name does not answer it. Absent on older rows — the addresses come from
  // raw_message, which early syncs did not always store.

  const threaded = thread && thread.length > 1

  // Email attachments. Empty for every email synced before the server started
  // fetching them, so every use below has to tolerate none.
  const atts = Array.isArray(m.attachments) ? m.attachments : []
  const attTitle = atts.length
    ? `${atts.length} ${atts.length === 1 ? 'file' : 'files'}: ${atts.map((a) => a.name).join(', ')}`
    : undefined

  return (
    <div className="pp-email" style={{ marginTop: 4 }}>
      {/* A 3-COLUMN, 2-ROW GRID over the whole card head.
          Row 1: icon | subject | chip + chevron
          Row 2: (icon gutter) | preview spanning to the card's right edge
          Why not simply nest the chip next to the subject: it has to stay
          outside the expander <button> (a button inside a button is invalid
          HTML, and the inner click would also fire the expander). And why the
          preview is a grid child rather than living inside the expander with
          the subject: as a sibling of the subject inside one column, it was
          confined to that column's width, so the card read as a narrow text
          column with a chip beside it. On its own row it runs the full width
          and the chip belongs to the subject line alone.
          The expander is a transparent overlay across rows 1-2 of the text
          columns, so clicking anywhere on the text still toggles the email
          while the chip stays independently clickable. */}
      <div className="pp-email-bar">
        <span className="ms pp-email-icon">mail</span>

        <span className="pp-email-subject">
          {m.subject || '(no subject)'}
        </span>

        {/* ATTACHMENT COUNT, collapsed view.
            An email's files are the reason a rep opens it — "did the quote
            actually go out" — so the count belongs on the closed row. It is
            only a count here: names and sizes need the width of the expanded
            body, and three filenames on the subject line would push the
            subject itself out of view.
            These arrive because the server FETCHES them: an outbound email
            webhook always sends attachments: null, so messageWriter calls
            GET /conversations/messages/:id at ingest. */}
        {atts.length > 0 && (
          <span className="pp-email-clip" title={attTitle}>
            <span className="ms" style={{ fontSize: 13 }}>attach_file</span>
            {atts.length}
          </span>
        )}

        {threaded && (
          <button
            type="button"
            className="pp-email-thread"
            onClick={() => onOpenThread(m)}
            title={`Show all ${thread.length} messages in this thread`}
          >
            <span className="ms" style={{ fontSize: 14 }}>forum</span>
            {thread.length} in thread
          </button>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse this email' : 'Show the full email'}
          title={open ? 'Collapse this email' : 'Show the full email'}
          className="pp-email-chevbtn"
        >
          <span className="ms pp-email-chev">
            {open ? 'expand_less' : 'expand_more'}
          </span>
        </button>

        {/* One preview line while collapsed, so the row says what the mail is
            about without opening it. Hidden when open — repeating the first
            line directly above the full body reads as a bug. */}
        {!open && preview && (
          <span className="pp-email-preview">{preview}</span>
        )}

        {/* The click target for expanding: covers the text, sits UNDER the
            chip in z-order so the chip wins its own clicks. Empty and
            transparent — it is a hit area, not a visual element. */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse this email' : 'Show the full email'}
          title={open ? 'Collapse this email' : 'Show the full email'}
          className="pp-email-hit"
        />
      </div>

      {open && <EmailFull m={m} onOpenAttachment={onOpenAttachment} />}
    </div>
  )
}

// The OPENED email — addresses, body, attachments — as one component, so a
// single email in the timeline and an email opened inside a thread card
// render identically. The thread card had its own body markup (RichBody,
// no address block) and the two read as different kinds of email.
export function EmailFull({ m, onOpenAttachment }) {
  const preview = useMemo(() => htmlToText(m.body || ''), [m.body])
  const hasAddresses = m.emailFrom || m.emailTo
  const atts = Array.isArray(m.attachments) ? m.attachments : []
  return (
    <div className="pp-email-full">
      {hasAddresses && (
        <div className="pp-email-addr">
          {m.emailFrom && (
            <span><span className="pp-email-addr-k">From</span>{m.emailFrom}</span>
          )}
          {m.emailTo && (
            <span><span className="pp-email-addr-k">To</span>{m.emailTo}</span>
          )}
        </div>
      )}
      {/* An email sent with only an attachment has an EMPTY body — GHL
          sends `<div></div>`, which is truthy, so RichBody's own
          `if (!html) return null` does not catch it and it rendered an
          empty block above the attachment rule. `preview` is the body run
          through htmlToText, so it is the honest test of "is there any
          text here". */}
      {preview ? (
        <EmailFrame html={m.body} />
      ) : atts.length === 0 ? (
        // No text AND no files: say so rather than showing a blank card,
        // which reads as a loading failure.
        <p className="pp-email-nobody">This email has no message text.</p>
      ) : null}

      {/* THE FILES THEMSELVES, once expanded.
          Named and sized here rather than counted: at this width a rep can
          see that "quote-v3.pdf" went out and not "quote-v2.pdf", which is
          the actual question. Below the body because that is the reading
          order of an email, and separated by a rule so a long body does
          not run straight into them. */}
      {atts.length > 0 && (
        <div className={preview ? 'pp-email-atts' : 'pp-email-atts pp-email-atts-first'}>
          <span className="pp-email-atts-h">
            <span className="ms" style={{ fontSize: 14 }}>attach_file</span>
            {atts.length} {atts.length === 1 ? 'attachment' : 'attachments'}
          </span>
          <div className="pp-email-atts-list">
            {atts.map((att, i) => (
              <AttachmentChip
                key={`${att.name}-${i}`}
                att={att}
                channelAccent={m.channelAccent}
                // The whole list plus this index, so the viewer's arrows
                // can page through the email's other files.
                onClick={() => onOpenAttachment(atts, i)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
