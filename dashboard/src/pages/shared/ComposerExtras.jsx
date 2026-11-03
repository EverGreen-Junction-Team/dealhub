import React, { useEffect, useRef, useState } from 'react'
import { Truncate } from './ListChrome'

// Composer building blocks shared between AskDeal (the Deal Hub's own
// Co-Pilot) and CopilotTab (the portfolio-wide one): the voice-dictation
// recording bar, attachment thumbnails, the full-size image preview, and the
// small icon button both mic/attach controls use. Extracted rather than
// duplicated so a fix to any of these only has to happen once.

// The composer while dictating — WhatsApp's recording state, in our palette.
//
// A pulsing dot and a timer say it's live, the transcript appears as it's
// heard, and there are exactly two ways out: bin it or keep it. The bin
// matters — without it a mis-heard sentence has to be deleted by hand, which
// is worse than not offering dictation at all.
export function RecordingBar({ heard, elapsed, onCancel, onFinish }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        padding: '12px 14px',
        border: '2px solid var(--status-stuck)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--tint-rose)',
        boxShadow: '0 0 0 4px rgba(220, 38, 38, 0.10)'
      }}
    >
      <style>{RECORDING_CSS}</style>

      {/* Discard. Left, away from the send button, so the two are hard to
          confuse under a moving cursor. */}
      <button
        onClick={onCancel}
        aria-label="Discard this recording"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flex: 'none', width: 38, height: 38, padding: 0,
          border: 'none', borderRadius: 'var(--radius-sm)',
          background: 'transparent', color: 'var(--status-stuck)',
          cursor: 'pointer'
        }}
      >
        <span className="ms" style={{ fontSize: 22 }}>delete</span>
      </button>

      <span
        aria-hidden
        className="pp-rec-dot"
        style={{
          width: 10, height: 10, flex: 'none',
          borderRadius: '50%', background: 'var(--status-stuck)'
        }}
      />

      <span
        style={{
          flex: 'none',
          fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)',
          fontWeight: 600, color: 'var(--status-stuck)',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {formatElapsed(elapsed)}
      </span>

      {/* Waveform. Decorative — the Web Speech API gives no amplitude, so
          animating to real levels would need a parallel getUserMedia stream
          and an analyser node for no functional gain. It signals "listening",
          which is its whole job. */}
      <span aria-hidden style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 'none' }}>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span
            key={i}
            className="pp-rec-bar"
            style={{
              width: 3, borderRadius: 2,
              background: 'var(--status-stuck)',
              animationDelay: `${i * 0.09}s`
            }}
          />
        ))}
      </span>

      {/* What's been heard so far. Scrolls rather than growing the bar, so a
          long dictation doesn't push the buttons off-screen. */}
      <span
        style={{
          flex: 1, minWidth: 0, maxHeight: 46, overflowY: 'auto',
          fontSize: 'var(--text-md)', lineHeight: 'var(--leading-snug)',
          color: heard ? 'var(--text-heading)' : 'var(--text-muted)',
          fontStyle: heard ? 'normal' : 'italic'
        }}
      >
        {heard || 'Listening…'}
      </span>

      <button
        onClick={onFinish}
        aria-label="Stop recording and keep the text"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flex: 'none', width: 38, height: 38, padding: 0,
          border: 'none', borderRadius: 'var(--radius-pill)',
          background: 'var(--brand-primary)', color: '#fff',
          boxShadow: '0 2px 6px rgba(13, 91, 64, 0.32)',
          cursor: 'pointer'
        }}
      >
        <span className="ms" style={{ fontSize: 21 }}>check</span>
      </button>
    </div>
  )
}

const RECORDING_CSS = `
@keyframes pp-rec-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.35; transform: scale(0.82); }
}
@keyframes pp-rec-wave {
  0%, 100% { height: 7px; }
  50%      { height: 20px; }
}
.pp-rec-dot { animation: pp-rec-pulse 1.1s ease-in-out infinite; }
.pp-rec-bar { height: 7px; animation: pp-rec-wave 0.9s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .pp-rec-dot, .pp-rec-bar { animation: none; }
  .pp-rec-bar { height: 13px; }
}
`

