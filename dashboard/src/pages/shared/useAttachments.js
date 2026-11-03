import { useRef, useState } from 'react'

// Attached images — a question aid, not evidence. They help the model
// understand what is being asked; every claim still needs a message quote.
// Extracted from AskDeal.jsx so the portfolio-wide Co-Pilot tab can offer
// the same attach/paste/drop behaviour without a second, drifting copy.
//
// Mirrors the server's limits in server/src/routes/ai.js — validated there
// too, since a client check is a courtesy and not a guarantee.
export const MAX_ATTACHMENTS = 3
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// Total across all attachments — must match MAX_TOTAL_BYTES server-side.
// Enforced here so an oversized set is refused before it's read and
// uploaded, rather than after a 5MB round trip.
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export function mbLabel(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function useAttachments({ onError }) {
  const [attachments, setAttachments] = useState([])
  const [preview, setPreview] = useState(null)
  const fileRef = useRef(null)
  // Monotonic id source — see the note where attachments are built.
  const attachSeq = useRef(0)

  const addFiles = async (fileList) => {
    const picked = Array.from(fileList || [])
    if (!picked.length) return
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      onError?.(`At most ${MAX_ATTACHMENTS} images per question.`)
      return
    }

    // Counts what's already attached, so the running total spans both the
    // existing attachments and the ones being added now.
    let runningTotal = attachments.reduce((n, a) => n + (a.bytes || 0), 0)

    const next = []
    for (const file of picked.slice(0, room)) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        onError?.('Images only — JPEG, PNG, GIF or WebP.')
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        onError?.(`${file.name} is ${mbLabel(file.size)} — images must be under 5 MB.`)
        continue
      }
      // Refuse before reading: three 4MB images each pass the per-image
      // check but together exceed what one request can carry.
      if (runningTotal + file.size > MAX_TOTAL_BYTES) {
        onError?.(`${file.name} would take the attachments over 5 MB in total. Remove one first.`)
        continue
      }
      runningTotal += file.size
      // Strip the data: prefix — the API wants bare base64, and leaving it
      // on is the mistake the server rejects with a 400.
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(file)
      })
      next.push({
        // Pasted screenshots all arrive as "image.png" with the same size,
        // so name+size+index collides across separate paste actions — two
        // pastes would produce duplicate React keys and the remove button
        // would delete the wrong thumbnail. attachSeq is monotonic per
        // session.
        id: `att-${attachSeq.current++}`,
        // A clipboard image has no meaningful filename. "Pasted image" is
        // honest; "image.png" three times over is not.
        name: file.name && file.name !== 'image.png' ? file.name : 'Pasted image',
        bytes: file.size,
        mediaType: file.type,
        previewUrl: dataUrl,
        data: dataUrl.split(',')[1] || ''
      })
    }
    if (next.length) setAttachments((prev) => [...prev, ...next])
  }

  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((x) => x.id !== id))
    // Close the preview if it's showing the one being removed — otherwise
    // the modal keeps displaying an attachment that no longer exists.
    setPreview((cur) => (cur?.id === id ? null : cur))
  }

  const clear = () => setAttachments([])

  // Paste an image straight into the box — screenshot, then Cmd+V. Clipboard
  // items expose .getAsFile(), which yields a real File, so this reuses
  // addFiles rather than duplicating the read, validation and base64 path.
  // Returns true if it handled (and should preventDefault) the paste.
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    if (!files.length) return false   // plain text — let it paste normally
    // Copying from Word or a browser puts BOTH text and an image on the
    // clipboard. Attach the image and let the text paste too, rather than
    // silently dropping half of what was copied.
    const hasText = !!e.clipboardData?.getData('text/plain')
    if (!hasText) e.preventDefault()
    addFiles(files)
    return true
  }

  return {
    attachments, addFiles, removeAttachment, clear,
    preview, setPreview,
    fileRef, onPaste
  }
}
