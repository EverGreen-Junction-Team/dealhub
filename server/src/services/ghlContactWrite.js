// ghlContactWrite.js — push contact edits to GoHighLevel.
//
// The first write path in this app. Everything before it was read-only, so the
// shape here sets the pattern for opportunities, tasks and notes.
//
// FLOW. We are not the source of truth:
//
//   1. PUT /contacts/{id} with ONLY the changed fields
//   2. GHL applies it and fires ContactUpdate back at /webhooks/ghl
//   3. handleContactUpsert writes our row from that payload
//
// So this function does NOT update Postgres. Writing locally as well would
// create two paths to the same row that can disagree — and the webhook is the
// one that reflects what GHL actually stored, including any normalisation it
// applied (phone formatting, name casing) or any field it silently rejected.
//
// The cost is a visible round trip: an edit takes as long as the webhook takes
// to arrive. That's the right trade for a system where GHL wins.

import { ghlRequest } from './ghlClient.js';
import {
  buildContactPatch, buildContactCreatePatch, ContactWriteError
} from './contactPatch.js';
import { logger } from '../utils/logger.js';

/**
 * PUT the patch to GHL. Returns the contact GHL echoes back.
 *
 * Does not touch Postgres — the ContactUpdate webhook does that.
 */
export { buildContactPatch, buildContactCreatePatch, ContactWriteError };

// The shared 401/403/404/422 translation both create and update need. Split
// out rather than duplicated — create is otherwise identical to update's
// error handling, just a different verb/URL and no "not found" case (there
// is no existing contact to have gone missing).
function translateContactError(err, { contactId = null, allowNotFound = true } = {}) {
  const status = err.response?.status;
  const body = err.response?.data;

  if (status === 401 || status === 403) {
    return new ContactWriteError(
      'This app cannot write yet — the contacts.write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (allowNotFound && status === 404) {
    return new ContactWriteError('That contact no longer exists', { status: 404 });
  }
  if (status === 422 || status === 400) {
    const detail = body?.message || body?.error
      || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);

    logger.warn(
      { status, contactId, detail, body },
      'ghlContactWrite: rejected by the CRM'
    );

    const missing = allowNotFound && /not\s*found/i.test(detail || '');
    return new ContactWriteError(
      missing
        ? 'That contact no longer exists in your CRM — it may have been deleted'
        : 'Your CRM would not accept that — check the values and try again',
      { status: missing ? 404 : 422, detail }
    );
  }
  logger.error({ err, status, contactId, body }, 'ghlContactWrite: failed');
  return new ContactWriteError('Could not save — try again', { status: 502 });
}

export async function updateGhlContact(install, contactId, input) {
  const { patch, dropped } = buildContactPatch(input);

  if (Object.keys(patch).length === 0) {
    throw new ContactWriteError('Nothing to update', { status: 400 });
  }
  if (dropped.length) {
    // Not an error — the client may send a whole record and expect us to take
    // what we can. But log it, because a field the UI thinks it saved and we
    // silently dropped is exactly the bug that's hard to spot from the UI.
    logger.warn(
      { contactId, dropped },
      'ghlContactWrite: ignored fields not writable via the contact endpoint'
    );
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      url: `/contacts/${encodeURIComponent(contactId)}`,
      data: patch
    });
    logger.info(
      { contactId, fields: Object.keys(patch) },
      'ghlContactWrite: contact updated in GHL'
    );
    // GHL ships both spellings; 'succeded' is their typo, kept for safety.
    return data?.contact || null;
  } catch (err) {
    throw translateContactError(err, { contactId });
  }
}

// The second write path in this app, and the first CREATE. Same "GHL is not
// us" shape as updateGhlContact: POST first, and Postgres gets the new
// contact only via the ContactCreate webhook that follows — never written
// here. A rep confirming an AI-proposed "create this contact" action sees
// the same round-trip delay an update does, for the same reason: GHL may
// normalise or reject fields we can't predict client-side.
//
// locationId is the ONLY field GHL's CreateContactDto requires (confirmed
// against GHL's own OpenAPI spec, ai-backend/docs/public/contacts/
// contacts.json — not an assumption). buildContactCreatePatch adds one more
// requirement on top, ours not GHL's: at least a name, phone or email, so a
// rep doesn't accidentally create a nameless, unreachable ghost contact.
export async function createGhlContact(install, input) {
  const { patch, dropped } = buildContactCreatePatch(input);

  if (dropped.length) {
    logger.warn(
      { dropped },
      'ghlContactWrite: ignored fields not writable via the contact endpoint'
    );
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: '/contacts/',
      data: { ...patch, locationId: install.location_id }
    });
    logger.info(
      { fields: Object.keys(patch) },
      'ghlContactWrite: contact created in GHL'
    );
    return data?.contact || null;
  } catch (err) {
    // No "not found" case on create — there is no existing contact to have
    // gone missing, so a 404 here would be GHL's own routing, not ours to
    // reinterpret as "the contact is gone".
    throw translateContactError(err, { allowNotFound: false });
  }
}

// DELETE /contacts/:id. GHL hard-deletes; our row is soft-deleted by the
// route through handleContactDelete, the same path the ContactDelete webhook
// takes, so a deletion from here and one from the CRM leave identical state.
export async function deleteGhlContact(install, contactId) {
  if (!contactId) throw new ContactWriteError('A contact id is required', { status: 400 });
  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/contacts/${encodeURIComponent(contactId)}`
    });
    return true;
  } catch (err) {
    throw translateContactError(err, { contactId });
  }
}
