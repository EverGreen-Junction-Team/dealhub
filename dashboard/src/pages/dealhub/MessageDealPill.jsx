import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dealsAPI } from '../../api/deals'
import { Truncate } from '../shared/ListChrome'

// Which deal a message is filed against, and the control to change it.
//
// A message belongs to ONE deal (agreed with James, 8 Sep — see
// docs/MESSAGE-DEAL-LINKING-RULE.md). The engine files it automatically
// against the contact's earliest open deal; this is how a sales manager
// overrides that.
//
// LOCAL ONLY. The CRM has no concept of a message belonging to a deal, so
// nothing is written upstream — the attribution is ours. The change is
// recorded as a manual decision, which the engine never overwrites on a
// later sync or backfill.
//
// Portalled to the body: the timeline sits inside panels with
// `overflow: hidden`, which clip an absolutely-positioned dropdown. Same
// reason as TaskDealsPopover.
export default function MessageDealPill({
  message, dealId, targets = [], onMoved,
  // How to persist the move. Defaults to the deal-scoped route, which needs a
  // dealId. The contact record has no deal in scope, so it passes the
  // contact route instead — same control, same wording, one component.
  onSave
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [pos, setPos] = useState(null)
  const anchorRef = useRef(null)
  const boxRef = useRef(null)

  // Only the OTHER deals are worth offering, plus an explicit unlink.
  //
  // On the contact record there is no deal in scope, so `dealId` is absent
  // and the message's own deal is what to exclude — offering the deal it is
  // already on is a no-op that looks like a choice.
  const currentId = dealId || message.deal?.id || null
  const options = targets.filter((t) =>
    // A real deal only. reassignment-targets appends a synthetic
    // `{ id: null, label: 'Unassigned — contact record only' }` from before
    // this control had its own unlink row, so the same action appeared
    // twice — once as a deal option, once as "Unlink from every deal".
    // DealSection filters it the same way (`d.id && !d.current`).
    //
    // Dropped rather than removed from the endpoint: DealSection also reads
    // it, and changing a shared response to fix one consumer is how the
    // other one breaks.
    t.id && t.id !== currentId
  )

  useEffect(() => {
    if (!open) return
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const W = 260
      const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8))
      const below = window.innerHeight - r.bottom
      const flip = below < 220 && r.top > below
      setPos({
        left,
        top: flip ? undefined : r.bottom + 4,
        bottom: flip ? window.innerHeight - r.top + 4 : undefined
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target)) return
      if (anchorRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function move(targetId) {
    setBusy(true)
    setError(null)
    try {
      if (onSave) await onSave(message.messageId, targetId)
      else await dealsAPI.setMessageMapping(dealId, message.messageId, targetId)
      setOpen(false)
      if (onMoved) onMoved(message, targetId)
    } catch (e) {
      // The server's words. "Could not move" tells the rep nothing they can
      // act on; "that deal is not on this contact" tells them exactly why.
      setError(e?.response?.data?.error || e?.message || 'That did not save')
    } finally {
      setBusy(false)
    }
  }

  const manual = message.mappedManually === true
  // On the contact record a message may be filed against NOTHING. That is a
  // third state, not an absence — the pill is how it gets filed, so it has
  // to be visible and clickable rather than hidden.
  const filed = dealId ? true : !!message.deal
  // Who moved it, when we can resolve the name. 'system' is the engine's own
  // marker and is never shown — "moved by system" would imply a person.
  const by = manual && message.mappedByName && message.mappedByName !== 'system'
    ? message.mappedByName
    : null

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        title={
          !filed
            ? 'Not linked to a deal — click to link it'
            : manual
              ? `Moved here by hand${by ? ` by ${by}` : ''} — click to change`
              : 'Linked automatically by the linking rule — click to move it'
        }
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 11px', flex: 'none',
          // Sentence case at the metadata size. It was 10.5px uppercase,
          // which beside "Outbound" and the time read as a tag rather than
          // as the word it is.
          fontSize: 'var(--text-base)', fontWeight: 600,
          // NO border by default. This sits beside OUTBOUND and the time —
          // metadata, not an action — and an outlined pill on every row read
          // as a button competing with the message itself. The border comes
          // back on hover, where it signals "this is clickable".
          border: '1px solid transparent',
          borderRadius: 999,
          background: manual && filed ? 'var(--tint-pine)' : 'transparent',
          color: manual && filed ? 'var(--accent-pine-text)' : 'var(--text-faint)',
          cursor: 'pointer', whiteSpace: 'nowrap'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-strong)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'transparent'
        }}
      >
        {/* The icon carries the distinction too, not only the words: a
            person for a human decision, the automation mark for the rule.
            Colour alone would not survive a greyscale print or a
            colour-blind reader. */}
        <span className="ms" style={{ fontSize: 15 }}>
          {!filed ? 'help' : manual ? 'person' : 'bolt'}
        </span>
        {/* On the contact record the deal NAME is the useful label — the
            page is a list of messages across many deals, so "Auto" alone
            would not say which one. In the deal timeline the deal is
            already the page, so the provenance is what adds information. */}
        {!filed
          ? 'Not linked'
          : dealId
            ? (manual ? 'Moved' : 'Auto')
            : (message.deal?.name || 'Linked')}
      </button>

      {open && pos && createPortal(
        <div
          ref={boxRef}
          // .pp-portal — this is outside [data-dealhub], and without it the
          // Material Symbols rule does not apply and every icon renders as
          // its ligature text ("link_off").
          className="pp-portal"
          style={{
            position: 'fixed',
            left: pos.left, top: pos.top, bottom: pos.bottom,
            zIndex: 50, width: 300,
            // No padding on the shell: the header sits on its own tinted
            // ground edge to edge, and the list pads itself. Padding here
            // would leave a white gutter around the header band.
            padding: 0, overflow: 'hidden',
            background: '#fff',
            border: '1px solid var(--border-default)',
            borderRadius: 12,
            // Two shadows: a tight one for the edge and a broad soft one for
            // depth. A single large blur reads as a grey smudge.
            boxShadow: '0 1px 2px rgba(15,34,26,0.06), 0 12px 28px rgba(15,34,26,0.14)',
            textAlign: 'left'
          }}
        >
          {/* One line of provenance, not a stacked heading — a manager
              opening this wants "why is it here?" answered in passing, then
              the options. The old two-line block took more room than the
              list it introduced. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '10px 12px',
            borderBottom: '1px solid var(--border-default)',
            // A tinted band so the state reads as context, not as the first
            // option in the list. Unfiled is neutral; a filed message takes
            // the accent, matching its pill.
            // gray-50, not gray-25: #fafbfc is a hair off white and the
            // band read as transparent against the card.
            background: filed ? 'var(--tint-pine)' : 'var(--gray-50)',
            fontSize: 12, fontWeight: 500,
            color: filed ? 'var(--accent-pine-text)' : 'var(--text-muted)'
          }}>
            {/* Matches the button's icon, including the not-filed case —
                the two were out of step, so an unfiled message opened a
                popover showing the automation mark beside "no deal was
                open when this was sent". */}
            <span className="ms" style={{ fontSize: 15, flex: 'none', opacity: 0.85 }}>
              {!filed ? 'help' : manual ? 'person' : 'bolt'}
            </span>
            <Truncate>
              {!filed
                ? 'No deal was open when this was sent'
                : manual
                  ? (by ? `Moved here by ${by}` : 'Moved here by hand')
                  : 'Linked automatically — earliest open deal'}
            </Truncate>
          </div>

          {/* The heading only earns its space when there is a list under it.
              With no other deals it introduced an empty gap, which is what
              made the popover look broken. */}
          {options.length > 0 && (
            <div style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.06em', color: 'var(--text-faint)',
              padding: '10px 12px 4px'
            }}>
              {/* "Link to" / "Move to", not "File against".
                  The rest of the app says LINK throughout — "Link this task
                  to a deal", "Not linked to a deal" — and "file against" was
                  filing-cabinet language invented here that appeared nowhere
                  else. */}
              {filed ? 'Move to' : 'Link to'}
            </div>
          )}

          {options.length === 0 && (
            <p style={{
              margin: 0, padding: '10px 12px 12px',
              fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.45
            }}>
              {filed
                ? 'This contact has no other deals to move it to.'
                : 'This contact has no deals to link it to.'}
            </p>
          )}

          <div style={{
            display: 'flex', flexDirection: 'column', gap: 5,
            padding: '0 10px 10px'
          }}>
            {options.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={busy}
                onClick={() => move(t.id)}
                // Hover on the row, not just the cursor. A list of plain text
                // gives no feedback that each line is a target.
                // A visible card at REST — border, white ground, its own
                // row — because relying on hover alone left each option
                // looking like a bullet in a list. Nothing said it could be
                // clicked until the pointer was already on it, and on a
                // touch device that moment never comes.
                //
                // Hover and focus live in CSS (.pp-deal-option), so a
                // keyboard user gets the same affordance as a mouse one.
                className="pp-deal-option"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 10px', width: '100%',
                  borderRadius: 8, textAlign: 'left',
                  fontSize: 13, fontWeight: 500, color: 'var(--text-body)',
                  cursor: busy ? 'wait' : 'pointer'
                }}
              >
                {/* A dot, coloured by status — green for a live deal, grey
                    for a closed one. Reads at a glance where a trailing
                    "won" label has to be read. */}
                <span style={{
                  width: 6, height: 6, flex: 'none', borderRadius: '50%',
                  background: !t.status || t.status === 'open'
                    ? 'var(--accent-pine-text)'
                    : 'var(--border-strong)'
                }} />
                {/* min-width: 0 so a long deal name truncates instead of
                    pushing the status chip out of the popover. */}
                <Truncate style={{ flex: 1 }}>
                  {/* `name` OR `label`. Two endpoints feed this control and
                      they disagree: the contact page sends `name`, the
                      deal-hub's reassignment-targets sends `label`. The
                      mismatch rendered a row with a dot and no text — no
                      error, nothing in the console, just a nameless option.
                      Tolerating both means a third caller cannot reintroduce
                      it. The id is a last resort so a row is never blank. */}
                  {t.name || t.label || t.id}
                </Truncate>
                {/* A manager may deliberately file against a won or lost deal
                    (James, 8 Sep), so those are offered — labelled, so the
                    choice is informed rather than accidental. */}
                {t.status && t.status !== 'open' && (
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    padding: '2px 5px', borderRadius: 4,
                    background: 'var(--gray-50)', color: 'var(--text-faint)',
                    flex: 'none'
                  }}>
                    {t.status}
                  </span>
                )}

              </button>
            ))}

            {filed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => move(null)}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-50)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                // Deliberately NOT a card. The deals above are targets you
                // pick from; this is the destructive escape hatch, and giving
                // it the same weight would make it look like a third deal.
                //
                // A rule ABOVE it, though. Space alone was enough under
                // bordered cards, but with no deals to offer the empty-state
                // sentence sits directly against this row and the two read as
                // one block. The rule separates them in both states.
                //
                // Inset by the container's padding rather than full-bleed, so
                // it groups the list above rather than cutting the card in two.
                padding: '9px 10px 7px', marginTop: 4,
                borderTop: '1px solid var(--border-default)',
                borderLeft: 'none', borderRight: 'none', borderBottom: 'none',
                // Rounded at the BOTTOM only: the top edge carries the rule
                // and must stay square against it, while the hover highlight
                // would otherwise render as a hard-cornered rectangle inside
                // a 12px-rounded card.
                borderRadius: '0 0 8px 8px',
                background: 'transparent', textAlign: 'left',
                fontSize: 12.5, color: 'var(--text-muted)',
                cursor: busy ? 'wait' : 'pointer',
                transition: 'background 0.12s ease'
              }}
            >
              <span className="ms" style={{ fontSize: 14 }}>link_off</span>
              {/* "this deal", not "every deal". A message is linked to ONE
                  deal at most, so "every" describes something that cannot
                  happen — it was carried over from the task popover, where a
                  task genuinely can hold up to ten. */}
              Unlink from this deal
            </button>
            )}
          </div>

          {error && (
            <p role="alert" style={{
              margin: 0, padding: '8px 12px',
              borderTop: '1px solid var(--border-default)',
              background: 'var(--tint-clay, #FDF2F2)',
              fontSize: 11.5, lineHeight: 1.4, color: 'var(--status-stuck)'
            }}>
              {error}
            </p>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
