import React, { useState } from 'react'
import { aiAPI } from '../../api/ai'
import { HoverTooltip } from './ComposerExtras'
import NegativeFeedbackModal from './NegativeFeedbackModal'

// Thumbs up/down + copy, under an AI answer — GHL shows these without a
// card around them, so they read as acting on the text above rather than as
// controls on a separate panel. Shared by the portfolio Co-Pilot tab and
// Deal Hub's per-deal Co-Pilot: rating is per-run (POST /api/ai/runs/:runId/
// rating), identical either way regardless of which backend produced runId.
//
//   * up/down    a run with no runId (a failed turn, or an answer path that
//                never logs one) degrades to disabled rather than silently
//                eating the click.
//   * copy       clipboard only, no server round trip needed for it.
export default function ReactionRow({ runId, answerText }) {
  const [rated, setRated] = useState(null)   // 'up' | 'down' | null
  const [copied, setCopied] = useState(false)
  const [savingRating, setSavingRating] = useState(false)
  // Thumbs-down does not save on click — it asks why first, matching GHL's
  // own Ask AI (handleFeedback in ChatView.vue). Clicking thumbs-down again
  // to CLEAR an existing down-rating is the one case that saves immediately
  // with no modal, same as GHL: there is nothing left to explain about an
  // opinion being withdrawn.
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false)

  const save = async (value, { reasons = [], reason = null } = {}) => {
    if (!runId || savingRating) return
    setRated(value)
    setSavingRating(true)
    try {
      if (value) await aiAPI.rateRun(runId, { rating: value, reasons, reason })
      // Clearing a rating has no "un-rate" endpoint — the row underneath is
      // upserted by run_id, so the last non-null rating a rep sent is what
      // persists. Good enough: nothing currently reads "no opinion" as a
      // distinct signal from "never asked".
    } catch {
      // A failed rating is not worth interrupting the rep over — the answer
      // is still fully usable without it having saved.
      setRated(rated)
    } finally {
      setSavingRating(false)
    }
  }

  const clickUp = () => {
    if (!runId || savingRating) return
    save(rated === 'up' ? null : 'up')
  }

  const clickDown = () => {
    if (!runId || savingRating) return
    if (rated === 'down') { save(null); return }
    setFeedbackModalOpen(true)
  }

  const submitFeedback = ({ reasons, comment }) => {
    setFeedbackModalOpen(false)
    save('down', { reasons, reason: comment || null })
  }

  const copy = async () => {
    if (!answerText) return
    try {
      await navigator.clipboard.writeText(answerText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be denied (permissions, non-HTTPS, an iframe
      // without the clipboard-write policy — this tab runs inside one).
      // Failing quietly is right here: there is nothing actionable to tell a
      // rep beyond "try selecting the text yourself".
    }
  }

  const btnStyle = (active) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, border: 'none', borderRadius: 'var(--radius-sm)',
    background: active ? 'var(--tint-pine)' : 'transparent',
    color: active ? 'var(--accent-pine-text)' : 'var(--text-faint)',
    cursor: runId || false ? 'pointer' : 'default'
  })

  return (
    <>
      <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
        {/* Labels match GHL's own Ask AI (MessageBubble.vue) verbatim —
            "Helpful" / "Not helpful" / "Copy assistant message", the copy
            one swapping to "Copied!" once clicked.
            Mutually exclusive by REMOVAL, not just recolouring — matching
            MessageBubble.vue's v-if="feedback !== THUMBS_DOWN" / v-if=
            "feedback !== THUMBS_UP". Greying out the other button still
            leaves it clickable; a rep could rate an answer both helpful
            and not helpful at once. Once rated, only the chosen thumb (now
            clickable again to clear it) stays on screen. */}
        {rated !== 'down' && (
          <HoverTooltip label={runId ? 'Helpful' : null}>
            <button
              disabled={!runId}
              onClick={clickUp}
              style={btnStyle(rated === 'up')}
            >
              <span className="ms" style={{ fontSize: 17 }}>thumb_up</span>
            </button>
          </HoverTooltip>
        )}
        {rated !== 'up' && (
          <HoverTooltip label={runId ? 'Not helpful' : null}>
            <button
              disabled={!runId}
              onClick={clickDown}
              style={btnStyle(rated === 'down')}
            >
              <span className="ms" style={{ fontSize: 17 }}>thumb_down</span>
            </button>
          </HoverTooltip>
        )}
        <HoverTooltip label={copied ? 'Copied!' : 'Copy assistant message'}>
          <button
            onClick={copy}
            style={btnStyle(copied)}
          >
            <span className="ms" style={{ fontSize: 17 }}>
              {copied ? 'check' : 'content_copy'}
            </span>
          </button>
        </HoverTooltip>
      </div>

      {feedbackModalOpen && (
        <NegativeFeedbackModal
          busy={savingRating}
          onCancel={() => setFeedbackModalOpen(false)}
          onSubmit={submitFeedback}
        />
      )}
    </>
  )
}
