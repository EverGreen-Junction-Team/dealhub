import { useEffect } from 'react'

// Give every clipped line a tooltip — including the ones Truncate cannot see.
//
// ── WHY THIS EXISTS ALONGSIDE Truncate ───────────────────────────────
//
// Truncate handles elements IT renders. But a large part of the app ellipsises
// through CSS classes instead — .pp-cc-value on every contact-card field,
// .pp-email-subject, .pp-thread-name and five more. Those clip correctly and
// have no tooltip at all, so a long address or deal name is cut off with no
// way to read the rest. The rollout that converted inline-styled spans could
// not reach them: there was no inline style to match on.
//
// Converting each by hand would mean touching every call site and keeping two
// mechanisms in step forever. This is one pass over the document instead,
// using the same test Truncate uses.
//
// ── THE RULES ────────────────────────────────────────────────────────
//
// * Only when ACTUALLY clipped. scrollWidth > clientWidth, measured after
//   layout. A title on text you can already read is noise, and it suppresses
//   the browser's own tooltips elsewhere.
// * Never overwrite a title someone set deliberately — a cell showing
//   "3 days ago" may want the full date, which is not its own text.
// * Remove the title again when the text stops being clipped, or a widened
//   column keeps a tooltip that no longer tells you anything.
const SELECTOR = [
  '.pp-cc-value', '.pp-cf-filename', '.pp-cf-name',
  '.pp-email-preview', '.pp-email-subject',
  '.pp-mc-filename', '.pp-thread-name', '.pp-thread-prev'
].join(',')

// Marks a title this pass added, so a later pass can tell it from an
// author's own and remove only its own.
const OWNED = 'data-cliptitle'

export function applyClipTooltips(root = document) {
  let el
  try {
    el = root.querySelectorAll(SELECTOR)
  } catch {
    return
  }
  el.forEach((node) => {
    const clipped = node.scrollWidth > node.clientWidth + 1
    const mine = node.hasAttribute(OWNED)

    if (clipped) {
      // An author's own title wins and is left alone.
      if (node.title && !mine) return
      const text = (node.textContent || '').trim()
      if (!text) return
      if (node.title !== text) {
        node.title = text
        node.setAttribute(OWNED, '')
      }
    } else if (mine) {
      node.removeAttribute('title')
      node.removeAttribute(OWNED)
    }
  })
}

// Runs the pass on mount, on resize, and whenever the DOM changes.
export function useClipTooltips() {
  useEffect(() => {
    let queued = false
    const run = () => {
      if (queued) return
      queued = true
      // One frame later: the pass SETS attributes, and measuring in the same
      // tick as a render gives stale widths.
      requestAnimationFrame(() => {
        queued = false
        applyClipTooltips()
      })
    }

    run()
    window.addEventListener('resize', run)

    let mo = null
    if (typeof MutationObserver !== 'undefined') {
      // childList and characterData only. Observing attributes would make
      // this retrigger on its own title writes, forever.
      mo = new MutationObserver(run)
      mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    }

    return () => {
      window.removeEventListener('resize', run)
      if (mo) mo.disconnect()
    }
  }, [])
}
