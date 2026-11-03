import React, { useEffect, useMemo, useState } from 'react'
import PanelHead from './PanelHead'
import { useModal } from '../../hooks/useModal'
import { RichBody, Truncate } from '../shared/ListChrome'
import AttachmentViewer from './AttachmentViewer'

// Media — every file attached to a message on this deal.
//
// No new endpoint: the timeline already carries `attachments` on each message
// (extractAttachments in routes/deals.js pulls them out of raw_message), so
// this is a different view of data the page has already fetched. That's why it
// ships now rather than being a permanently disabled tab.
//
// GHL is inconsistent about attachments — email carries `attachments` with
// filenames, SMS and WhatsApp carry `mediaUrls` with no filename at all — so a
// missing name is normal and gets a channel-derived label rather than a blank.

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']

export default function MediaSection({ messages = [], onJumpToMessage }) {
  const [kind, setKind] = useState('all')
  // The file being previewed, or null. AttachmentViewer is the same one the
  // timeline and the email thread use — one preview surface, so an image
  // opened from here behaves exactly as it does there.
  const [viewing, setViewing] = useState(null)
  // The file whose MESSAGE is being read, or null. Separate from `viewing`:
  // one is "show me the file", the other "show me what was said around it",
  // and a file can be previewed from inside the context dialog.
  const [context, setContext] = useState(null)

  // Flattened from the messages already in memory, newest first, keeping the
  // message each file came from so a click can jump back to its context.
  const files = useMemo(() => {
    const out = []
    for (const m of messages) {
      for (const att of m.attachments || []) {
        out.push({
          ...att,
          messageId: m.id,
          channel: m.channel,
          channelAccent: m.channelAccent,
          sender: m.senderName,
          ts: m.ts,
          isImage: IMAGE_EXT.includes(extOf(att.name)),
          // THE WHOLE MESSAGE, so the context dialog can show what was said
          // around the file. Carried rather than looked up by id: the message
          // is already in memory, and a lookup would go stale the moment the
          // timeline refetched.
          message: m
        })
      }
    }
    return out
  }, [messages])

  const shown = kind === 'all'
    ? files
    : files.filter((f) => (kind === 'images' ? f.isImage : !f.isImage))

  const imageCount = files.filter((f) => f.isImage).length

  // Only files with a URL can be previewed. SMS media always has one; an
  // email attachment synced before the fetch existed may not, and handing
  // the viewer a urlless entry would open a blank frame.
  const withUrls = useMemo(() => shown.filter((f) => f.url), [shown])

  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: 'var(--accent-plum-text)',
        ['--panel-tint']: 'var(--tint-plum)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden'
      }}
    >
      <PanelHead
        icon="folder_open"
        title="Media"
        accent="plum"
        subtitle={files.length === 0
          ? 'No files'
          : `${files.length} ${files.length === 1 ? 'file' : 'files'}`}
      />

      {files.length === 0 ? (
        <p
          style={{
            margin: 0, padding: 'var(--space-5)',
            textAlign: 'center',
            fontSize: 'var(--text-md)', color: 'var(--text-muted)'
          }}
        >
          Nothing attached to this deal yet. Files sent or received on any
          channel appear here.
        </p>
      ) : (
        <>
          {/* Only offer the filter when there's a mix — two chips where every
              file is an image is a control that can't do anything. */}
          {imageCount > 0 && imageCount < files.length && (
            <div
              style={{
                display: 'flex', gap: 'var(--space-2)',
                padding: '10px var(--space-4)',
                borderBottom: '1px solid var(--border-default)'
              }}
            >
              {[
                ['all', 'All', files.length],
                ['images', 'Images', imageCount],
                ['docs', 'Documents', files.length - imageCount]
              ].map(([id, label, n]) => (
                <button
                  key={id}
                  onClick={() => setKind(id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    cursor: 'pointer',
                    height: 30, padding: '0 12px',
                    border: kind === id
                      ? '1px solid var(--brand-primary)'
                      : '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius-pill)',
                    background: kind === id ? 'var(--brand-primary)' : '#fff',
                    color: kind === id ? '#fff' : 'var(--text-body)',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--text-base)', fontWeight: kind === id ? 600 : 400
                  }}
                >
                  {label}
                  <span style={{ opacity: 0.75 }}>{n}</span>
                </button>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
              gap: 'var(--space-3)',
              padding: 'var(--space-4)'
            }}
          >
            {shown.map((f, i) => (
              <FileCard
                key={`${f.messageId}-${f.name}-${i}`}
                file={f}
                // The whole SHOWN list, so the viewer's arrows page through
                // what the reader is currently looking at — paging into files
                // a filter has hidden would be a surprise.
                onOpen={() => setViewing({ attachments: withUrls, index: withUrls.indexOf(f) })}
                // The icon now OPENS THE MESSAGE rather than navigating to
                // it. Jumping closes the Media tab and loses your place in
                // the grid; when the question is "what was said around this
                // file?", answering it in place is better. The jump is still
                // offered from inside the dialog.
                onJump={() => setContext(f)}
              />
            ))}
          </div>
        </>
      )}
      {context && (
        <MessageContextDialog
          file={context}
          onClose={() => setContext(null)}
          onJump={
            onJumpToMessage
              ? () => { onJumpToMessage(context.messageId); setContext(null) }
              : undefined
          }
        />
      )}

      {viewing && viewing.attachments.length > 0 && (
        <AttachmentViewer
          attachments={viewing.attachments}
          index={Math.max(0, viewing.index)}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  )
}

function FileCard({ file, onOpen, onJump }) {
  const accent = `var(--accent-${file.channelAccent || 'gray'})`
  // An image that failed to load falls back to its icon. GHL's attachment
  // URLs are signed and expire, so a broken thumbnail is a normal state, not
  // an exception — and a broken-image glyph looks like our bug.
  const [broken, setBroken] = useState(false)
  const showThumb = file.isImage && file.url && !broken

  return (
    <button
      onClick={onOpen}
      title={`${file.name || 'File'} — click to preview`}
      style={{
        display: 'grid', gap: 'var(--space-2)',
        textAlign: 'left', cursor: 'pointer',
        padding: 'var(--space-3)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        fontFamily: 'var(--font-sans)'
      }}
    >
      <span
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
          height: 76,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--gray-50)', color: accent,
          overflow: 'hidden'
        }}
      >
        {/* A REAL THUMBNAIL for images. Every tile showed the same generic
            glyph, so a grid of photos was indistinguishable — the one thing a
            rep is scanning for is which picture it is.
            cover, not contain: at 76px a letterboxed photo is mostly grey,
            and recognising it needs the detail rather than the whole frame. */}
        {showThumb ? (
          <img
            src={file.url}
            alt={file.name || 'attachment'}
            onError={() => setBroken(true)}
            loading="lazy"
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              objectFit: 'cover'
            }}
          />
        ) : (
          <span className="ms" style={{ fontSize: 30 }}>{iconFor(file)}</span>
        )}
      </span>

      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <Truncate style={{ fontSize: 'var(--text-md)', fontWeight: 600,
            color: 'var(--text-heading)' }}>
          {/* SMS and WhatsApp media arrive with no filename. A channel-derived
              label beats an empty line. */}
          {file.name || `${file.channel || 'File'} attachment`}
        </Truncate>
        <span
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 'var(--text-sm)', color: 'var(--text-faint)'
          }}
        >
          <Truncate style={{ flex: 1 }}>
            {[file.sender, formatSize(file.sizeBytes)].filter(Boolean).join(' · ')}
          </Truncate>
          {/* Reads the message the file arrived in. Secondary to the tile
              itself, which previews the file — this answers the other
              question, "what was said around it?".
              A span with role=button, not a real one: the tile is already a
              button and nesting is invalid HTML — the inner click would fire
              both. */}
          {onJump && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onJump() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onJump() }
              }}
              title="Read the message this came in"
              className="pp-media-jump"
            >
              <span className="ms" style={{ fontSize: 14 }}>forum</span>
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

