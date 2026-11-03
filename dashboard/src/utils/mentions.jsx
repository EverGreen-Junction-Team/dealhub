import React from 'react'

// @-mentions in internal comments, in GHL's own markup.
//
// GHL stores a mention inline as  @J srini<userId>h07KvFvGuKUVRExims8y</userId>
// — the display name, then the user id in a pseudo-tag. Its inbox draws
// "@J srini" and hides the tag; shown raw, the tag is exactly the kind of
// thing a rep reports as "garbage in the comment". These helpers split a
// comment into text and mentions for rendering, and build the same markup
// for comments written here, so a comment reads the same whichever side
// wrote it.
//
// A comment saved from our composer is HTML (one <p> per line, escaped), so
// the tag arrives as &lt;userId&gt;; both spellings are matched.

const MENTION = /@([^@<\n&]+?)(?:<userId>|&lt;userId&gt;)([A-Za-z0-9_-]+)(?:<\/userId>|&lt;\/userId&gt;)/g

export const mentionMarkup = (name, userId) => `@${name}<userId>${userId}</userId>`

/** [{ text }, { mention: { name, userId } }, …] in document order. */
export function splitMentions(text) {
  const out = []
  const s = String(text || '')
  let last = 0
  for (const m of s.matchAll(MENTION)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) })
    out.push({ mention: { name: m[1].trim(), userId: m[2] } })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last) })
  return out
}

/** The comment with mentions reduced to "@Name" — for previews and search. */
export const stripMentions = (text) => String(text || '').replace(MENTION, '@$1')

// A comment body that was saved as HTML (our composer's textToHtml) back to
// the text it was typed as: a line per <p>, a break per <br>, entities
// decoded. Comments are plain text by construction, so nothing is lost.
export function commentHtmlToText(html) {
  const s = String(html || '')
  if (!/[<&]/.test(s)) return s
  if (typeof window === 'undefined' || !window.DOMParser) return s.replace(/<[^>]+>/g, '')
  const doc = new window.DOMParser().parseFromString(`<body>${s}</body>`, 'text/html')
  const lines = []
  const blocks = doc.body.querySelectorAll('p, div, li')
  if (blocks.length) {
    for (const b of blocks) {
      lines.push(b.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    }
  } else {
    lines.push(doc.body.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
  }
  // Entities, once — the mention tag was escaped on the way in.
  const t = document.createElement('textarea')
  t.innerHTML = lines.join('\n')
  return t.value
}

/**
 * The comment as React nodes. A mention of the signed-in user is drawn in
 * the link blue, as GHL draws it ("this one is about you"); anyone else is
 * the heading colour, bold. Hover a mention for the full name.
 */
export function MentionText({ text, meId = null }) {
  const parts = splitMentions(text)
  return (
    <>
      {parts.map((p, i) => p.text !== undefined
        ? <React.Fragment key={i}>{p.text}</React.Fragment>
        : (
          <span
            key={i}
            className="pp-mention"
            data-me={meId && p.mention.userId === meId ? '1' : '0'}
            title={p.mention.name}
          >
            @{p.mention.name}
          </span>
        ))}
    </>
  )
}
