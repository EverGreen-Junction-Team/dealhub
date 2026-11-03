import React, { useEffect, useMemo, useRef, useState } from 'react'
import { sanitiseHtml } from '../../utils/sanitiseHtml'

// An email body in its own sandboxed iframe, the way GHL's conversation view
// draws it.
//
// WHY AN IFRAME. Injected into the page, an email took on OUR styles — the
// app font, a 680px cap, our line height — and its own inline sizes and wide
// tables fought the card around it. In a frame the email keeps its own look
// and nothing leaks either way.
//
// STILL SANITISED. The frame is a second wall, not the first: the body goes
// through sanitiseHtml exactly as RichBody's does. The sandbox omits
// allow-scripts, so nothing in the email can run even if markup slipped
// through; allow-same-origin is only there so this component can read the
// content height (a sandbox without scripts cannot use it to do anything).
//
// SIZED TO ITS CONTENT — no inner scrollbar. The height is measured on load
// and again whenever the body resizes (images arriving, the card narrowing).
const FRAME_CSS = `
  html { overflow-y: hidden; overflow-x: auto; }
  body {
    margin: 0;
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.45; color: #1f2328;
    overflow-wrap: anywhere;
  }
  p { margin: 0 0 0.6em; }
  p:last-child { margin-bottom: 0; }
  img { max-width: 100%; height: auto; }
  a { color: #155eef; }
  table { border-collapse: collapse; max-width: 100%; }
  blockquote { margin: 0.4em 0; padding-left: 10px; border-left: 3px solid #d0d5dd; color: #475467; }
`

export default function EmailFrame({ html, title = 'Email message' }) {
  const ref = useRef(null)
  const [height, setHeight] = useState(0)

  const srcDoc = useMemo(() => (
    '<!doctype html><html><head><meta charset="utf-8">'
    // Links open in a new tab, never inside the frame.
    + '<base target="_blank">'
    + `<style>${FRAME_CSS}</style></head><body>`
    + sanitiseHtml(html || '')
    + '</body></html>'
  ), [html])

  useEffect(() => {
    const frame = ref.current
    if (!frame) return undefined
    let observer = null
    const measure = () => {
      const body = frame.contentDocument?.body
      if (!body) return
      // The body's own box, not the document's scrollHeight — that never
      // drops below the frame's current height, so a frame could only grow.
      // Plus the horizontal scrollbar's room when a wide table needs one.
      const doc = frame.contentDocument.documentElement
      const bar = doc.scrollWidth > doc.clientWidth ? 14 : 0
      setHeight(Math.ceil(body.getBoundingClientRect().height) + bar)
    }
    const onLoad = () => {
      measure()
      const body = frame.contentDocument?.body
      // Re-attached on every load: the early readyState check below can fire
      // for the blank document that precedes the srcdoc one.
      if (observer) { observer.disconnect(); observer = null }
      if (body && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure)
        observer.observe(body)
      }
    }
    frame.addEventListener('load', onLoad)
    // srcdoc can finish before the listener is attached.
    if (frame.contentDocument?.readyState === 'complete') onLoad()
    return () => {
      frame.removeEventListener('load', onLoad)
      if (observer) observer.disconnect()
    }
  }, [srcDoc])

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ display: 'block', width: '100%', height: height || 20, border: 0, background: 'transparent' }}
    />
  )
}
