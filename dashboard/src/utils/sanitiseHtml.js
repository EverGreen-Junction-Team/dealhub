// Allow-list sanitiser for note and task HTML.
//
// WHY THIS EXISTS, AND WHY IT IS NOT OPTIONAL.
//
// RichBody renders note bodies with dangerouslySetInnerHTML in six places
// (the notes tab, the tasks tab, the deal timeline, the deal rails). Nothing
// filtered that HTML — not the server (notePatch validates type and length
// only) and not the client. A note body is attacker-influenceable: it can be
// written through GHL by anyone with access to the sub-account, or arrive from
// an inbound integration. So a `<script>` or an `onerror=` attribute in a note
// would execute inside our dashboard, with the session's credentials.
//
// That was true before this file existed. Adding a rich editor makes it more
// pressing — we now WRITE html as well as read it — but the read path was
// already the hole.
//
// ALLOW-LIST, NOT DENY-LIST. A deny-list ("strip script tags") loses to the
// next encoding trick; there is a long history of that. This keeps only tags
// and attributes we can name a use for and drops everything else, so an
// unknown construct fails closed.
//
// USES THE BROWSER'S PARSER rather than regex. Regex cannot parse HTML — the
// classic bypasses are all malformed markup that a regex reads differently
// from the browser. DOMParser gives us exactly the tree the browser would
// build, and we walk that.
//
// NO DEPENDENCY. DOMPurify is the better answer for arbitrary untrusted HTML
// and would be the right call if this had to handle rich documents. Our
// surface is a note: a dozen inline tags and lists. That fits in a reviewable
// file, and this project runs on seven dependencies — worth keeping.

// Tags a note can legitimately contain. Everything else is unwrapped (its
// children are kept, the tag is dropped) rather than deleted, so stripping a
// <div> does not silently discard its text.
const ALLOWED = new Set([
  'P', 'BR', 'DIV', 'SPAN',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL',
  'UL', 'OL', 'LI',
  'A',
  'H1', 'H2', 'H3', 'H4',
  'BLOCKQUOTE', 'CODE', 'PRE',
  // Signature markup. Kept in step with the SERVER's list deliberately: the
  // two disagreeing is what shipped a bug where a rep built a coloured
  // signature, saved it, and the server quietly flattened it. Whatever one
  // side allows, the other must.
  'IMG',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH'
])

// Tags whose CONTENT is dangerous, not just their attributes. These are
// removed entirely — unwrapping a <script> would paste its source as text.
const DROP_CONTENT = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT',
  'SVG', 'MATH', 'TEMPLATE'
])

// Attributes worth keeping, per tag. Deliberately tiny.
const ATTRS = {
  A: new Set(['href', 'title']),
  // GHL's own editor emits inline styles (the payload showed
  // `style="margin: 0px; padding-left: 0px !important;"`), so `style` is kept
  // on block tags — but filtered, see safeStyle below.
  P: new Set(['style']),
  DIV: new Set(['style']),
  SPAN: new Set(['style']),
  LI: new Set(['style']),
  UL: new Set(['style']),
  OL: new Set(['style']),
  H1: new Set(['style']), H2: new Set(['style']),
  H3: new Set(['style']), H4: new Set(['style']),
  IMG: new Set(['src', 'alt', 'width', 'height', 'style']),
  TABLE: new Set(['style', 'cellpadding', 'cellspacing', 'border', 'width']),
  THEAD: new Set(['style']),
  TBODY: new Set(['style']),
  TR: new Set(['style']),
  TD: new Set(['style', 'colspan', 'rowspan', 'align', 'valign', 'width']),
  TH: new Set(['style', 'colspan', 'rowspan', 'align', 'valign', 'width'])
}

// CSS properties a note may set. An allow-list again: `style` is a vector on
// its own — `position:fixed` can cover the page, and `url()` in a background
// is a request to an attacker's server.
const CSS_PROPS = new Set([
  'color', 'background-color', 'font-weight', 'font-style',
  'text-decoration', 'text-align',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  // Signature typography and layout — see the server's matching list.
  'font-size', 'font-family', 'line-height',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-width', 'border-style',
  'border-collapse', 'border-spacing',
  'width', 'max-width', 'height', 'vertical-align', 'display'
])

