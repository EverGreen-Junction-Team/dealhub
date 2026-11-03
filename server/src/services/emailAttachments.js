// Email attachments have to be FETCHED. The webhook never carries them.
//
// ═══════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═══════════════════════════════════════════════════════════════════════
//
// An outbound email webhook always sends `attachments: null`. Not sometimes —
// always. Inside GHL an email stores its uploads on a `files` field, and the
// webhook builder copies `attachments`, a field that path never populates.
// The `files → attachments` remap exists only on the GET email service, so a
// webhook consumer cannot see them at any point.
//
// `attachments_metadata` is not on the webhook either.
//
// So the only way to know an email had a PDF on it is to ask for the message
// after the fact. That is the same shape as notes, where the webhook omits
// attachments and noteWriter calls GET /contacts/:cid/notes/:id to get them.
//
// ═══════════════════════════════════════════════════════════════════════
// THE VERSION HEADER — the part that has already cost us an outage
// ═══════════════════════════════════════════════════════════════════════
//
// ghlClient sends `Version: 2021-07-28` on every request. This endpoint is
// documented under 2021-04-15. Calling a path with the wrong API version
// makes GHL answer 401 — NOT 400 — which reads exactly like a dead token.
//
// That is what happened when /notes/:id (a v3 path) was called with the v1
// header: every note 401'd, the install was flagged reauth_required, and
// inbound webhooks were discarded while the flag was set. See the long
// comment in noteWriter.js.
//
// So this call pins its own Version explicitly, and carries scopeOptional so a
// 401 here can never flag the install. One endpoint failing proves far less
// than a dead token, and the blast radius of getting that wrong is the whole
// location.

import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

// The version this endpoint is documented under. Deliberately a literal here
// rather than in config: config.ghl.apiVersion is the app-wide default, and
// making this one configurable would invite someone to "align" them.
const EMAIL_API_VERSION = '2021-04-15';

/**
 * Normalise one attachment into the shape the UI reads.
 *
 * GHL is inconsistent about naming across paths (`filename` vs `name`,
 * `size` vs `sizeBytes`, `contentType` vs `mimeType`), and an entry is
 * sometimes just a URL string. Matches extractAttachments in routes/deals.js,
 * which does the same normalising for notes and SMS media.
 */
function normalise(a) {
  if (!a) return null;

  // A bare URL string — how mediaUrls entries arrive.
  if (typeof a === 'string') {
    const clean = a.split('?')[0];
    return {
      name: clean.split('/').pop() || 'attachment',
      sizeBytes: null,
      contentType: null,
      url: a
    };
  }
  if (typeof a !== 'object') return null;

  const url = a.url || a.fileUrl || a.link || null;
  return {
    name:
      a.filename
      || a.name
      || a.fileName
      || (url ? url.split('?')[0].split('/').pop() : null)
      || 'attachment',
    sizeBytes: a.size ?? a.sizeBytes ?? a.fileSize ?? null,
    contentType: a.contentType || a.mimeType || a.type || null,
    url
  };
}

/**
 * Read the attachment list off a fetched email message.
 *
 * Tries `attachments` first because the GET path remaps files → attachments
 * before responding, then `files` in case a payload arrives un-remapped —
 * cheap insurance given the remap is the very thing this module depends on.
 */
export function attachmentsFrom(message) {
  if (!message || typeof message !== 'object') return [];
  const raw =
    (Array.isArray(message.attachments) && message.attachments)
    || (Array.isArray(message.files) && message.files)
    || (Array.isArray(message.attachments_metadata) && message.attachments_metadata)
    || null;
  if (!raw) return [];
  return raw.map(normalise).filter(Boolean);
}

/**
 * Fetch one email's attachments from GHL.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EMAIL HAS ITS OWN ENDPOINT
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   GET /conversations/messages/email/:emailMessageId     ← this one
 *   GET /conversations/messages/:messageId                ← NOT this one
 *
 * The second is keyed on a MESSAGE id. An email webhook carries no message
 * id at all — only `emailMessageId`, from GHL's email collection — so
 * pickMessageFields falls back to that, and handing an email id to the
 * message endpoint returns:
 *
 *   400 {"statusCode":400,"message":["id must be a mongodb id"]}
 *
 * which is exactly what happened in production on every outbound email.
 *
 * The email endpoint takes the id we already have, so no lookup is needed:
 * one call, with the id straight off the webhook. An earlier version of this
 * file resolved the message id by listing the conversation first — that
 * worked around the wrong endpoint rather than using the right one.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE RESPONSE SHAPE IS DIFFERENT TOO
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `attachments` here is `string[]` — an array of URLs, not objects with
 * filenames and sizes:
 *
 *   { "attachments": ["https://msgsndr.../quote-v3.pdf", ...] }
 *
 * So names are derived from the URL and sizes are simply unknown. normalise()
 * handles that; AttachmentChip omits the size when it is null rather than
 * printing an empty gap.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE VERSION HEADER
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Pinned to 2021-04-15. ghlClient sends 2021-07-28 globally, and calling a
 * path with the wrong API version makes GHL answer 401 — NOT 400 — which
 * reads exactly like a dead token. That is what took a sub-account down when
 * /notes/:id (a v3 path) was called with the v1 header: every note 401'd, the
 * install was flagged reauth_required, and inbound webhooks were discarded
 * while the flag was set. See the long comment in noteWriter.js.
 *
 * Also scopeOptional, so a 401 from this one endpoint can never flag the
 * install: a dead token 401s everything, one endpoint failing proves far less.
 *
 * Returns an array — empty when the email has none, when the call fails, or
 * when there is no id. NEVER THROWS: this runs inside webhook processing, and
 * GHL does not redeliver after our 200, so a thrown error would lose the
 * message permanently.
 *
 * Scope: conversations/message.readonly.
 */
export async function fetchEmailAttachments(install, emailMessageId, { locationId } = {}) {
  if (!install || !emailMessageId) return [];

  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/conversations/messages/email/${encodeURIComponent(emailMessageId)}`,
      headers: { Version: EMAIL_API_VERSION },
      scopeOptional: true
    });

    // GHL wraps the payload on some paths and not others.
    const email = data?.email || data?.emailMessage || data?.message || data;
    const list = attachmentsFrom(email);

    logger.debug(
      { locationId, emailMessageId, count: list.length },
      list.length > 0
        ? 'email attachments fetched'
        : 'email fetched, no attachments on it'
    );
    return list;
  } catch (err) {
    // THE WHOLE ERROR, not err.message: slimErr pulls out status, url, method
    // AND GHL's response body as `ghlBody`. Passing err.message discarded all
    // of it, so a 400 logged as "Request failed with status code 400" with no
    // indication of why.
    logger.warn(
      { locationId, emailMessageId, err },
      'could not fetch email attachments — the email is stored without them'
    );
    return [];
  }
}
