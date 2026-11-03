import React, { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Renders model-generated prose as real markdown — headings, bold, bullet
// lists, tables — matching GHL's Ask AI (ai-frontend's MarkdownRenderer.vue,
// which uses the same two libraries for the same reason).
//
// WHY THIS EXISTS. The answer prompt asks for plain prose, but the model
// reaches for **bold** and bullet lists regardless — the "which deal has more
// value" answer and the "how many exist" answer both did, unprompted. An
// earlier version hand-rolled a bold/italic-only parser for exactly the first
// case and then broke on the second, which needed real lists.
//
// WHY SANITIZED. This is MODEL output rendered as raw HTML. marked.parse()
// turns "<img onerror=alert(1)>" in a message the model quoted straight into
// a live handler if nothing stands between it and the DOM. DOMPurify is that
// step — the same pairing GHL's own renderer uses, not a substitute for it.
// Turn a run of "Label: value" lines into a real markdown list.
//
// The prompt asks for "- " on every list item, and the model mostly complies —
// but not for short breakdowns. A count split by status came back as four
// indented lines with no markers, which markdown renders as unmarked text:
// it looks like a list while the model is writing it and reads as loose lines
// to the rep.
//
// Rather than only asking harder, the renderer repairs the common shape. The
// bar is deliberately high, because wrongly converting prose into a list is
// worse than leaving it alone:
//   - at least two consecutive lines
//   - each "Label: value", with a short label and no sentence punctuation
//   - none already a list item, heading, quote or table row
// A paragraph that happens to contain a colon does not qualify; four lines of
// "Open: 8" do.
const LABEL_VALUE = /^\s{0,6}([A-Z][\w '&/-]{0,28}):\s+(\S.*)$/;

// A short bare line that is plainly an option, not prose: "SMS (native)",
// "WhatsApp QR", "iMessage".
//
// Starts with a LETTER, not specifically a capital. Requiring a capital broke
// on "iMessage" — a real sender name — which split the run in two and left
// the whole list unnumbered. Product names do not agree to be capitalised.
//
// Deliberately narrow otherwise: no sentence punctuation, at most four words.
// The risk is turning a real sentence into a list item, so anything with a
// full stop, a comma, or more words is left alone.
//
// Plus an optional " — (annotation)" tail. The model marks the sender a
// thread already uses as "WhatsApp (native) — (used in this thread)", and the
// em dash broke the run: that line failed the test, the two below it were
// one short of the threshold, and the menu rendered with no numbers at all.
const BARE_OPTION = /^\s{0,6}([A-Za-z][\w()+&./-]*(?:\s+[\w()+&./-]+){0,3})(?:\s+[—–-]\s+\(?[\w ]{1,40}\)?)?\s*$/;

function listify(text) {
  // The colon test only gates the Label: value repair — NOT the numbering
  // below it. An early `return text` here used to skip numberOptions too, so
  // a sender menu with no colon anywhere in the answer was never numbered,
  // however plainly it said "reply with a number".
  if (!text.includes(':')) return numberOptions(text)
  const lines = text.split('\n');
  const out = [];
  let run = [];

  const flush = () => {
    if (run.length >= 2) out.push(...run.map((l) => `- ${l.trim()}`))
    else out.push(...run)
    run = []
  };

  for (const line of lines) {
    const t = line.trim();
    const isListish = /^([-*+]|\d+\.|#{1,6}|>|\|)/.test(t);
    if (!isListish && LABEL_VALUE.test(line) && !/[.!?]$/.test(t)) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return numberOptions(out.join('\n'));
}

// A run of bare option lines becomes a NUMBERED list.
//
// The model is told to write "1. ", "2. " when it offers a choice, and mostly
// does — but when it does not, the reply still says "reply with a number"
// above lines carrying no numbers. The rep is asked to pick from a list that
// does not show what to pick.
//
// Only fires when the text actually asks for a number, and only on a run of
// two or more bare lines. Both conditions matter: without the first, any
// short capitalised line could be swept into a list; without the second, a
// lone line becomes a menu. Two, not three: "WhatsApp (native)" versus
// "WhatsApp QR" is the commonest choice the model now offers, and the
// "reply with a number" gate is what makes a two-line run safe to number.
function numberOptions(text) {
  if (!/reply with (a |the )?number|pick a number|choose a number/i.test(text)) return text
  const lines = text.split('\n');
  const out = [];
  let run = [];

  const flush = () => {
    if (run.length >= 2) out.push(...run.map((l, i) => `${i + 1}. ${l.trim()}`))
    else out.push(...run)
    run = []
  };

  for (const line of lines) {
    const t = line.trim();
    const isListish = /^([-*+]|\d+\.|#{1,6}|>|\|)/.test(t);
    if (!isListish && t && BARE_OPTION.test(line)) { run.push(line); continue }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}

export default function MarkdownAnswer({ text, className }) {
  const html = useMemo(() => {
    if (!text) return ''
    const raw = marked.parse(listify(String(text)), {
      gfm: true,
      // Reps write "line one\nline two" expecting two lines; CommonMark's
      // default treats a single newline as the same paragraph, which read as
      // the model ignoring its own line breaks.
      breaks: true
    })
    return DOMPurify.sanitize(raw, {
      // No onClick handlers, no javascript: URLs, no <script>/<style> — this
      // is the model's own output, so it gets the same distrust an
      // arbitrary user's would.
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'code', 'pre',
        'ul', 'ol', 'li', 'blockquote',
        'h1', 'h2', 'h3', 'h4',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'a', 'hr'
      ],
      ALLOWED_ATTR: ['href']
    })
  }, [text])

  if (!html) return null

  return (
    <div
      className={`pp-md ${className || ''}`}
      // Safe: `html` above is the DOMPurify output, never the raw string.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
