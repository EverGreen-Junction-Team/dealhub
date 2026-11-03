// Server-side allow-list sanitiser for HTML we store and later send.
//
// WHY A SECOND COPY. The dashboard has one (utils/sanitiseHtml.js) and it is
// thorough, but it runs in the browser — so it protects the page that renders
// a note, not the database. A signature arrives over HTTP and anyone who can
// reach the endpoint can skip the editor entirely: curl, a stale tab, a
// script. Storing whatever they send and later putting it in an email that
// goes out over the company's own domain is the part that cannot be left to a
// client-side check.
//
// ALLOW-LIST, NOT DENY-LIST — same reasoning as the client's. A deny-list
// loses to the next encoding trick; this keeps only what we can name a use for
// and drops the rest, so an unknown construct fails closed.
//
// Kept deliberately in step with the client list. They will drift if someone
// adds a tag to one and forgets the other, and the failure is silent: the
// editor would offer a control whose output the server strips. A test asserts
// the two lists match.

import * as cheerio from 'cheerio';

// Tags a signature or note legitimately needs. No IMG: an image in a
// signature means a remote URL we do not control, loaded by the recipient's
// mail client, which is a tracking pixel whether or not anyone intended one.
export const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
  'ul', 'ol', 'li',
  'a',
  'h1', 'h2', 'h3', 'h4',
  'blockquote', 'code', 'pre',
  // A SIGNATURE IS NOT A NOTE.
  //
  // These were absent, and a signature went out as flat grey text: no logo,
  // no brand colour, every line hard against the next. The client's editor
  // allowed all of it, so a rep built a signature that looked right, saved
  // it, and watched this strip it — the two allow-lists disagreed, and the
  // server's was the one that decided what was sent.
  //
  // `img` earns its place because this sanitiser has exactly ONE caller:
  // signatureStore.saveSignature. The image is the rep's own logo, on mail
  // going out. If this is ever reused for INBOUND mail, drop `img` first —
  // a remote image in received mail is a tracking pixel, and safeImgSrc
  // below deliberately permits any https host.
  'img',
  // Tables are how every mail client lays out a signature; CSS grid and flex
  // do not survive Outlook. Unwrapping them (what this used to do) is what
  // collapsed the layout into one line per cell.
  'table', 'thead', 'tbody', 'tr', 'td', 'th'
]);

// Removed with their CONTENT, not unwrapped — unwrapping a <script> would
// paste its source into the document as text.
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta',
  'form', 'input', 'button', 'textarea', 'select', 'svg', 'math'
]);

// Attributes that survive. Everything else goes, which covers every on*
// handler without having to enumerate them.
const ALLOWED_ATTRS = {
  a: new Set(['href', 'title', 'target', 'rel', 'style']),
  // `style` is filtered through safeStyle below, never passed through whole.
  // The client has allowed it on these tags for a while; the server not
  // matching is why saved colour vanished.
  p: new Set(['style']),
  div: new Set(['style']),
  span: new Set(['style']),
  li: new Set(['style']),
  ul: new Set(['style']),
  ol: new Set(['style']),
  h1: new Set(['style']), h2: new Set(['style']),
  h3: new Set(['style']), h4: new Set(['style']),
  // width/height keep a logo from rendering at its full pixel size in a mail
  // client that ignores the style attribute.
  img: new Set(['src', 'alt', 'width', 'height', 'style']),
  table: new Set(['style', 'cellpadding', 'cellspacing', 'border', 'width']),
  thead: new Set(['style']),
  tbody: new Set(['style']),
  tr: new Set(['style']),
  td: new Set(['style', 'colspan', 'rowspan', 'align', 'valign', 'width']),
  th: new Set(['style', 'colspan', 'rowspan', 'align', 'valign', 'width'])
};

// CSS properties a signature may set. An allow-list, same as the client's,
// plus the few a signature needs that a note does not: font-size and
// font-family (brand type), line-height (the spacing between signature
// lines), and border-* (the rule above a signature block).
const CSS_PROPS = new Set([
  'color', 'background-color', 'font-weight', 'font-style',
  'font-size', 'font-family', 'line-height', 'text-decoration', 'text-align',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-width', 'border-style',
  'width', 'max-width', 'height', 'vertical-align', 'display',
  // Without border-collapse a signature table shows a double rule between
  // every cell in Outlook.
  'border-collapse', 'border-spacing'
]);

// `style` is a vector on its own: position:fixed can cover a page, url() is a
// request to someone else's server. Property allow-list, then a value check.
function safeStyle(value) {
  const out = [];
  for (const decl of String(value).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!CSS_PROPS.has(prop)) continue;
    if (/url\s*\(|expression\s*\(|\\|@import/i.test(val)) continue;
    // position/fixed cannot be set because they are not in CSS_PROPS, but
    // `display` is — and display:none on a whole signature is a confusing
    // thing to allow someone to save by accident.
    if (prop === 'display' && /none/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

// An image source we are willing to keep. https and data: images only —
// http is stripped because a mail client shows a broken-image icon or a
// mixed-content warning, and cid: refers to an attachment this app does not
// create.
function safeImgSrc(value) {
  const v = String(value).trim();
  if (/^https:\/\//i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
  return '';
}

// A URL we are willing to put behind a link. javascript: and data: are the
// two that execute; anything we do not recognise is dropped rather than
// guessed at.
function safeHref(raw) {
  const href = String(raw || '').trim();
  if (!href) return null;
  if (/^(javascript|data|vbscript|file):/i.test(href)) return null;
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(href)) return href;
  // A bare domain is the common paste. Treated as https rather than refused,
  // since refusing it would silently drop a link a rep thought they added.
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(href)) return `https://${href}`;
  return null;
}

/**
 * @param {string} html
 * @returns {string} sanitised HTML — safe to store and to send.
 */
export function sanitiseHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const $ = cheerio.load(html, null, false);

  $('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    const $el = $(el);

    if (DROP_WITH_CONTENT.has(tag)) { $el.remove(); return; }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrapped, not removed: a <table> around a signature is markup we do
      // not keep, but the name and phone number inside it are the point.
      $el.replaceWith($el.contents());
      return;
    }

    const allowed = ALLOWED_ATTRS[tag];
    for (const name of Object.keys($el.attr() || {})) {
      if (!allowed?.has(name)) { $el.removeAttr(name); continue; }
      if (name === 'href') {
        const safe = safeHref($el.attr('href'));
        if (safe) $el.attr('href', safe); else $el.removeAttr('href');
      }
      if (name === 'style') {
        const safe = safeStyle($el.attr('style'));
        if (safe) $el.attr('style', safe); else $el.removeAttr('style');
      }
      if (name === 'src') {
        const safe = safeImgSrc($el.attr('src'));
        // An image whose source we will not keep is removed entirely rather
        // than left as a broken-image icon in someone's inbox.
        if (safe) $el.attr('src', safe); else { $el.remove(); return; }
      }
    }
    // An external link opened in a new tab without this gives the opened page
    // a handle on ours through window.opener.
    if (tag === 'a' && $el.attr('target') === '_blank') {
      $el.attr('rel', 'noopener noreferrer');
    }
  });

  return $.html();
}

/** True when the HTML carries no visible content — '<p></p>', '<br>', spaces. */
export function isHtmlEmpty(html) {
  if (!html) return true;
  const $ = cheerio.load(html, null, false);
  return $.text().replace(/ /g, ' ').trim() === '';
}
