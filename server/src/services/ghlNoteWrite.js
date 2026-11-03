// ghlNoteWrite.js — create, edit and delete notes in GoHighLevel.
//
// FLOW — the contacts pattern, not the tasks one.
//
// Notes DO have a NoteUpdate webhook (see routes/webhooks.js NOTE_TYPES), so
// unlike tasks this service does NOT need to write Postgres itself: GHL applies
// the change, fires NoteCreate/NoteUpdate/NoteDelete, and noteWriter.js writes
// our row from the payload it fetches back. One path to the row, no chance of
// the two disagreeing.
//
// The one thing we do locally is the DELETE soft-delete, mirroring
// ghlTaskWrite: NoteDelete fires too, but a note that stays on screen after the
// rep deleted it looks like a failed save, and the webhook takes a moment.
//
// PINNED NOTES. GHL allows at most TWO pinned notes per contact and rejects the
// third. That's a limit worth catching in a readable way rather than surfacing
// as a bare 422, so pinning checks the count first — see checkPinnedRoom.
//
// Every endpoint is nested on the CONTACT (/contacts/{contactId}/notes/...), so
// a note whose contact_id is NULL cannot be written through this API. Migration
// 017 allows that column to be null; callers get a clear message rather than a
// confusing 404 from GHL.

import { ghlRequest } from './ghlClient.js';
import { rejectionMessage, logRejection } from './ghlRejection.js';
import { rawQuery } from '../db.js';
import { buildNotePatch, NoteWriteError } from './notePatch.js';
import { logger } from '../utils/logger.js';

export { buildNotePatch, NoteWriteError };

// GHL's cap. Not configurable — it's their rule, documented on Create Note.
export const MAX_PINNED_PER_CONTACT = 2;

function translateGhlError(err, { noteId = null, contactId = null, verb }) {
  const status = err.response?.status;
  const body = err.response?.data;

  if (status === 401 || status === 403) {
    return new NoteWriteError(
      'This app cannot change notes yet — the contacts.write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (status === 404) {
    return new NoteWriteError(
      'That note no longer exists, or it belongs to a different contact',
      { status: 404 }
    );
  }
  if (status === 422 || status === 400) {
    const detail = body?.message || body?.error
      || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);
    // GHL's own pinned-limit rejection, in case checkPinnedRoom was bypassed
    // (a note pinned in the GHL UI between our count and our write).
    if (detail && /pin/i.test(detail)) {
      return new NoteWriteError(
        `Only ${MAX_PINNED_PER_CONTACT} notes can be pinned to a contact — unpin one first`,
        { status: 422, field: 'pinned' }
      );
    }
    // GHL's own text is LOGGED, never shown — services/ghlRejection.js
    // explains why: it names a field for a validation error, but a raw
    // record id for a missing one, and the whole sales team sees these.
    logRejection('ghlNoteWrite', { status, detail, body });
    const rej = rejectionMessage('note', detail);
    return new NoteWriteError(rej.message, { status: rej.status, detail });
  }
  logger.error(
    { err, status, noteId, contactId, body },
    `ghlNoteWrite: ${verb} failed`
  );
  return new NoteWriteError(`Could not ${verb} the note — try again`, { status: 502 });
}

function requireContactId(contactId) {
  if (!contactId) {
    throw new NoteWriteError(
      "This note isn't linked to a contact, so it can't be changed here — " +
      'notes are edited through the contact they belong to.',
      { status: 400, field: 'contactId' }
    );
  }
}

/**
 * Refuse a pin that would exceed GHL's limit, with a message that says what to
 * do about it.
 *
 * Counted from OUR rows rather than asking GHL: it's one local query instead of
 * a round trip, and the number only has to be right often enough to give a
 * better error than a 422. If it's stale — someone pinned a note in the GHL UI
 * a moment ago — GHL still rejects the write and translateGhlError turns that
 * into the same sentence. This is a courtesy, not the enforcement.
 *
 * `excludeNoteId` skips the note being edited, so re-saving an already-pinned
 * note doesn't count itself as a third.
 */
async function checkPinnedRoom(locationId, contactId, excludeNoteId = null) {
  const { rows } = await rawQuery(
    `SELECT count(*)::int AS n
       FROM notes
      WHERE location_id = $1
        AND contact_id  = $2
        AND pinned      = true
        AND status      = 'active'
        AND deleted_at IS NULL
        AND ($3::text IS NULL OR note_id <> $3)`,
    [locationId, contactId, excludeNoteId]
  );
  const pinned = rows[0]?.n ?? 0;
  if (pinned >= MAX_PINNED_PER_CONTACT) {
    throw new NoteWriteError(
      `Only ${MAX_PINNED_PER_CONTACT} notes can be pinned to a contact — unpin one first`,
      { status: 422, field: 'pinned' }
    );
  }
}

