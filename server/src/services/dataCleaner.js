import * as cheerio from 'cheerio';

// Data cleaning per STAGE_HISTORY_WEBHOOK_PLAN Section 4.
// Goal: strip GHL noise so analyst queries / downstream LLMs aren't drowning
// in MIME headers, tracking pixels, and emoji.
//
// Two flavours:
//   - cleanEmail(body)  — for HTML emails: keep <body>...</body>, strip
//                          headers/footers/signatures/pixels
//   - cleanText(body)   — for SMS / WhatsApp: strip emoji + UI placeholders

// ---------------------------------------------------------------- emails

// Footer / unsubscribe phrases we routinely see in GHL-relayed emails.
// Match conservatively: lowercased substring search on each line.
const EMAIL_FOOTER_MARKERS = [
  'unsubscribe',
  'manage your preferences',
  'view this email in your browser',
  'this email was sent to',
  'sent from my iphone',
  'sent from my android',
  'sent from outlook'
];

export function cleanEmail(html) {
  if (!html || typeof html !== 'string') return '';
  let $;
  try {
    $ = cheerio.load(html);
  } catch (_) {
    // If parsing fails (malformed HTML, plain text masquerading as HTML),
    // fall back to the text cleaner — better something than nothing.
    return cleanText(html);
  }

  // 1. Remove document-level noise FIRST (before grabbing body) — covers
  //    <style> blocks inside <head>, <script> anywhere, metadata, etc.
  //    This guarantees they're gone even if the input is fragment-shaped.
  $('script, style, head, meta, link, noscript, title').remove();

  // 2. Keep only the inside of <body>. If there's no <body>, treat the whole
  //    string as the email body — some inbound providers omit the wrapper.
  const bodyEl = $('body');
  const root = bodyEl.length ? bodyEl : $.root();

  // 3. Drop tracking pixels (1x1 / 2x2 images).
  root.find('img').each((_, el) => {
    const $img = $(el);
    const w = parseInt($img.attr('width') || '0', 10);
    const h = parseInt($img.attr('height') || '0', 10);
    if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) $img.remove();
  });

  // 4. Drop common tracker beacons.
  root.find('[data-track], [data-tracking], [class*="tracking-pixel"]').remove();

  // 5. Strip footer blocks (unsubscribe links, "sent from iPhone", etc.).
  root.find('table, div, p').each((_, el) => {
    const text = $(el).text().toLowerCase();
    if (EMAIL_FOOTER_MARKERS.some((m) => text.includes(m))) {
      $(el).remove();
    }
  });

  // 6. Strip ONLY `style` and `class` attributes. Everything else stays —
  //    href, src, alt, title, id, layout attrs etc. preserve semantics.
  //    Per requirement: "HTML tags inside the body are acceptable" but
  //    inline styles + class hooks are pure visual noise for analytics/LLM.
  root.find('[style], [class]').each((_, el) => {
    if (!el.attribs) return;
    delete el.attribs.style;
    delete el.attribs.class;
  });

  // Return remaining HTML, trimmed.
  return root.html()?.trim() || '';
}

// ---------------------------------------------------------------- text

// Strip emojis + zero-width joiners + variation selectors. Covers most of
// the BMP emoji ranges + supplementary symbols.
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{200D}️]/gu;

// GHL UI placeholders we see in SMS/WhatsApp bodies — e.g. >AUDIO<, >IMAGE<.
const GHL_UI_PLACEHOLDERS = /(>(AUDIO|IMAGE|VIDEO|FILE|DOCUMENT|STICKER|LOCATION|CONTACT)<)/gi;

export function cleanText(body) {
  if (!body || typeof body !== 'string') return '';
  // Strip emojis (icons) but PRESERVE the surrounding text.
  //   "Reacted 😍 to \"see you tomorrow\"" → "Reacted to \"see you tomorrow\""
  //   "Hi 👋 see you tomorrow!"             → "Hi see you tomorrow!"
  // Whitespace collapse at the end tidies up the double-spaces left behind.
  return body
    .replace(EMOJI_REGEX, '')
    .replace(GHL_UI_PLACEHOLDERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Single entry point: routes by channel.
//
// Channel value can arrive in any of these shapes after readableChannel():
//   "Email"             — raw GHL channel field
//   "EMAIL"             — from type → name mapping (type 3)
//   "CUSTOM_EMAIL"      — type 21
//   "TYPE_EMAIL"        — legacy messageType prefix
//   "CAMPAIGN_EMAIL"    — type 9
// All five lower-case + contain "email" → cleanEmail.
// Everything else (SMS, WhatsApp, Webchat, Live Chat, Call) → cleanText.
export function cleanMessageBody(body, channel) {
  if (!body) return '';
  const ch = String(channel || '').toLowerCase();
  if (ch === 'email' || ch.includes('email')) return cleanEmail(body);
  return cleanText(body);
}
