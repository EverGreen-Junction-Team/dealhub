// notePatch.js — validate and map a note create/edit for GHL's note endpoints.
//
// Dependency-free, like contactPatch.js, taskPatch.js and tagPatch.js: no
// config, no database, no network, so the mapping can be unit-tested directly.
// This is where silent data loss would live — a mistyped key means an edit the
// UI reports as saved and GHL never receives.
//
// Endpoints (API version 2021-04-15), nested on the CONTACT:
//   POST   /contacts/{contactId}/notes
//   PUT    /contacts/{contactId}/notes/{id}
//   DELETE /contacts/{contactId}/notes/{id}

// The fields both write endpoints accept. Anything else is dropped rather
// than passed through — an unknown key makes GHL reject the whole request, so
// one typo would lose the valid fields alongside it.
//
// `businessId` is a PLAIN FIELD on PUT /contacts/{contactId}/notes/{noteId},
// not a relation. That matters: the note relations endpoint
// (PUT /notes/:id/relations) needs the `notes.write` scope this app does not
// hold, so the company link was unreachable — but this path is the one we
// already use for every note edit and only needs `contacts.write`. The DEAL
// link has no such field and still requires the relations endpoint.
const WRITABLE = new Set(['body', 'title', 'color', 'pinned', 'userId', 'businessId']);

// GHL's documented limits.
const MAX_BODY = 65000;
const MAX_TITLE = 255;

// #FFF or #FFAA00 — the two forms GHL documents. Anything else (a named
// colour, rgb(), an 8-digit hex with alpha) is rejected here rather than
// becoming an opaque 422 upstream.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class NoteWriteError extends Error {
  // `reason` is a machine-readable code for cases the message alone cannot
  // convey — 'reauth_required' vs 'not_installed' need different fixes and
  // used to share one message. Null for ordinary validation errors.
  constructor(message, { status = 400, field = null, reason = null } = {}) {
    super(message);
    this.name = 'NoteWriteError';
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Validate and normalise a note body before it reaches GHL.
 *
 * @param {object} input       client-supplied fields
 * @param {object} opts
 * @param {boolean} opts.create true for POST — `body` is then required
 * @returns {{ patch: object, dropped: string[] }}
 */
export function buildNotePatch(input = {}, { create = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new NoteWriteError('Nothing to save', { status: 400 });
  }

  const patch = {};
  const dropped = [];

  for (const [key, value] of Object.entries(input)) {
    if (!WRITABLE.has(key)) {
      dropped.push(key);
      continue;
    }
    // undefined means "not being changed". Null and '' are deliberate clears
    // and must survive — except for `body`, handled below.
    if (value === undefined) continue;

    if (key === 'pinned') {
      if (typeof value !== 'boolean') {
        throw new NoteWriteError('Pinned must be true or false', { field: 'pinned' });
      }
      patch.pinned = value;
      continue;
    }

    if (key === 'businessId') {
      // null or '' DETACHES the company. Both survive as null: GHL treats an
      // absent key as "unchanged", so a clear has to be sent explicitly or
      // the old company silently stays attached.
      if (value === null || value === '') {
        patch.businessId = null;
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) {
        throw new NoteWriteError(
          'That company is not valid', { field: 'businessId' }
        );
      }
      patch.businessId = value.trim();
      continue;
    }

    if (key === 'color') {
      // Clearing a colour is legitimate — the note goes back to the default.
      if (value === null || value === '') {
        patch.color = null;
        continue;
      }
      if (typeof value !== 'string' || !HEX.test(value.trim())) {
        throw new NoteWriteError(
          'Colour must be a hex value like #FFAA00', { field: 'color' }
        );
      }
      // Upper-cased so the same colour picked twice doesn't store as two
      // different strings and read as an edit when nothing changed.
      patch.color = value.trim().toUpperCase();
      continue;
    }

    if (key === 'userId') {
      if (value === null || value === '') {
        patch.userId = null;
        continue;
      }
      if (typeof value !== 'string') {
        throw new NoteWriteError('Author must be a user id', { field: 'userId' });
      }
      patch.userId = value.trim();
      continue;
    }

    // body and title
    if (typeof value !== 'string') {
      throw new NoteWriteError(
        `${key === 'body' ? 'The note' : 'Title'} must be text`, { field: key }
      );
    }
    const trimmed = value.trim();
    const max = key === 'body' ? MAX_BODY : MAX_TITLE;
    if (trimmed.length > max) {
      throw new NoteWriteError(
        key === 'body'
          ? `A note must be ${max} characters or fewer`
          : `Title must be ${max} characters or fewer`,
        { field: key }
      );
    }
    patch[key] = trimmed;
  }

  if (create) {
    if (!patch.body) {
      // The only genuinely required field. A note with a title and no body is
      // an empty record — GHL rejects it, and so should we, with wording that
      // says what to do.
      throw new NoteWriteError('A note needs something written in it', { field: 'body' });
    }
  } else {
    if (Object.keys(patch).length === 0) {
      throw new NoteWriteError('Nothing to update', { status: 400 });
    }
    // Emptying the body on an edit would leave a blank note in the timeline.
    // Deleting it is the honest action, and there's an endpoint for that.
    if ('body' in patch && patch.body === '') {
      throw new NoteWriteError(
        'A note cannot be emptied — delete it instead', { field: 'body' }
      );
    }
  }

  return { patch, dropped };
}
