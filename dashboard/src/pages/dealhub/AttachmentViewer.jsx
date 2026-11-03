import React, { useEffect, useState } from 'react'
import { useModal } from '../../hooks/useModal'
import { attachmentIcon, formatBytes } from './AttachmentChip'
import { Truncate } from '../shared/ListChrome'

// One attachment, previewed in a dialog.
//
// WHY A DIALOG RATHER THAN A NEW TAB. Clicking a chip used to do nothing at
// all — `onJumpAttachment` was threaded through MessageRow and EmailBody but
// never actually passed by DealHubTab, so every attachment in the timeline was
// a dead click. Sending them all to a new tab would work, but a rep checking
// "did the right quote go out" loses the deal they were reading; the answer is
// a glance, not a context switch.
//
// WHAT CAN BE PREVIEWED, and what cannot:
//
//   images  <img>. Reliable — the browser either decodes it or fires onError.
//   pdf     <iframe>. Chrome and Safari render these natively.
//   other   a file card. dwg, xlsx, zip have no in-browser renderer, and an
//           iframe pointed at one either downloads it or shows a blank box.
//
// EVERY PREVIEW CAN STILL FAIL, whatever the type says. GHL's attachment URLs
// are signed and can expire, the file may be gone, or the host may refuse
// framing. So both preview paths fall back to the same card the unpreviewable
// types get, and "Open in new tab" is always available — the file might load
// in a top-level context even when it refuses to be framed.

// Extension-based, deliberately. The email endpoint returns bare URL strings
// with no MIME type — `attachments: string[]` — so the extension is all there
// is. A URL with no extension falls through to the card, which is the right
// default: better a card for a previewable file than a blank frame.
function kindOf(att) {
  const name = String(att?.name || att?.url || '')
  const ext = (name.split('?')[0].split('.').pop() || '').toLowerCase()
  const ct = String(att?.contentType || '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct === 'application/pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'webm', 'm4v', 'mpeg', 'mpg', '3gp'].includes(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  // No extension at all — GHL's storage URLs end in "attachment". The tile
  // that opened this already showed it as a picture, so try it as one here
  // too; a decode failure still lands on the card.
  if (!ext || ext === 'attachment' || ext.includes('/')) return 'image'
  return 'file'
}

export default function AttachmentViewer({
  attachments = [],
  // Which one was clicked. Index rather than the object so the arrows have
  // somewhere to move to.
  index = 0,
  onClose
}) {
  const modalRef = useModal()
  const [i, setI] = useState(index)
  // Reset when the preview fails OR when we move to a different file — a
  // failure on file 2 must not blank file 3.
  const [failed, setFailed] = useState(false)

  const att = attachments[i]
  const many = attachments.length > 1

  const go = (delta) => {
    setFailed(false)
    setI((prev) => (prev + delta + attachments.length) % attachments.length)
  }

  // Escape closes; arrows move between files. Bound here rather than in
  // useModal, which deliberately does no key handling — see that hook.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (!many) return
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, many, attachments.length])

  if (!att) return null

  const kind = failed ? 'file' : kindOf(att)
  const size = formatBytes(att.sizeBytes)

  return (
    <div
      className="pp-backdrop"
      // Above the thread dialog (60): this opens FROM it, so it has to sit
      // over it. Still below ConfirmDialog's 70, which can be raised from
      // anywhere.
      style={{ zIndex: 65 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={modalRef}
        className="pp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={att.name}
        // Wider and taller than the thread dialog: a PDF page at a readable
        // size is the whole point of previewing it here.
        style={{ width: 'min(900px, 100%)', display: 'flex', flexDirection: 'column' }}
      >
        <header
          className="pp-modal-head"
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <span className="ms" style={{ fontSize: 20, color: 'var(--text-faint)', flex: 'none' }}>
            {attachmentIcon(att.name)}
          </span>
          <h2 className="pp-modal-title" style={{ flex: 1, minWidth: 0 }}>
            <Truncate style={{ display: 'block' }}>
              {att.name}
            </Truncate>
          </h2>
          {/* Only when known. The email endpoint gives URLs with no size, so
              this is absent for most email attachments — rendering an empty
              element there left a gap that read as a bug. */}
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

        <div className="pp-att-stage">
          {kind === 'image' && (
            <img
              src={att.url}
              alt={att.name}
              className="pp-att-img"
              // The fallback path. An expired signed URL, a deleted file and a
              // wrong extension all land here.
              onError={() => setFailed(true)}
            />
          )}

          {kind === 'video' && (
            <video
              src={att.url}
              className="pp-att-img"
              controls
              autoPlay
              playsInline
              onError={() => setFailed(true)}
            />
          )}

          {kind === 'pdf' && (
            <iframe
              src={att.url}
              title={att.name}
              className="pp-att-frame"
              // No allow-scripts: this is someone else's document, rendered
              // inside our dashboard's origin. It needs no script access to
              // display, and granting it would let a crafted PDF run code
              // against the frame.
              sandbox=""
              onError={() => setFailed(true)}
            />
          )}

          {kind === 'file' && (
            <div className="pp-att-none">
              <span className="ms pp-att-none-icon">{attachmentIcon(att.name)}</span>
              <span className="pp-att-none-name">{att.name}</span>
              <span className="pp-att-none-msg">
                {failed
                  // Said plainly, because the two causes need different
                  // actions: a rep can retry an expired link from GHL, but
                  // not a deleted file.
                  ? 'This file could not be displayed. The link may have expired.'
                  : 'No preview available for this file type.'}
              </span>
              {att.url && (
                <a
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pp-att-open"
                >
                  <span className="ms" style={{ fontSize: 16 }}>open_in_new</span>
                  Open in a new tab
                </a>
              )}
            </div>
          )}
        </div>

        <footer
          className="pp-modal-foot"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px var(--space-4)',
            borderTop: '1px solid var(--border-default)',
            background: 'var(--gray-25)'
          }}
        >
          {/* Only when there is more than one — arrows on a single file are a
              control that does nothing. */}
          {many && (
            <>
              <button type="button" className="pp-att-nav" onClick={() => go(-1)} title="Previous (←)">
                <span className="ms" style={{ fontSize: 18 }}>chevron_left</span>
              </button>
              <span
                style={{
                  fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {i + 1} of {attachments.length}
              </span>
              <button type="button" className="pp-att-nav" onClick={() => go(1)} title="Next (→)">
                <span className="ms" style={{ fontSize: 18 }}>chevron_right</span>
              </button>
            </>
          )}

          <span style={{ flex: 1 }} />

          {/* Always offered, even when the preview worked: the browser's own
              PDF viewer has print and download, and an image is easier to
              inspect full-size. */}
          {att.url && kind !== 'file' && (
            <a
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pp-att-open pp-att-open-sm"
            >
              <span className="ms" style={{ fontSize: 15 }}>open_in_new</span>
              Open in a new tab
            </a>
          )}
        </footer>
      </div>
    </div>
  )
}
