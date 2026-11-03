// Attachments carried on a message's raw GHL payload.
//
// This lived as a private function in routes/deals.js, so the deal timeline
// showed a message's PDF while the SAME message on the contact and business
// pages showed nothing — not "no attachments", but no sign one existed. A rep
// checking a contact had no way to know the email had a quote on it.
//
// Shared here so all three surfaces read the payload the same way. The column
// is `messages.raw_message`; a query that does not select it gets [] back,
// which is why each caller has to select it explicitly.

/**
 * Normalise a message's attachments into one shape the UI can render.
 *
 * GHL uses two different shapes depending on channel:
 *   • `attachments` — email, as objects with a filename and size
 *   • `mediaUrls`   — SMS/WhatsApp, as bare URL strings
 *
 * Both become { name, sizeBytes, contentType, url }. Size and contentType are
 * null for media URLs, which carry neither.
 *
 * @param {object|null} raw  messages.raw_message
 * @returns {Array<{name:string,sizeBytes:number|null,contentType:string|null,url:string|null}>}
 */
export function extractAttachments(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];

  const arr = Array.isArray(raw.attachments) ? raw.attachments : null;
  if (arr) {
    for (const a of arr) {
      if (!a) continue;
      // A BARE URL STRING — what the message webhooks actually send
      // (`attachments: ["https://…/7225aa4b….png"]`). This branch only knew
      // the object form, so a string became { name: 'attachment', url: null }:
      // a chip with no link, and a tile with nothing to load. The name is the
      // file's own, from the path, and the type from its extension.
      if (typeof a === 'string') {
        const url = a.trim();
        if (!url) continue;
        const name = url.split('?')[0].split('/').pop() || 'attachment';
        out.push({ name, sizeBytes: null, contentType: contentTypeFromName(name), url });
        continue;
      }
      out.push({
        // Falls back to the URL's last segment, then a generic label — a
        // nameless chip is not clickable-looking and reads as broken.
        name: a.filename || a.name || (a.url ? a.url.split('?')[0].split('/').pop() : 'attachment'),
        sizeBytes: a.size || a.sizeBytes || null,
        contentType: a.contentType || a.mimeType || null,
        url: a.url || null
      });
    }
  }

  const media = Array.isArray(raw.mediaUrls) ? raw.mediaUrls : null;
  if (media) {
    for (const url of media) {
      if (!url || typeof url !== 'string') continue;
      const name = url.split('?')[0].split('/').pop() || 'media';
      out.push({
        // Strip the query string before taking the filename: a signed GHL
        // media URL ends in a token, so the raw last segment is unreadable.
        name,
        sizeBytes: null,
        contentType: contentTypeFromName(name),
        url
      });
    }
  }

  return out;
}

// The MIME type a filename's extension implies, for the common kinds the
// timeline draws differently. Null when the extension says nothing — the
// client then decides by trying the file.
const TYPE_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', opus: 'audio/opus',
  pdf: 'application/pdf'
};
export function contentTypeFromName(name) {
  const ext = String(name || '').split('?')[0].split('.').pop().toLowerCase();
  return TYPE_BY_EXT[ext] || null;
}
