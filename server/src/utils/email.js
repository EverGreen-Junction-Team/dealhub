// Email address fields on a raw GHL message, read the same way everywhere.
// Lifted out of routes/deals.js so the AI's reply path can read an original
// email's From/To with the same parser the timeline uses.
// Channel → accent + icon. Matches the tokens in the Deal Hub design.
// The 'ACTIVITY' bucket collects all TYPE_ACTIVITY_* rows (opp created,
// task completed, invoice paid, etc.) — rendered as compact event lines,
// not full message cards.
// Pull attachments out of the raw_message JSONB. GHL isn't consistent —
// email attachments live under `attachments`, SMS/WhatsApp under `mediaUrls`
// (URL list, no filenames), and some payloads carry neither. Fall back
// gracefully, never fail the request.
// Pull an email address off a raw GHL message payload.
//
// WHY THIS IS SO FORGIVING. `messages` has no from/to columns — migration 031
// promoted thread_id, subject and reply_to_message_id off the email payload
// and left addresses in raw_message. Nothing in this codebase records what
// GHL names them there, and GHL's email payloads have historically used both
// bare (`from`) and prefixed (`emailFrom`) spellings, sometimes as an array of
// recipients and sometimes as a single string.
//
// So this tries the shapes instead of asserting one, and returns null when
// none match. The From/To block is a nicety on an expanded email; the subject
// and body are the point. A wrong guess here must degrade to "no addresses
// shown", never to a crash or a rendered "undefined".
export function emailAddr(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;

  const candidates = [
    raw[kind],                                     // from / to
    raw[`email${kind[0].toUpperCase()}${kind.slice(1)}`], // emailFrom / emailTo
    raw[`${kind}Address`],                         // fromAddress / toAddress
    raw[`${kind}Email`]                            // fromEmail / toEmail
  ];

  for (const c of candidates) {
    if (!c) continue;
    // A recipient list: join, because "who did we email" on a deal often has
    // more than one answer and showing only the first would mislead.
    if (Array.isArray(c)) {
      const parts = c.map((x) => (typeof x === 'string' ? x : x?.email || x?.address))
        .filter((x) => typeof x === 'string' && x.trim());
      if (parts.length) return parts.join(', ');
      continue;
    }
    if (typeof c === 'string' && c.trim()) return c.trim();
    // An object form: { email, name }.
    if (typeof c === 'object') {
      const one = c.email || c.address;
      if (typeof one === 'string' && one.trim()) return one.trim();
    }
  }
  return null;
}

// The same fields as a LIST of addresses, one per recipient, for building a
// reply-all. emailAddr joins them for display; a composer needs them apart.
export function emailAddrList(raw, kind) {
  const joined = emailAddr(raw, kind);
  if (!joined) return [];
  return joined.split(',')
    .map((x) => x.trim().replace(/^.*<([^>]+)>.*$/, '$1').toLowerCase())
    .filter((x) => x.includes('@'));
}

export const isEmailAddress = (s) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(String(s || '').trim());
