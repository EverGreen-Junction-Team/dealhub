// attachmentProxy.js — browser-loadable URLs for GHL's private attachments.
//
// WHY. A photo sent on WhatsApp or SMS arrives from GHL as a URL on GHL's own
// storage — services.leadconnectorhq.com/…/attachment, or the private
// msgsndr bucket. Those need the account's OAuth token: GHL's inbox resolves
// each one through a metadata call to a signed link before showing it. Our
// page put the raw URL straight into <img src>, the browser asked for it
// with no token, and every picture drew as the broken-image glyph with its
// alt text. (Public msgsndr URLs and the dashboard's own uploads load fine
// and are left alone.)
//
// HOW. The timeline rewrites such a URL to /api/media/attachment on THIS
// server, signed with an HMAC over (location, url, expiry) so the link
// itself is the authorisation — an <img> cannot send a bearer header. The
// media route checks the signature, fetches the file from GHL with the
// install's token, and streams it back. Links live 24 hours, long enough
// for a session; a stale one just reloads with the timeline.

import crypto from 'node:crypto';
import { config } from '../config.js';

const TTL_SECONDS = 60 * 60 * 24;

const PRIVATE_HOSTS = [
  /(^|\.)leadconnectorhq\.com$/i,
  /^msgsndr-private\./i
];

function secret() {
  return config.session?.jwtSecret || config.ghl?.clientSecret || '';
}

export function needsProxy(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) return false;
    return PRIVATE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

function sign(locationId, url, exp) {
  return crypto.createHmac('sha256', secret())
    .update(`${locationId}\n${url}\n${exp}`)
    .digest('base64url');
}

/** The absolute proxy URL for one private attachment. */
export function signAttachmentUrl(locationId, url, { download = false } = {}) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const q = new URLSearchParams({
    loc: locationId, u: b64url(url), exp: String(exp), sig: sign(locationId, url, exp)
  });
  if (download) q.set('dl', '1');
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/media/attachment?${q.toString()}`;
}

/** Verify a proxy link's query. Returns { locationId, url } or null. */
export function verifyAttachmentQuery(q) {
  const locationId = String(q.loc || '');
  const exp = Number(q.exp || 0);
  const sig = String(q.sig || '');
  let url;
  try { url = unb64url(q.u); } catch { return null; }
  if (!locationId || !url || !exp || !sig) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  const want = sign(locationId, url, exp);
  const a = Buffer.from(want), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!needsProxy(url)) return null;
  return { locationId, url };
}

/**
 * The attachments of one message with private URLs rewritten to proxy
 * links. The original is kept as `sourceUrl` for anything that needs it.
 */
export function proxyAttachments(locationId, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return attachments;
  if (!secret()) return attachments;   // no secret to sign with — leave as is
  return attachments.map((a) => (
    a?.url && needsProxy(a.url)
      ? { ...a, sourceUrl: a.url, url: signAttachmentUrl(locationId, a.url) }
      : a
  ));
}