function extOf(name) {
  return String(name || '').split('.').pop().toLowerCase()
}

function iconFor(file) {
  if (file.isImage) return 'image'
  const ext = extOf(file.name)
  if (ext === 'pdf') return 'picture_as_pdf'
  if (ext === 'dwg' || ext === 'dxf') return 'architecture'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'table_chart'
  if (['doc', 'docx'].includes(ext)) return 'description'
  if (['zip', 'rar', '7z'].includes(ext)) return 'folder_zip'
  return 'attach_file'
}

function formatSize(bytes) {
  if (!bytes) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// The message a file arrived in, as a dialog.
//
// The tile's second control used to JUMP to the timeline — which works, but
// closes the Media tab and loses your place in the grid. When the question is
// "what was said around this file?", showing it in place answers it without
// making you navigate away and back.
//
// Read-only. Replying or editing belongs in the timeline, and a composer here
// would be a second place to write from with none of that surface's context.
function MessageContextDialog({ file, onClose, onJump }) {
  const modalRef = useModal()
  const m = file.message || {}
  const inbound = m.direction === 'inbound'

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Email bodies are HTML — the server's cleanEmail strips the head and inline
  // styles but keeps the tags — so they go through RichBody, which sanitises.
  // Everything else is plain text and keeps its line breaks.
  const isEmail = m.channel === 'EMAIL'
  const hasBody = m.body && String(m.body).trim() !== ''

  return (
    <div
      className="pp-backdrop"
      // Below AttachmentViewer's 65: a file can be previewed FROM here, so
      // that has to sit over this.
      style={{ zIndex: 62 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={modalRef}
        className="pp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Message from ${m.senderName || 'unknown'}`}
        style={{ width: 'min(620px, 100%)', display: 'flex', flexDirection: 'column' }}
      >
        <header
          className="pp-modal-head"
          style={{
            display: 'flex', alignItems: 'center', gap: 9,
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <span
            className="ms"
            title={inbound ? 'Received from the customer' : 'Sent by us'}
            style={{
              flex: 'none', fontSize: 17,
              color: inbound ? 'var(--accent-pine-text)' : 'var(--text-faint)'
            }}
          >
            {inbound ? 'south_west' : 'north_east'}
          </span>
          <h2 className="pp-modal-title" style={{ flex: 1, minWidth: 0 }}>
            <Truncate style={{ display: 'block' }}>
              {m.senderName || 'Unknown sender'}
            </Truncate>
          </h2>
          <span className="pp-mc-meta">
            {[m.channelLabel || m.channel, formatWhen(m.ts)].filter(Boolean).join(' · ')}
          </span>
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

        <div className="pp-modal-body" style={{ padding: 'var(--space-4)', overflowY: 'auto', maxHeight: '56vh' }}>
          {m.subject && <div className="pp-mc-subject">{m.subject}</div>}

          {hasBody ? (
            isEmail ? (
              <RichBody
                html={m.body}
                color="var(--text-body)"
                size="var(--text-md)"
                leading="var(--leading-normal)"
                maxWidth={560}
              />
            ) : (
              <p className="pp-mc-text">{m.body}</p>
            )
          ) : (
            // A message sent with only an attachment has no body. Saying so
            // beats an empty dialog that reads as a loading failure.
            <p className="pp-mc-empty">
              This message has no text — it was sent with the attachment only.
            </p>
          )}

          {/* Which file brought you here, named. On a message with four
              attachments the dialog otherwise gives no clue. */}
          <div className="pp-mc-file">
            <span className="ms" style={{ fontSize: 15, color: 'var(--text-faint)' }}>
              {iconFor(file)}
            </span>
            <span className="pp-mc-filename">
              {file.name || `${file.channel || 'File'} attachment`}
            </span>
            {formatSize(file.sizeBytes) && (
              <span className="pp-mc-size">{formatSize(file.sizeBytes)}</span>
            )}
          </div>
        </div>

        <footer
          className="pp-modal-foot"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px var(--space-4)',
            borderTop: '1px solid var(--border-default)',
            background: 'var(--gray-25)'
          }}
        >
          <span style={{ flex: 1 }} />
          {/* Jumping is still offered — it is the full thread, with everything
              before and after. It is just no longer the only option. */}
          {onJump && (
            <button type="button" onClick={onJump} className="pp-mc-btn">
              <span className="ms" style={{ fontSize: 15 }}>forum</span>
              Show in the timeline
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

// "9 Aug 2026, 18:21". The grid already groups by nothing, so a file's date
// has to be self-contained — unlike the timeline, which has day headers.
function formatWhen(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString([], {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}
