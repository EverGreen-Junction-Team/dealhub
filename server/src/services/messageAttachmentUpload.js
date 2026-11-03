// Upload files for an outbound message — the composer's paperclip.
//
//   POST /conversations/messages/upload
//   Version: 2021-04-15
//   Content-Type: multipart/form-data
//
// Fields: conversationId, contactId, locationId, and each file under
// `fileAttachment`. Returns { uploadedFiles: { filename: url } } — the same
// map shape as the custom-field upload. The URLs then go on the send as
// `attachments: [url, …]`, which GHL attaches to an email or sends as MMS.
//
// THE CONVERSATION. GHL keys message uploads on a conversation, not a
// contact. Our own messages table usually knows it; a contact nobody has
// messaged yet has none, so we look it up in GHL and, failing that, create
// it — the same conversation GHL would open on the first send anyway.
//
// THE VERSION is the conversations API's own 2021-04-15, as GHL documents
// for this path, and scopeOptional so a refusal here cannot flag the install
// reauth_required (see customFieldUpload.js on what a wrong version does).
//
// GHL's accepted types, per its docs: JPG, JPEG, PNG, MP4, MPEG, ZIP, RAR,
// PDF, DOC, DOCX, TXT, MP3, WAV. Anything else is refused here with the name,
// rather than as GHL's 415 after the bytes have gone up.

import FormData from 'form-data';
import { ghlRequest } from './ghlClient.js';
import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';

const UPLOAD_API_VERSION = '2021-04-15';
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'mp4', 'mpeg', 'zip', 'rar', 'pdf', 'doc', 'docx', 'txt', 'mp3', 'wav'
]);

export class AttachmentError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'AttachmentError';
    this.status = status;
  }
}

const extOf = (name) => String(name || '').split('.').pop().toLowerCase();

// Refuse what GHL would refuse, before any bytes go up. Exported for tests.
export function checkFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new AttachmentError('No file was sent');
  if (files.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`At most ${MAX_ATTACHMENTS} files per message`);
  }
  for (const f of files) {
    if (!ALLOWED_EXTENSIONS.has(extOf(f.originalname))) {
      throw new AttachmentError(
        `"${f.originalname}" cannot be attached — the CRM accepts images, PDF, Word, text, ZIP/RAR, MP3/WAV and MP4 files`,
        { status: 415 }
      );
    }
    if (f.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`"${f.originalname}" is over 25 MB`, { status: 413 });
    }
  }
}

// The contact's conversation: ours first, then GHL's, then a new one.
export async function conversationFor(install, contactId) {
  const locationId = install.location_id;
  const local = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT conversation_id FROM messages
        WHERE location_id = $1 AND contact_id = $2
          AND conversation_id IS NOT NULL AND deleted_at IS NULL
        ORDER BY message_timestamp DESC NULLS LAST
        LIMIT 1`,
      [locationId, contactId]
    );
    return rows[0]?.conversation_id || null;
  });
  if (local) return local;

  const params = new URLSearchParams({ locationId, contactId, limit: '1' });
  const { data } = await ghlRequest(install, {
    method: 'GET',
    url: `/conversations/search?${params.toString()}`,
    scopeOptional: true
  });
  const found = data?.conversations?.[0]?.id;
  if (found) return found;

  const created = await ghlRequest(install, {
    method: 'POST',
    url: '/conversations/',
    data: { locationId, contactId },
    scopeOptional: true
  });
  const id = created.data?.conversation?.id || created.data?.id || null;
  if (!id) throw new AttachmentError('Could not open a conversation with this contact in the CRM', { status: 502 });
  return id;
}

/**
 * @returns {Promise<Array<{ name, url, size, type }>>}
 */
export async function uploadMessageAttachments(install, { contactId, files }) {
  checkFiles(files);
  const conversationId = await conversationFor(install, contactId);

  const form = new FormData();
  form.append('conversationId', conversationId);
  form.append('contactId', contactId);
  form.append('locationId', install.location_id);
  for (const f of files) {
    form.append('fileAttachment', f.buffer, {
      filename: f.originalname || 'upload',
      contentType: f.mimetype || 'application/octet-stream'
    });
  }

  let data;
  try {
    ({ data } = await ghlRequest(install, {
      method: 'POST',
      url: '/conversations/messages/upload',
      data: form,
      headers: { ...form.getHeaders(), Version: UPLOAD_API_VERSION },
      scopeOptional: true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }));
  } catch (err) {
    const status = err.response?.status;
    logger.warn(
      { locationId: install.location_id, contactId, status, body: err.response?.data },
      'messageAttachmentUpload: upload failed'
    );
    throw new AttachmentError(
      status === 413 ? 'That file is too large for the CRM'
        : status === 415 ? 'The CRM does not accept that file type'
          : status === 401 || status === 403
            ? 'This app cannot upload attachments yet — the conversations write permission is missing. Reauthorise the app.'
            : 'The CRM would not take that file — nothing was attached. Try again.',
      { status: status === 413 || status === 415 ? status : 502 }
    );
  }

  const uploaded = (data?.uploadedFiles && typeof data.uploadedFiles === 'object') ? data.uploadedFiles : {};
  const byName = new Map(files.map((f) => [f.originalname, f]));
  const out = Object.entries(uploaded).map(([name, url]) => ({
    name, url, size: byName.get(name)?.size ?? null, type: byName.get(name)?.mimetype ?? null
  }));
  logger.info(
    { locationId: install.location_id, contactId, conversationId, count: out.length },
    'messageAttachmentUpload: files uploaded'
  );
  return out;
}
