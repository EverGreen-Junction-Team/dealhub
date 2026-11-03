// /api/media — GHL's private attachments, fetched with the install's token
// and streamed to the browser. See services/attachmentProxy.js for why.
//
// NO SESSION MIDDLEWARE: an <img> or <video> cannot send a bearer header,
// so the link carries its own authorisation — an HMAC over the location,
// the URL and an expiry, minted by the timeline route for a signed-in rep.

import express from 'express';
import { Readable } from 'node:stream';
import { verifyAttachmentQuery } from '../services/attachmentProxy.js';
import { getActiveInstall, explainInactiveInstall, ghlRequest } from '../services/ghlClient.js';
import { verifyRecordingQuery, openRecordingStream } from '../conversationPoint/recordingStore.js';
import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

export const mediaRouter = express.Router();

// Conversation Point recordings — our own copy, by signed link (same idea as
// /attachment: an <audio> tag cannot send a bearer header). Served from local
// disk or streamed through from Supabase Storage; the browser never sees
// where the bytes live.
mediaRouter.get('/recording', async (req, res) => {
  const ok = verifyRecordingQuery(req.query);
  if (!ok) return res.status(403).send('This link is not valid or has expired.');
  const { locationId, callId } = ok;
  try {
    const { rows } = await rawQuery(
      `SELECT id, location_id, recording_storage, recording_key, recording_content_type, recording_bytes, started_at
         FROM calls WHERE location_id = $1 AND id = $2`,
      [locationId, callId]
    );
    const call = rows[0];
    if (!call || !call.recording_key) return res.status(404).send('No recording for this call.');
    const opened = await openRecordingStream(call);
    if (!opened) return res.status(404).send('This recording is no longer available.');
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Type', opened.contentType);
    res.set('Accept-Ranges', 'none');
    if (opened.bytes) res.set('Content-Length', String(opened.bytes));
    const ext = (call.recording_key.split('.').pop() || 'mp3').toLowerCase();
    const stamp = call.started_at ? new Date(call.started_at).toISOString().slice(0, 16).replace(/[:T]/g, '-') : callId;
    res.set('Content-Disposition', `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="call-${stamp}.${ext}"`);
    const stream = opened.web ? Readable.fromWeb(opened.stream) : opened.stream;
    stream.on('error', (err) => {
      logger.warn({ err, callId }, 'media: recording stream failed');
      if (!res.headersSent) res.status(502).end(); else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    logger.warn({ err, locationId, callId }, 'media: recording fetch failed');
    return res.status(502).send('Could not read this recording.');
  }
});

mediaRouter.get('/attachment', async (req, res) => {
  const ok = verifyAttachmentQuery(req.query);
  if (!ok) return res.status(403).send('This link is not valid or has expired.');
  const { locationId, url } = ok;

  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      // Uninstalled and reauth-required need different fixes; say which.
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).send(inactive.message);
    }

    const resp = await ghlRequest(install, {
      method: 'GET',
      url,                       // absolute: axios ignores baseURL for it
      responseType: 'arraybuffer',
      maxRedirects: 5,
      // GHL's storage answers in a few seconds; a stuck fetch should fail,
      // not hold a connection open for the browser's default minute.
      timeout: 20000,
      scopeOptional: true
    });

    const type = String(resp.headers?.['content-type'] || 'application/octet-stream');

    // A metadata answer rather than the file: GHL hands back JSON with the
    // signed storage link. Send the browser there.
    if (/^application\/json/i.test(type)) {
      let meta = null;
      try { meta = JSON.parse(Buffer.from(resp.data).toString('utf8')); } catch { meta = null; }
      const signed = meta?.url || meta?.signedUrl || meta?.downloadUrl || meta?.fileUrl;
      if (signed && /^https?:\/\//.test(signed)) return res.redirect(302, signed);
      return res.status(502).send('GHL returned no file for this attachment.');
    }

    // Media is immutable at a given URL and the link is private to the rep
    // who was shown it: let the browser keep it for the session rather than
    // refetch on every timeline refresh. Overrides the /api default of
    // no-store, which is right for JSON and wrong for a 2MB photo.
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Type', type);
    if (resp.headers?.['content-length']) res.set('Content-Length', resp.headers['content-length']);
    const name = (String(resp.headers?.['content-disposition'] || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1];
    res.set('Content-Disposition', `${req.query.dl === '1' ? 'attachment' : 'inline'}${name ? `; filename="${name}"` : ''}`);
    return res.send(Buffer.from(resp.data));
  } catch (err) {
    const status = err.response?.status;
    logger.warn({ err, locationId, url, status }, 'media: attachment fetch failed');
    if (status === 404 || status === 410) return res.status(404).send('This attachment is no longer available.');
    return res.status(502).send('Could not fetch this attachment from your CRM.');
  }
});
