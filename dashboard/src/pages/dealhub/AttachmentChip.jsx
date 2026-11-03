import React from 'react'
import { Truncate } from '../shared/ListChrome'

// One attachment, as a clickable chip. Shared by the timeline's message rows,
// the expanded email card, and the email thread dialog.
//
// EXTRACTED because the thread dialog needed it and the alternative was a
// second copy of the icon-by-extension mapping and the byte formatter. The
// note palette went the same way for the same reason: two copies of a display
// rule drift, and then the same file shows a PDF icon in one list and a
// generic one in another.

// 'gray' isn't in the token palette — map to the neutral border.
export function accentVar(accent) {
  return accent === 'gray' ? 'var(--gray-400)' : `var(--accent-${accent})`
}

export function formatBytes(n) {
  if (!n) return ''
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

// Icon by extension. Not exhaustive on purpose — the fallback is a document,
// which is right for anything unrecognised, and 'dwg' is here because this
// customer is a glazing firm and drawings are a normal attachment.
export function attachmentIcon(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'picture_as_pdf'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image'
  if (ext === 'dwg') return 'architecture'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'table'
  if (['doc', 'docx'].includes(ext)) return 'article'
  if (['zip', 'rar', '7z'].includes(ext)) return 'folder_zip'
  return 'description'
}

export default function AttachmentChip({ att, channelAccent = 'gray', onClick }) {
  const size = formatBytes(att.sizeBytes)
  return (
    <button
      type="button"
      onClick={onClick}
      // The size is not always known — GHL omits it on some paths — so the
      // tooltip carries the name alone rather than "name · " with a dangling
      // separator.
      title={size ? `${att.name} · ${size}` : att.name}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        // maxWidth so one long filename cannot stretch the row; the name
        // itself truncates below.
        maxWidth: '100%',
        padding: '5px 10px 5px 7px',
        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
        background: 'var(--gray-50)', cursor: 'pointer',
        fontFamily: 'var(--font-sans)', textAlign: 'left'
      }}
    >
      <span
        className="ms"
        style={{ fontSize: 16, flex: 'none', color: accentVar(channelAccent) }}
      >
        {attachmentIcon(att.name)}
      </span>
      <Truncate style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-heading)' }}>
        {att.name}
      </Truncate>
      {/* Only when known. An empty span left a stray gap between the name and
          the chip's right edge. */}
      {size && (
        <span
          style={{
            flex: 'none',
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
            color: 'var(--text-faint)'
          }}
        >
          {size}
        </span>
      )}
    </button>
  )
}
