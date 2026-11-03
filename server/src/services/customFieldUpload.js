// Upload a file to a FILE_UPLOAD custom field.
//
// ═══════════════════════════════════════════════════════════════════════
// THE ENDPOINT
// ═══════════════════════════════════════════════════════════════════════
//
//   POST /locations/:locationId/customFields/upload
//   Version: v3
//   Content-Type: multipart/form-data
//
// Fields: `id` (the CONTACT or OPPORTUNITY id), `maxFiles`, and the file
// itself under the custom field's own key.
//
// Returns { uploadedFiles: { filename: url }, meta: [...] }.
//
// ═══════════════════════════════════════════════════════════════════════
// WHY THESE FIELDS WERE READ-ONLY UNTIL NOW
// ═══════════════════════════════════════════════════════════════════════
//
// They were marked readOnly on the claim that there is "no OAuth documents
// API". That was a wrong generalisation: EMAIL attachments genuinely have no
// upload API, and I carried that over to custom fields, which do. The fields
// rendered with "Upload files in your CRM" beside them for no good reason.
//
// ═══════════════════════════════════════════════════════════════════════
// THE VERSION HEADER
// ═══════════════════════════════════════════════════════════════════════
//
// v3, not the app-wide 2021-07-28. Calling a path with the wrong API version
// makes GHL answer 401 — not 400 — which reads exactly like a dead token, and
// that is what halted a sub-account when /notes/:id was called with the v1
// header. Pinned here, and scopeOptional so a failure cannot flag the install.

import FormData from 'form-data';
import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

const UPLOAD_API_VERSION = 'v3';

// GHL's own limit for a multi-file field is 15 (maxFileLimit on the
// definition). This is the ceiling we send when a field does not state one.
const DEFAULT_MAX_FILES = 15;

export class UploadError extends Error {
  constructor(message, { status = 400, field = null } = {}) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.field = field;
  }
}

/**
 * Send one or more files to a custom field.
 *
 * @param install     the active install
 * @param recordId    contact id or opportunity id — whose field this is
 * @param fieldKey    the custom field's key, e.g. contact.file_upload_leadform
 * @param files       [{ buffer, originalname, mimetype }] from multer
 * @param maxFiles    the field's own limit, when the definition states one
 *
 * Returns [{ name, url }] — what the caller stores as the field's value.
 */
export async function uploadToCustomField(
  install, { recordId, fieldKey, files, maxFiles }
) {
  if (!recordId) throw new UploadError('Which record?', { field: 'recordId' });
  if (!fieldKey) throw new UploadError('Which field?', { field: 'fieldKey' });
  if (!Array.isArray(files) || files.length === 0) {
    throw new UploadError('No file was sent', { field: 'file' });
  }

  const limit = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0
    ? Number(maxFiles)
    : DEFAULT_MAX_FILES;

  if (files.length > limit) {
    // Checked here rather than letting GHL reject: the message names the
    // limit, and a rejected multipart body costs the upload bandwidth first.
    throw new UploadError(
      `This field takes at most ${limit} file${limit === 1 ? '' : 's'}`,
      { field: 'file' }
    );
  }

  const form = new FormData();
  form.append('id', recordId);
  form.append('maxFiles', String(limit));
  for (const f of files) {
    // The FIELD KEY is the form field name — that is how GHL knows which
    // custom field the upload belongs to.
    form.append(fieldKey, f.buffer, {
      filename: f.originalname || 'upload',
      contentType: f.mimetype || 'application/octet-stream'
    });
  }

  let data;
  try {
    ({ data } = await ghlRequest(install, {
      method: 'POST',
      url: `/locations/${encodeURIComponent(install.location_id)}/customFields/upload`,
      data: form,
      headers: {
        ...form.getHeaders(),
        Version: UPLOAD_API_VERSION
      },
      // A 401 from this one endpoint must never mark the install
      // reauth_required — that halts every sync for the location.
      scopeOptional: true,
      // A file is not a JSON body: axios must not try to transform it, and
      // the default 10 MB response cap is irrelevant here but the request
      // cap is not.
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }));
  } catch (err) {
    logger.warn(
      { locationId: install.location_id, recordId, fieldKey, err },
      'customFieldUpload: upload failed'
    );
    throw err;
  }

  // { uploadedFiles: { "quote.pdf": "https://…" } } — a map, not an array.
  const uploaded = (data?.uploadedFiles && typeof data.uploadedFiles === 'object')
    ? data.uploadedFiles
    : {};
  const out = Object.entries(uploaded).map(([name, url]) => ({ name, url }));

  logger.info(
    { locationId: install.location_id, recordId, fieldKey, count: out.length },
    'customFieldUpload: files uploaded'
  );
  return out;
}