/**
 * POST /contacts/{contactId}/notes
 *
 * The row is NOT inserted here — NoteCreate owns that, including the
 * opportunity attribution (GHL's relations array, then the attribution engine)
 * that only noteWriter knows how to do.
 */
export async function createGhlNote(install, contactId, input) {
  requireContactId(contactId);
  const { patch, dropped } = buildNotePatch(input, { create: true });

  if (dropped.length) {
    logger.warn({ contactId, dropped }, 'ghlNoteWrite: ignored non-writable fields');
  }
  if (patch.pinned === true) {
    await checkPinnedRoom(install.location_id, contactId);
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: `/contacts/${encodeURIComponent(contactId)}/notes`,
      data: patch
    });
    const note = data?.note || null;
    logger.info(
      { contactId, noteId: note?.id, fields: Object.keys(patch) },
      'ghlNoteWrite: note created'
    );
    return note;
  } catch (err) {
    throw translateGhlError(err, { contactId, verb: 'create' });
  }
}

/**
 * PUT /contacts/{contactId}/notes/{noteId}
 *
 * Send only the changed fields. NoteUpdate fires and noteWriter refreshes our
 * row, so nothing is written locally here.
 */
export async function updateGhlNote(install, { contactId, noteId }, input) {
  requireContactId(contactId);
  if (!noteId) throw new NoteWriteError('Which note?', { status: 400 });

  const { patch, dropped } = buildNotePatch(input, { create: false });
  if (dropped.length) {
    logger.warn({ noteId, dropped }, 'ghlNoteWrite: ignored non-writable fields');
  }
  if (patch.pinned === true) {
    // Exclude this note: re-saving one that's already pinned must not count
    // itself against the limit.
    await checkPinnedRoom(install.location_id, contactId, noteId);
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      url: `/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`,
      data: patch
    });
    // MIRROR THE CHANGE LOCALLY, as the delete path below does and for the
    // same reason: NoteUpdate fires, but it takes a moment, and until it
    // lands every read still returns the OLD row.
    //
    // The visible bug was an off-by-one on the title. A rep renamed a note to
    // "test1" and the row showed it (the editor passes what it applied), but
    // reopening read the note back from OUR table, which GHL's webhook had
    // not reached yet — so the box held the previous name. Rename again to
    // "test2" and they saw "test1". Every edit appeared one behind.
    //
    // Only the columns this patch actually set, so a title-only edit cannot
    // blank a body. updated_at is deliberately NOT touched: the daily sync
    // and the webhook use it to decide what is stale, and claiming a write
    // time our row has not really settled at would hide the webhook's own
    // correction.
    //
    // Best-effort. GHL has accepted the change; a local mirror that fails
    // must not report the save as failed — the webhook still repairs it.
    const sets = [];
    const vals = [install.location_id, noteId];
    for (const [col, key] of [['body', 'body'], ['title', 'title'], ['color', 'color'], ['pinned', 'pinned']]) {
      if (key in patch) { vals.push(patch[key]); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length) {
      try {
        await rawQuery(
          `UPDATE notes SET ${sets.join(', ')}
            WHERE location_id = $1 AND note_id = $2 AND deleted_at IS NULL`,
          vals
        );
      } catch (err) {
        logger.error(
          { err, noteId, contactId },
          'ghlNoteWrite: updated in GHL but the local row did not follow'
        );
      }
    }

    logger.info(
      { noteId, contactId, fields: Object.keys(patch) },
      'ghlNoteWrite: note updated'
    );
    return data?.note || null;
  } catch (err) {
    throw translateGhlError(err, { noteId, contactId, verb: 'update' });
  }
}

/**
 * DELETE /contacts/{contactId}/notes/{noteId}
 *
 * Soft-deletes locally, matching what NoteDelete does — the row stays for
 * history and every read filters on status/deleted_at.
 *
 * GHL's response is { succeeded: true, succeded: true } — both spellings, the
 * second being their typo. We don't read either: a non-throwing response is the
 * success signal.
 */
export async function deleteGhlNote(install, { contactId, noteId }) {
  requireContactId(contactId);
  if (!noteId) throw new NoteWriteError('Which note?', { status: 400 });

  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`
    });
  } catch (err) {
    throw translateGhlError(err, { noteId, contactId, verb: 'delete' });
  }

  // NoteDelete fires too, but it takes a moment, and a note still on screen
  // after the rep deleted it looks like a failed save. A local failure here is
  // NOT reported as a failed delete — GHL has already accepted it.
  try {
    await rawQuery(
      `UPDATE notes
          SET status = 'deleted', deleted_at = now(), updated_at = now()
        WHERE location_id = $1 AND note_id = $2 AND deleted_at IS NULL`,
      [install.location_id, noteId]
    );
  } catch (err) {
    logger.error(
      { err, noteId, contactId },
      'ghlNoteWrite: deleted in GHL but the local row did not update'
    );
  }

  logger.info({ noteId, contactId }, 'ghlNoteWrite: note deleted');
  return true;
}
