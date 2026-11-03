import React from 'react'

// A rep's own question in the transcript — a filled brand-color bubble with
// an asymmetric tail corner, sized to its own text (not a fixed-width box).
// Shared by the portfolio Co-Pilot tab and Deal Hub's per-deal Co-Pilot so
// both read as the same product.
//
// `images` are what was actually attached and sent to the model — the turn
// used to carry only `content` (the text), so an attached screenshot reached
// Claude correctly but vanished from the rep's own transcript the moment it
// sent: nothing recorded that a question had had an image at all. Read-only
// thumbnails here (no remove button — that's the composer's own, editable
// AttachmentThumbnails, a different component for a different moment).
export default function UserTurn({ text, images = [], onViewImage }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {images.map((img, i) => (
            <button
              key={img.id || i}
              onClick={() => onViewImage?.(img)}
              aria-label={`View ${img.name || 'attached image'}`}
              style={{
                display: 'inline-flex', padding: 0, flex: 'none',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--gray-50)',
                cursor: onViewImage ? 'zoom-in' : 'default',
                overflow: 'hidden'
              }}
            >
              <img
                src={img.previewUrl}
                alt={img.name || 'Attached image'}
                style={{ display: 'block', width: 56, height: 56, objectFit: 'cover' }}
              />
            </button>
          ))}
        </div>
      )}
      {text && (
        <p style={{
          margin: 0, maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: '16px 16px 4px 16px',
          background: 'var(--brand-primary)', color: '#fff',
          fontSize: 'var(--text-md)', lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word'
        }}>
          {text}
        </p>
      )}
    </div>
  )
}
