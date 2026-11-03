import React, { useState } from 'react'
import { attachmentIcon } from './AttachmentChip'

// A message's attachments drawn by TYPE, the way GHL's inbox draws them:
//
//   image     a square thumbnail, the picture itself, download on hover
//   video     the same square with a play button over the first frame
//   audio     a player, full width
//   document  a square with the file's icon in the middle and its name along
//             the bottom; PDF opens a preview, anything else downloads
//
// It replaced one grey chip reading "attachment" for everything. The chip
// was honest about what we knew — GHL's media URLs often carry no name and
// no type — but a photo a customer sent is the content of that message, and
// a chip hid it behind a click.
//
// TYPE FROM WHAT THERE IS. The content type when the payload had one, else
// the extension on the name or URL. A URL with neither (GHL's storage URLs
// end in "attachment") is tried as an IMAGE first — a photo is by far the
// commonest attachment on SMS and WhatsApp — and falls back to a document
// tile the moment the browser cannot decode it. No request is made beyond
// the one the tile needs anyway.

const IMG = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'heic', 'svg']
const VID = ['mp4', 'mov', 'webm', 'm4v', 'mpeg', 'mpg', '3gp']
const AUD = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'oga', 'opus', 'amr']

export function attachmentKind(att) {
  const ct = String(att?.contentType || '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct === 'application/pdf') return 'pdf'
  const src = String(att?.name || '') + ' ' + String(att?.url || '').split('?')[0]
  const ext = (String(att?.name || att?.url || '').split('?')[0].split('.').pop() || '').toLowerCase()
  if (IMG.includes(ext)) return 'image'
  if (VID.includes(ext)) return 'video'
  if (AUD.includes(ext)) return 'audio'
  if (ext === 'pdf' || /\.pdf\b/i.test(src)) return 'pdf'
  // A name with a real extension is a document; a bare URL is unknown.
  if (ext && ext.length <= 5 && !/^(attachment|media)$/i.test(ext) && !/\//.test(ext)) return 'document'
  return 'unknown'
}

const TILE = 168

const tileBase = {
  position: 'relative', width: TILE, height: TILE, flex: 'none',
  borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
  border: '1px solid var(--border-default)', background: 'var(--gray-100)'
}

function DownloadButton({ att }) {
  return (
    <a
      className="pp-att-dl"
      href={att.url}
      download={att.name || true}
      target="_blank"
      rel="noopener noreferrer"
      title="Download"
      aria-label="Download"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', top: 8, right: 8, zIndex: 2,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(255,255,255,0.92)', color: 'var(--gray-600)',
        boxShadow: '0 1px 4px rgba(16,24,40,0.18)', textDecoration: 'none'
      }}
    >
      <span className="ms" style={{ fontSize: 16 }}>download</span>
    </a>
  )
}

function displayName(att) {
  const n = String(att?.name || '')
  if (!n || /^(attachment|media)$/i.test(n)) return ''
  try { return decodeURIComponent(n) } catch { return n }
}

function Tile({ att, onOpen }) {
  const [kind, setKind] = useState(() => attachmentKind(att))
  const name = displayName(att)

  if (kind === 'audio') {
    return (
      <div className="pp-att-tile" style={{
        position: 'relative', flex: '1 1 280px', maxWidth: 420, minWidth: 220,
        padding: '8px 10px', borderRadius: 12,
        border: '1px solid var(--border-default)', background: 'var(--gray-100)'
      }}>
        <audio controls preload="metadata" src={att.url} style={{ width: '100%', display: 'block' }} />
        {name && (
          <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </div>
        )}
      </div>
    )
  }

  if (kind === 'image' || kind === 'unknown') {
    return (
      <div className="pp-att-tile" style={tileBase} onClick={onOpen} title={name || 'Image'}>
        <img
          src={att.url}
          alt={name || 'Image attachment'}
          className="pp-att-thumb"
          // Not an image after all (or the link has expired): draw it as a
          // document tile instead of a broken-image glyph.
          onError={() => setKind(kind === 'unknown' ? 'document' : 'broken')}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <DownloadButton att={att} />
      </div>
    )
  }

  if (kind === 'video') {
    return (
      <div className="pp-att-tile" style={{ ...tileBase, background: '#EAECF0' }} onClick={onOpen} title={name || 'Video'}>
        <video src={att.url} preload="metadata" muted playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.40)'
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 44, height: 44, borderRadius: '50%', background: '#fff',
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)', color: 'var(--gray-700)'
          }}>
            <span className="ms" style={{ fontSize: 24, marginLeft: 2 }}>play_arrow</span>
          </span>
        </div>
        <DownloadButton att={att} />
      </div>
    )
  }

  // document / pdf / broken
  const isPdf = kind === 'pdf'
  const broken = kind === 'broken'
  const open = () => {
    if (isPdf) return onOpen()
    // Other documents download — GHL does the same; the browser has no
    // in-page viewer for a .docx.
    window.open(att.url, '_blank', 'noopener')
  }
  return (
    <div className="pp-att-tile" style={{ ...tileBase, background: broken ? 'var(--gray-50)' : '#98A2B3' }}
      onClick={open} title={name || (isPdf ? 'PDF' : 'Document')}>
      <div style={{
        position: 'absolute', inset: 0,
        background: broken ? 'none' : 'linear-gradient(rgba(102,112,133,0) 0%, rgba(102,112,133,0.7) 70%)'
      }} />
      <span className="ms" style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        fontSize: 40, color: broken ? 'var(--gray-400)' : '#fff', pointerEvents: 'none'
      }}>
        {broken ? 'broken_image' : isPdf ? 'picture_as_pdf' : attachmentIcon(att.name)}
      </span>
      <div style={{
        position: 'absolute', left: 8, right: 8, bottom: 8,
        display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 'var(--text-xs)', fontWeight: 500,
        color: broken ? 'var(--text-muted)' : '#fff'
      }}>
        <span className="ms" style={{ fontSize: 13, flex: 'none' }}>{isPdf ? 'picture_as_pdf' : 'description'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {broken ? 'Could not load' : (name || (isPdf ? 'PDF' : 'File'))}
        </span>
      </div>
      {!broken && <DownloadButton att={att} />}
    </div>
  )
}

export default function MessageAttachments({ attachments = [], onOpen }) {
  if (!attachments.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
      {attachments.map((att, i) => (
        <Tile key={`${att.url || att.name}-${i}`} att={att} onOpen={() => onOpen?.(attachments, i)} />
      ))}
    </div>
  )
}
