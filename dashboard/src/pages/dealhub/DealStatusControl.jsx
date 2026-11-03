import React, { useState } from 'react'
import { Select, Input } from 'antd'
import {
  CLOSING_STATUSES, REASON_LABEL, REASON_PLACEHOLDER
} from '../../utils/outcomeReason'

// The deal's status, as a control rather than a badge.
//
// Deal Hub showed status as a read-only pill, and only once the deal was
// already closed — so an open deal displayed nothing at all and the only way
// to close one was the full editor on the Deals tab. This is the control a
// sales manager actually reaches for.
//
// WHY A DIALOG AND NOT A BARE DROPDOWN. Closing a deal REQUIRES a reason, and
// the reason lands in a different GHL field per outcome (the server maps
// won -> meddic_10, lost -> meddic_9, abandoned -> meddic_11). A dropdown that
// committed on change would have to either save without the reason — the
// thing we are trying to prevent — or pop the question afterwards, which
// leaves a closed deal on screen while the manager is still being asked why.
// So the choice is staged: pick, explain, then commit as one action.
//
// Reopening (-> Open) has no reason and commits immediately; there is no
// outcome to explain.

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'abandoned', label: 'Abandoned' }
]

// Each outcome's colour, matching StatusPill so the control and the badge
// never disagree about what "won" looks like.
const TONE = {
  open: { fg: 'var(--text-body)', bg: 'transparent' },
  won: { fg: 'var(--status-done-text)', bg: 'var(--status-done)' },
  lost: { fg: 'var(--status-stuck-text)', bg: 'var(--status-stuck)' },
  abandoned: { fg: 'var(--text-muted)', bg: 'var(--surface-sunken)' }
}

// The recorded reason's own treatment, keyed on the outcome so the block reads
// as part of that outcome rather than as a stray paragraph. `tint` is the
// ground; `rail` is the left edge that ties it to the status above it.
const REASON_TONE = {
  won:       { tint: 'var(--tint-pine)', rail: 'var(--status-done)' },
  lost:      { tint: 'var(--tint-rose)', rail: 'var(--status-stuck)' },
  abandoned: { tint: 'var(--tint-gray)', rail: 'var(--gray-300)' }
}

// What the reason answers. Past tense — it is a record, not a prompt, and it
// sits under a status that has already been decided.
const REASON_HEADING = {
  won: 'Why it was won',
  lost: 'Why it was lost',
  abandoned: 'Why it was abandoned'
}

