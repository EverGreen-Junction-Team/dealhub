import React, { useState } from 'react'
import { createPortal } from 'react-dom'

// A thumbs-down asks WHY, matching GHL's own Ask AI (ai-frontend
// NegativeFeedbackModal.vue) — same chip ids and labels, so a rating from
// either app groups the same way in a report. A bare thumbs-down tells you
// far less than one with "quoted the wrong deal" attached.
//
// Chip ids are sent to the server as-is (see routes/ai.js RATING_REASON_IDS)
// — keep this list and that Set in lockstep if either changes.
export const NEGATIVE_FEEDBACK_CHIPS = [
  { id: 'ui_bug', label: 'UI Bug' },
  { id: 'not_factually_correct', label: 'Not factually correct' },
  { id: 'didnt_follow_instructions', label: "Didn't follow instructions" },
  { id: 'refused_when_it_shouldnt', label: "Refused when it shouldn't have" },
  { id: 'incomplete_response', label: 'Incomplete response' },
  { id: 'report_content', label: 'Report content' },
  { id: 'other', label: 'Other' }
]

export default function NegativeFeedbackModal({ onCancel, onSubmit, busy }) {
  const [selected, setSelected] = useState(() => new Set())
  const [comment, setComment] = useState('')

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // At least one signal — a chip or actual text — or there is nothing to
  // record beyond the thumbs-down itself, which already saved on click.
  const canSubmit = selected.size > 0 || comment.trim().length > 0

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share feedback"
      className="pp-portal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // GHL's own modal blurs the whole page behind it, not just a dark
        // scrim — a plain tint left the sidebar and chat sharp underneath.
        background: 'rgba(15, 23, 42, 0.32)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        padding: 16
      }}
    >
      <div
        style={{
          width: 'min(560px, 100%)',
          background: '#fff',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          padding: 20,
          display: 'grid', gap: 16
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{
            margin: 0, fontSize: 'var(--text-xl)', fontWeight: 700,
            color: 'var(--text-heading)'
          }}>
            Share feedback
          </h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, border: 'none', borderRadius: 'var(--radius-sm)',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {NEGATIVE_FEEDBACK_CHIPS.map((chip) => {
            const active = selected.has(chip.id)
            return (
              <button
                key={chip.id}
                onClick={() => toggle(chip.id)}
                aria-pressed={active}
                style={{
                  height: 36, padding: '0 16px',
                  border: `1px solid ${active ? 'var(--brand-primary)' : 'var(--border-strong)'}`,
                  borderRadius: 'var(--radius-pill)',
                  background: active ? 'var(--tint-pine)' : '#fff',
                  color: active ? 'var(--accent-pine-text)' : 'var(--text-body)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
                  cursor: 'pointer'
                }}
              >
                {chip.label}
              </button>
            )
          })}
        </div>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Share details (optional)"
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            padding: '10px 12px',
            border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
            color: 'var(--text-heading)'
          }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              height: 38, padding: '0 16px',
              border: 'none', background: 'transparent',
              color: 'var(--text-heading)', fontWeight: 600,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              cursor: busy ? 'default' : 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit({ reasons: [...selected], comment: comment.trim() })}
            disabled={!canSubmit || busy}
            style={{
              height: 38, padding: '0 20px',
              border: 'none', borderRadius: 'var(--radius-md)',
              background: canSubmit && !busy ? 'var(--brand-primary)' : 'var(--gray-200)',
              color: canSubmit && !busy ? '#fff' : 'var(--text-faint)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
              cursor: canSubmit && !busy ? 'pointer' : 'default'
            }}
          >
            Submit
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