function safeStyle(value) {
  const out = []
  for (const decl of String(value).split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const val = decl.slice(i + 1).trim()
    if (!CSS_PROPS.has(prop)) continue
    // display is allowed (block/inline-block lay a signature out) but none
    // is not — a whole signature saved invisible is a confusing thing to
    // allow by accident.
    if (prop === 'display' && /none/i.test(val)) continue
    // No url(), no expression(), no escapes that could reconstruct either.
    if (/url\s*\(|expression\s*\(|\\|@import/i.test(val)) continue
    out.push(`${prop}: ${val}`)
  }
  return out.join('; ')
}

// A link may only point somewhere inert. javascript: and data: are the two
// that execute; everything unrecognised is refused rather than guessed at.
// An image source worth keeping — https or an inline image, nothing else.
// http: shows as a broken image or a mixed-content warning in a mail client,
// and javascript:/data:text are the two that execute. Mirrors the server.
function safeImgSrc(value) {
  const v = String(value).trim()
  if (/^https:\/\//i.test(v)) return v
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v)) return v
  return ''
}

function safeHref(value) {
  const v = String(value).trim()
  // Strip control characters first — "java\tscript:" parses as javascript:.
  // eslint-disable-next-line no-control-regex
  const bare = v.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  if (/^(https?:|mailto:|tel:)/.test(bare)) return v
  // A relative link is fine and common in pasted content.
  if (/^[/#?]/.test(v)) return v
  return null
}

/**
 * Sanitise an HTML fragment for rendering or sending.
 *
 * Returns a string. Never throws: unparseable input yields ''.
 */
export function sanitiseHtml(input) {
  if (typeof input !== 'string' || input === '') return ''
  // No DOMParser (SSR, a test runner without jsdom): return the text with all
  // tags removed rather than trusting the input. Failing closed matters more
  // than preserving formatting in an environment that cannot render it anyway.
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return input.replace(/<[^>]*>/g, '')
  }

  let doc
  try {
    doc = new window.DOMParser().parseFromString(`<body>${input}</body>`, 'text/html')
  } catch {
    return ''
  }
  const body = doc.body
  if (!body) return ''

  // Depth-first, collecting first: mutating the tree while walking it with a
  // live NodeList skips nodes.
  const walk = (node) => {
    const children = Array.from(node.childNodes)
    for (const child of children) {
      if (child.nodeType === 3) continue                 // text — always fine
      if (child.nodeType !== 1) { child.remove(); continue } // comments, CDATA

      const tag = child.tagName.toUpperCase()

      if (DROP_CONTENT.has(tag)) { child.remove(); continue }

      if (!ALLOWED.has(tag)) {
        // Unwrap: keep the text, drop the tag.
        walk(child)
        while (child.firstChild) node.insertBefore(child.firstChild, child)
        child.remove()
        continue
      }

      // Strip every attribute except the few allowed for this tag.
      const permitted = ATTRS[tag] || new Set()
      let dropped = false
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        // Belt and braces: no on* handler survives even if a tag's set grows.
        if (name.startsWith('on') || !permitted.has(name)) {
          child.removeAttribute(attr.name)
          continue
        }
        if (name === 'style') {
          const safe = safeStyle(attr.value)
          if (safe) child.setAttribute('style', safe)
          else child.removeAttribute('style')
        }
        if (name === 'href') {
          const safe = safeHref(attr.value)
          if (safe) child.setAttribute('href', safe)
          else child.removeAttribute('href')
        }
        if (name === 'src') {
          const safe = safeImgSrc(attr.value)
          // Removed outright, not left src-less: a broken-image icon in a
          // signature is worse than the image simply not being there.
          // `dropped`, not an early return: returning here would abandon
          // every REMAINING SIBLING of this node, silently truncating the
          // rest of the signature after one bad image.
          if (safe) child.setAttribute('src', safe)
          else { child.remove(); dropped = true; break }
        }
      }

      if (dropped) continue

      // Any surviving link opens away from the iframe, and rel closes the
      // reverse-tabnabbing hole that target=_blank opens on its own.
      if (tag === 'A' && child.hasAttribute('href')) {
        child.setAttribute('target', '_blank')
        child.setAttribute('rel', 'noopener noreferrer nofollow')
      }

      walk(child)
    }
  }
  walk(body)

  return body.innerHTML
}

// Plain text from HTML, for a character count or a preview line.
//
// Block boundaries become spaces before the text is read: textContent joins
// `<p>Hi</p><p>there</p>` as "Hithere", which has bitten this codebase before.
export function htmlToText(input) {
  if (typeof input !== 'string' || input === '') return ''
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  try {
    const doc = new window.DOMParser().parseFromString(`<body>${input}</body>`, 'text/html')
    for (const el of doc.body.querySelectorAll('p, div, br, li, h1, h2, h3, h4, blockquote')) {
      el.insertAdjacentText('beforebegin', ' ')
    }
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

// Is there anything in this HTML besides markup? A body of "<p></p>" is empty
// as far as a required-field check is concerned.
export function isHtmlEmpty(input) {
  return htmlToText(input) === ''
}