// "0:07" / "1:24".
export function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Thumbnails, above the text — you see what's attached before you finish
// typing the question about it.
export function AttachmentThumbnails({ attachments, onView, onRemove }) {
  if (attachments.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      {attachments.map((a) => (
        <span
          key={a.id}
          style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onView(a) }}
            aria-label={`View ${a.name}`}
            style={{
              display: 'inline-flex', padding: 0,
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--gray-50)',
              cursor: 'zoom-in', overflow: 'hidden'
            }}
          >
            <img
              src={a.previewUrl}
              alt={a.name}
              // A blank square gives no clue whether the file failed to read
              // or the image just can't render. Swap in an icon so the
              // state is legible.
              onError={(e) => {
                e.currentTarget.style.display = 'none'
                const box = e.currentTarget.parentElement
                if (box) box.dataset.failed = 'true'
              }}
              style={{
                display: 'block',
                width: 56, height: 56, objectFit: 'cover'
              }}
            />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(a.id) }}
            aria-label={`Remove ${a.name}`}
            style={{
              position: 'absolute', top: -6, right: -6,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, padding: 0,
              border: 'none', borderRadius: '50%',
              background: 'var(--gray-800)', color: '#fff',
              cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>close</span>
          </button>
        </span>
      ))}
    </div>
  )
}

// Full-size view of an attached image. Rendered inline rather than as a
// portal — the app lives in a GHL iframe, so a fixed overlay is bounded by
// the iframe anyway and a portal buys nothing.
export function ImagePreview({ attachment, onClose }) {
  // Escape closes, and focus moves to the dialog so a keyboard user isn't
  // left tabbing through the composer behind it.
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
      ref={ref}
      tabIndex={-1}
      // Click the backdrop to dismiss. The check keeps a click INSIDE the
      // image from closing it — otherwise you couldn't select or
      // right-click the picture you opened.
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-5)',
        background: 'rgba(20, 25, 34, 0.72)',
        outline: 'none'
      }}
    >
      <div
        style={{
          display: 'grid', gap: 0,
          maxWidth: 'min(920px, 100%)', maxHeight: '100%',
          borderRadius: 'var(--radius-lg)',
          background: '#fff',
          boxShadow: 'var(--shadow-overlay)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <Truncate style={{ flex: 1,
              fontSize: 'var(--text-lg)', fontWeight: 600,
              color: 'var(--text-heading)' }}>
            {attachment.name}
          </Truncate>
          <span style={{ flex: 'none', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
            {formatBytes(attachment.bytes)}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flex: 'none', width: 32, height: 32, padding: 0,
              border: 'none', borderRadius: 'var(--radius-sm)',
              background: 'transparent', color: 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* The image scrolls inside its own box rather than growing the
            dialog past the viewport — a tall screenshot would otherwise
            push the header off-screen. */}
        <div style={{ overflow: 'auto', background: 'var(--gray-50)', minHeight: 0 }}>
          <img
            src={attachment.previewUrl}
            alt={attachment.name}
            style={{ display: 'block', maxWidth: '100%', margin: '0 auto' }}
          />
        </div>
      </div>
    </div>
  )
}

// Our own tooltip, not the browser's `title`. A native title renders as a
// dark OS-styled box that ignores the design and takes ~1s to appear — it
// read as a bug in the middle of the composer. Wraps any single child
// (typically one icon button) and shows `label` above it on hover/focus —
// used by IconButton below and by the plain reaction icons in
// CopilotTab.jsx's ReactionRow, which need this exact tooltip without
// IconButton's own background/active styling.
export function HoverTooltip({ label, children }) {
  const [hint, setHint] = useState(false)
  if (!label) return children

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}
      onMouseEnter={() => setHint(true)}
      onMouseLeave={() => setHint(false)}
      onFocus={() => setHint(true)}
      onBlur={() => setHint(false)}
    >
      {hint && (
        <span
          role="tooltip"
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 3, whiteSpace: 'nowrap', pointerEvents: 'none',
            padding: '5px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--gray-800)', color: '#fff',
            fontSize: 'var(--text-sm)', fontWeight: 500,
            boxShadow: 'var(--shadow-raised)'
          }}
        >
          {label}
        </span>
      )}
      {children}
    </span>
  )
}

export function IconButton({ icon, label, onClick, disabled, active, size = 38, iconSize = 21 }) {
  return (
    <HoverTooltip label={label}>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active ? true : undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, padding: 0,
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: active ? 'var(--status-stuck)' : 'transparent',
          color: active
            ? '#fff'
            : disabled ? 'var(--gray-400)' : 'var(--text-muted)',
          cursor: disabled ? 'not-allowed' : 'pointer'
        }}
        onMouseOver={(e) => {
          if (!disabled && !active) e.currentTarget.style.background = 'var(--gray-100)'
        }}
        onMouseOut={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent'
        }}
      >
        <span className="ms" style={{ fontSize: iconSize }}>{icon}</span>
      </button>
    </HoverTooltip>
  )
}