export default function DealStatusControl({
  status = 'open',
  // The reason already on record, so reopening a closed deal shows what was
  // said last time rather than an empty box.
  outcomeReason = null,
  onSave,
  saving = false,
  error = null,
  lostReasons = null,
  onNeedLostReasons
}) {
  // The outcome being explained. null = no dialog open.
  const [pending, setPending] = useState(null)
  const [reason, setReason] = useState('')
  const [lostReasonId, setLostReasonId] = useState(null)
  const [touched, setTouched] = useState(false)

  const current = String(status || 'open').toLowerCase()
  // What the dropdown displays: the pending choice while its reason is being
  // asked for, otherwise the saved status.
  const shown = pending || current

  // Clear the pending choice once the save has landed — i.e. when the status
  // prop finally reports what was picked. Also clears it if the deal's status
  // changes underneath us (another tab, a webhook), since the dialog would
  // then be asking about a state that no longer applies.
  React.useEffect(() => {
    if (pending && current === pending) setPending(null)
  }, [current, pending])
  // Keyed on what is DISPLAYED, so a pending choice is coloured as itself
  // rather than keeping the old status's treatment.
  const tone = TONE[shown] || TONE.open

  function pick(next) {
    // Compared against what the DROPDOWN shows, not the saved status.
    //
    // `current` alone was wrong once a pending choice existed: with the deal
    // still Open and Abandoned picked, choosing "Open" matched `current` and
    // returned early — so the selection did nothing and the reason panel
    // stayed open asking about Abandoned. Re-picking the pending value is the
    // real no-op.
    if (next === shown) return

    if (!CLOSING_STATUSES.includes(next)) {
      // Back to Open. Nothing to explain, so close the panel — it is asking
      // about an outcome that is no longer being chosen.
      setPending(null)
      setReason('')
      setLostReasonId(null)
      setTouched(false)
      // Only actually save if this CHANGES the stored status. Backing out of
      // a pending choice on a deal that was already Open is a cancel, not a
      // write.
      if (next !== current) onSave && onSave({ status: next })
      return
    }
    setPending(next)
    setReason('')
    setLostReasonId(null)
    setTouched(false)
    // GHL's own lost-reason picklist is a separate fetch; ask for it only
    // when it is about to be shown.
    if (next === 'lost' && lostReasons === null && onNeedLostReasons) onNeedLostReasons()
  }

  function commit() {
    setTouched(true)
    if (!reason.trim()) return
    onSave && onSave({
      status: pending,
      reason: reason.trim(),
      lostReasonId: lostReasonId || undefined
    })
    // `pending` is NOT cleared here.
    //
    // The save is still in flight, and clearing it would drop the dropdown
    // back to the old status until the new one arrives — a visible flash of
    // "Open" on a deal the rep just marked lost. The effect below clears it
    // once the saved status actually matches, so the control moves exactly
    // once. A failed save leaves the choice on screen with the error, which
    // is what lets the rep retry without picking again.
  }

  const missing = touched && !reason.trim()

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <Select
        // The PENDING choice while the reason is being asked for, otherwise
        // the saved one.
        //
        // Bound to `current` alone, the dropdown snapped back to the saved
        // status the moment it was changed: the rep picked "Lost", the dialog
        // below correctly asked why the deal was lost, and the control above
        // it still read "Open". Two halves of the same question disagreeing.
        value={shown}
        onChange={pick}
        options={STATUS_OPTIONS}
        size="large"
        disabled={saving}
        loading={saving}
        popupClassName="pp-menu"
        style={{ width: '100%' }}
        // The closed states carry their colour into the closed control, so the
        // card reads as won/lost at a glance without a separate badge.
        styles={{ root: { fontWeight: shown === 'open' ? 400 : 600, color: tone.fg } }}
      />

      {/* The reason already on record. Shown when the deal is closed and the
          dialog is not open — otherwise the manager sees two reason boxes.

          It was a bare grey <p> sitting directly under the dropdown, which
          read as an orphaned line of text: nothing said it was the REASON, or
          that it belonged to the status above it. Now a labelled block,
          tinted and railed to match the outcome. */}
      {!pending && outcomeReason && CLOSING_STATUSES.includes(current) && (
        <div style={{
          borderLeft: `3px solid ${(REASON_TONE[current] || {}).rail || 'var(--gray-300)'}`,
          borderRadius: '0 var(--radius-md) var(--radius-md) 0',
          background: (REASON_TONE[current] || {}).tint || 'var(--surface-sunken)',
          padding: '8px 11px',
          display: 'grid', gap: 3
        }}>
          <span style={{
            fontSize: 'var(--text-sm)', fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.04em'
          }}>
            {REASON_HEADING[current] || 'Reason'}
          </span>
          <p style={{
            margin: 0, fontSize: 'var(--text-md)',
            color: 'var(--text-heading)', lineHeight: 1.45,
            // A rep can type a paragraph: let it wrap rather than clip, and
            // keep any line breaks they typed.
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
          }}>
            {outcomeReason}
          </p>
        </div>
      )}

      {pending && (
        <div
          style={{
            display: 'grid', gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--surface-sunken)'
          }}
        >
          {/* --text-md, not --text-sm (11px): this question is the whole
              point of the panel, and at label size it read as a caption above
              the box rather than something being asked. */}
          <label style={{
            fontSize: 'var(--text-md)', fontWeight: 600,
            color: 'var(--text-heading)', lineHeight: 1.4
          }}>
            {REASON_LABEL[pending]}
          </label>

          {/* GHL's native lost-reason picklist, when marking lost. Kept
              alongside the free text rather than instead of it: the picklist
              is what GHL's own reporting reads, the sentence is what a person
              reads. The server records both. */}
          {pending === 'lost' && (
            <Select
              value={lostReasonId || undefined}
              onChange={setLostReasonId}
              showSearch
              optionFilterProp="label"
              loading={lostReasons === null}
              placeholder={lostReasons === null ? 'Loading…' : 'Pick a reason (optional)'}
              options={(lostReasons || []).map((r) => ({
                value: r.id || r.value,
                label: r.name || r.label
              }))}
              notFoundContent="No lost reasons configured in your CRM"
              popupClassName="pp-menu"
              allowClear
              style={{ width: '100%' }}
            />
          )}

          <Input.TextArea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={REASON_PLACEHOLDER[pending]}
            rows={2}
            maxLength={2000}
            autoFocus
            status={missing ? 'error' : undefined}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commit()
              if (e.key === 'Escape') setPending(null)
            }}
          />

          {missing && (
            <p style={{
              margin: 0, fontSize: 'var(--text-sm)',
              color: 'var(--status-stuck-text)'
            }}>
              A reason is needed before this deal can be closed.
            </p>
          )}

          {error && (
            <p style={{
              margin: 0, fontSize: 'var(--text-sm)',
              color: 'var(--status-stuck-text)'
            }}>
              {error}
            </p>
          )}

          {/* Both buttons carry their own box styling.
              .pp-btn-primary supplies only the hover/active/focus STATES —
              the fill, height and radius are inline everywhere it is used
              (see the note above the class in dealhub-tokens.css). Relying on
              the class alone rendered a bare unpadded rectangle. */}
          <div style={{
            display: 'flex', gap: 'var(--space-2)',
            justifyContent: 'flex-end', alignItems: 'center',
            marginTop: 'var(--space-1)'
          }}>
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={saving}
              style={{
                height: 32, padding: '0 14px',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-card)',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                fontWeight: 500, color: 'var(--text-body)',
                cursor: saving ? 'not-allowed' : 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={saving}
              className="pp-btn-primary"
              style={{
                height: 32, padding: '0 14px',
                border: 'none', borderRadius: 'var(--radius-md)',
                background: 'var(--brand-primary)', color: '#fff',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer'
              }}
            >
              {saving ? 'Saving…' : `Mark ${pending}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
