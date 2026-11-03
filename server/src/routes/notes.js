import express from 'express';
import { contactLabel } from '../utils/contactLabel.js';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import {
  recordPendingDealLink, ENTITY_NOTE
} from '../services/pendingDealLink.js';
import { parseLimit, decodeCursor, keysetClause, orderBy, toPage } from '../utils/paginate.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import {
  createGhlNote, updateGhlNote, deleteGhlNote, NoteWriteError
} from '../services/ghlNoteWrite.js';
import {
  setNoteRelations, removeNoteRelations, assertRelationTargets, AssociationError
} from '../services/ghlAssociations.js';

export const notesRouter = express.Router();
notesRouter.use(requireSession);

// GET /api/notes — every note in the location, newest first.
//   ?q=<search>          matches note body
//   ?limit=N             default 200, max 1000
//
// Notes carry contact_id always; opportunity_id when resolvable from the
// inline relations array (see noteWriter). Both are joined so the frontend
// can render "note body, author, contact chip, deal chip" in one row.

notesRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const q = (req.query.q || '').toString().trim();
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const dealId = (req.query.dealId || '').toString().trim() || null;
  // Scope to one contact — the Notes tab's own filter. A note belongs to
  // exactly one contact, so this is a plain equality.
  const contactId = (req.query.contactId || '').toString().trim() || null;
  // Who WROTE the note. Called authorId rather than assignedTo because a note
  // is not assigned to anyone — it was written by someone, and labelling it
  // "owner" would invite a rep to expect reassignment that does not exist.
  const authorId = (req.query.authorId || '').toString().trim();
  // SORT DIRECTION on the date the note was WRITTEN.
  //
  // Always created_at_ghl (GHL's dateAdded), never imported_at: the import
  // timestamp is when WE synced the note, and on backfilled data every note
  // shares one — so sorting by it returned a year of notes in arbitrary order
  // while looking chronological.
  //
  // A "date synced" option briefly existed and is gone: it answers a question
  // about our sync rather than about the business, and offering it invited a
  // rep to pick the ordering that looks chronological and is not.
  const sort = req.query.sort === 'asc' ? 'asc' : 'desc';

  try {
    const rows = await withTenant(locationId, async (client) => {
      const params = [locationId];
      let qClause = '';
      if (q) {
        params.push(`%${q}%`);
        qClause = `AND n.body ILIKE $${params.length}`;
      }
      // Sort key must match the cursor's — see utils/paginate.js.
      // Scope to one deal — the Deal Hub's Notes section.
      let dealClause = '';
      if (dealId) {
        params.push(dealId);
        dealClause = `AND n.opportunity_id = $${params.length}`;
      }
      let contactClause = '';
      if (contactId) {
        params.push(contactId);
        contactClause = `AND n.contact_id = $${params.length}`;
      }
      // 'unassigned' is its own branch and pushes no param — a note synced
      // before author attribution existed has none, and those are worth being
      // able to find. Same shape as contacts, deals and tasks.
      let authorClause = '';
      if (authorId === 'unassigned') {
        authorClause = `AND n.author_user_id IS NULL`;
      } else if (authorId) {
        params.push(authorId);
        authorClause = `AND n.author_user_id = $${params.length}`;
      }
      // COALESCE, not a bare column: a note whose created_at_ghl never synced
      // would fall into the NULL tail and read as the oldest thing in the
      // account. Falling back to imported_at keeps it roughly in place.
      const TS = 'COALESCE(n.created_at_ghl, n.imported_at)';
      const ID = 'n.note_id';
      const keyset = keysetClause({ tsExpr: TS, idExpr: ID, cursor, dir: sort }, params);
      const sql = `
        SELECT
          n.note_id, n.body, n.contact_id, n.opportunity_id, n.business_id,
          b.name AS business_name,
          -- Attachment COUNT, computed in SQL rather than shipping raw_note.
          --
          -- GHL never sends attachments on a note webhook, so noteWriter
          -- fetches GET /notes/:id (the location-level v3 path — the
          -- contact-scoped one omits the field) and the whole response is
          -- stored in raw_note. The files are therefore already here; nothing
          -- needed a migration.
          --
          -- TWO CASES, and only two. raw_note holds either the API response
          -- (attachments is an array, possibly empty) or — when that fetch
          -- failed — the webhook payload, which never carries the field at
          -- all. So the value is an array or it is absent.
          --
          -- The typeof check therefore guards the ABSENT case: the -> operator
          -- yields SQL NULL there, jsonb_array_length(NULL) is NULL rather
          -- than 0, and a null count would render as a blank badge instead of
          -- no badge. COALESCE would do the same job; naming the type makes
          -- the contract explicit for the next reader.
          -- MAY BE 0 EVEN WHEN A NOTE HAS FILES.
          --
          -- Only the v3 /notes/:id response carries the attachments array,
          -- and we fetch the contact-scoped path instead — the v3
          -- path 401'd against our Version: 2021-07-28 header and halted a
          -- sub-account. So raw_note usually has no attachments array and
          -- this returns 0.
          --
          -- Kept rather than removed: the column reads correctly the moment
          -- the version handling is fixed, and the guard below means an
          -- absent field is 0 rather than an error. The badge simply does
          -- not render at 0, so nothing shows a wrong number.
          CASE WHEN jsonb_typeof(n.raw_note -> 'attachments') = 'array'
               THEN jsonb_array_length(n.raw_note -> 'attachments')
               ELSE 0
          END AS attachment_count,
          n.author_user_id, n.author_name,
          n.title, n.color, n.pinned,
          n.imported_at, n.updated_at, n.status, n.created_at_ghl,
          -- As in tasks.js: a nameless contact still needs a label, and
          -- email was not even selected here.
          c.first_name, c.last_name, c.email, c.phone, c.company_name,
          o.name AS opportunity_name, o.current_stage_name,
          -- Notes linked to THIS note (migration 054).
          (
            SELECT COALESCE(json_agg(json_build_object(
                     'id', nl.note_id,
                     -- Prefer the note's own title. Splitting the body's first
                     -- line was the only option before migration 058; it's the
                     -- fallback now, for notes whose author gave no title.
                     'label', COALESCE(
                                NULLIF(n2.title, ''),
                                NULLIF(split_part(n2.body, E'\n', 1), ''),
                                'Note')
                   ) ORDER BY nl.created_at), '[]'::json)
              FROM note_links nl
              JOIN notes n2
                ON n2.location_id = nl.location_id
               AND n2.note_id     = nl.note_id
               AND n2.status      = 'active'
             WHERE nl.location_id  = n.location_id
               AND nl.subject_type = 'note'
               AND nl.subject_id    = n.note_id
          ) AS note_chips
        FROM notes n
        LEFT JOIN contacts c
          ON c.location_id = n.location_id AND c.contact_id = n.contact_id
        LEFT JOIN opportunities o
          ON o.location_id = n.location_id AND o.opportunity_id = n.opportunity_id
        -- The business's NAME, for the card's "View BUSINESS" row. The id
        -- alone was sent and the row had nothing to label itself with.
        LEFT JOIN businesses b
          ON b.location_id = n.location_id AND b.business_id = n.business_id
        WHERE n.location_id = $1
          AND n.status = 'active'
          ${qClause}
          ${dealClause}
          ${contactClause}
           ${authorClause}
          ${keyset}
        ${orderBy({ tsExpr: TS, idExpr: ID, dir: sort })}
        LIMIT ${limit + 1}
      `;
      const r = await client.query(sql, params);
      return r.rows;
    });

    // The cursor MUST carry the column the query sorted by.
    //
    // Left on imported_at after the sort moved to created_at_ghl, and the
    // result was an infinite loop rather than a wrong order: every note in a
    // backfill shares one import timestamp, so the keyset never advanced and
    // the same ten rows came back for thirteen pages.
    // The cursor carries the column the query sorted by — one column now,
    // since direction changed but the date did not.
    const page = toPage(rows, limit, (n) => ({
      ts: n.created_at_ghl || n.imported_at,
      id: n.note_id
    }));
    res.json({
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      notes: page.rows.map((n) => ({
        id: n.note_id,
        body: n.body,
        // Real fields as of migration 058. Before it, the UI derived a heading
        // by splitting the body — which showed an author's actual title as body
        // text and invented a heading from the first sentence instead.
        title: n.title || null,
        color: n.color || null,
        pinned: n.pinned === true,
        author: n.author_name || null,
        authorUserId: n.author_user_id,
        contact: n.contact_id ? {
          id: n.contact_id,
          firstName: n.first_name,
          lastName: n.last_name,
          // NEVER null — see contactLabel. A nameless contact rendered an
          // empty chip, so a note's contact link was invisible.
          name: contactLabel(n),
          email: n.email,
          phone: n.phone
        } : null,
        noteChips: (n.note_chips || []).map((c) => ({
          id: c.id,
          label: String(c.label || 'Note').slice(0, 40)
        })),
        deal: n.opportunity_id ? {
          id: n.opportunity_id,
          name: n.opportunity_name,
          stage: n.current_stage_name
        } : null,
        // Flat ids as well as the nested `deal` object. The editor's Deal and
        // Company pickers bind to a scalar id, and without these an already
        // linked note opened for editing showed "Not linked" — then saving
        // treated that as a deliberate detach.
        opportunityId: n.opportunity_id,
        businessId: n.business_id,
        // The linked business as an object, like `deal` above — id for the
        // open handler, name for the row.
        business: n.business_id ? { id: n.business_id, name: n.business_name || null } : null,
        // A count, not the files. GHL's attachment URLs are signed and expire,
        // so serving them from our stored copy would hand out links that may
        // already be dead — and the ask was for a count.
        attachmentCount: Number(n.attachment_count || 0),
        // Prefer GHL's own dateAdded — imported_at is when we first synced the
        // note, which for a backfilled deal is all the same timestamp and makes
        // a Newest/Oldest sort meaningless.
        createdAt: n.created_at_ghl || n.imported_at,
        updatedAt: n.updated_at
      })),
      totalCount: page.rows.length
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/notes failed');
    next(err);
  }
});

// ── Writes ─────────────────────────────────────────────────────────────
//
// GHL's note endpoints are nested on the contact
// (/contacts/{contactId}/notes/...), but clients hold OUR note id and know
// nothing about which contact owns it. So every write resolves the contact from
// Postgres under RLS first.
//
// That resolution is a security boundary, not a convenience: a contactId sent
// from the browser would let a caller aim a write at a contact in another
// location. The only contact id we use is the one our own row carries, read
// inside withTenant.
//
// Notes have a NoteUpdate webhook, so — unlike tasks — nothing is written
// locally on create or edit. noteWriter.js owns the row.

async function resolveNoteForWrite(locationId, noteId) {
  const row = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT note_id, contact_id
         FROM notes
        WHERE location_id = $1 AND note_id = $2
          AND status = 'active' AND deleted_at IS NULL
        LIMIT 1`,
      [locationId, noteId]
    );
    return rows[0] || null;
  });

  if (!row) {
    throw new NoteWriteError('That note no longer exists', { status: 404 });
  }
  if (!row.contact_id) {
    throw new NoteWriteError(
      "This note isn't linked to a contact, so it can't be changed here — " +
      'notes are edited through the contact they belong to.',
      { status: 400, field: 'contactId' }
    );
  }

  const install = await getActiveInstall(locationId);
  if (!install) {
    // reauth_required and uninstalled need different fixes (clear a flag vs
    // reinstall the app) and shared one message. See explainInactiveInstall.
    const { message, reason } = await explainInactiveInstall(locationId);
    throw new NoteWriteError(message, { status: 409, reason });
  }
  return { install, contactId: row.contact_id };
}

function sendNoteError(res, err, next, ctx) {
  // Both carry a status and a field. Without the AssociationError branch a
  // validation failure on a relation (bad objectKey, missing recordId) became a
  // 500 with no field, so the UI could not point at the offending control.
  if (err instanceof NoteWriteError || err instanceof AssociationError) {
    return res.status(err.status).json({ error: err.message, field: err.field || null, ...(err.reason ? { reason: err.reason } : {}) });
  }
  // A 401 that did NOT condemn the install (scopeOptional). It is a missing
  // scope or a version mismatch on ONE endpoint, not a dead token — so say
  // what it is. Without this branch it fell through to `internal_error` with
  // a 500, which tells the rep nothing and looks like the app is broken.
  //
  // 502: the request was valid, our upstream refused it. Not 401 — that would
  // make the dashboard bounce the rep to a re-login they do not need.
  if (err?.code === 'GHL_SCOPE_MISSING') {
    logger.error(
      { err, ...ctx },
      'note relation write refused — the marketplace app is missing the OAuth scope for this endpoint, '
      + 'or the endpoint needs a different API version'
    );
    return res.status(502).json({
      error: 'Your CRM refused this change — the app is not authorised for it. '
        + 'This needs the connection re-approved with the right permissions.',
      field: null,
      code: 'scope_missing'
    });
  }
  logger.error({ err, ...ctx }, 'note write failed');
  return next(err);
}

// POST /api/notes — write a note on a contact.
//
// Body: { contactId, body, title?, color?, pinned?, userId? }
//
// contactId comes from the body here because there's no note row to resolve it
// from yet. It's checked against our own contacts table under RLS, so a contact
// in another location fails as "not found" rather than reaching GHL.
//
// The row is not inserted locally: NoteCreate owns that, including the
// opportunity attribution only noteWriter knows how to do.
notesRouter.post('/', async (req, res, next) => {
  const locationId = req.locationId;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of note fields' });
  }
  // Only opportunityId is pulled out. It is not a note field, and it is not
  // sent anywhere on this path — see the note at the end of this handler.
  //
  // businessId STAYS IN `fields` and goes to GHL in the create body.
  // POST /contacts/:id/notes accepts it, the same as the PUT — so the company
  // is set by the note write itself and needs no follow-up call. It was
  // briefly routed through PUT /notes/:id/relations instead, on the wrong
  // assumption that only the PUT took it; that call needs the `notes.write`
  // scope this app does not hold, so it 401'd and warned the rep the company
  // had not been linked when the simpler path would just have worked.
  const { contactId, opportunityId, ...fields } = body;
  if (!contactId) {
    return res.status(400).json({
      error: 'A note needs a contact — notes are stored against the contact',
      field: 'contactId'
    });
  }

  try {
    const exists = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM contacts
          WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [locationId, contactId]
      );
      return rows.length > 0;
    });
    if (!exists) {
      return res.status(404).json({ error: 'That contact no longer exists', field: 'contactId' });
    }

    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }

    const note = await createGhlNote(install, contactId, fields);

    // Park the rep's deal choice for NoteCreate to pick up.
    //
    // It cannot go to GHL (note relations need the notes.write scope this app
    // does not hold) and it cannot go on our row, which NoteCreate has not
    // inserted yet. Without this the webhook fell back to the attribution
    // rule and filed the note against the contact's earliest OPEN deal —
    // right when there is only one, silently wrong when there are two.
    //
    // Recorded even when no deal was picked: "created with no deal" is a
    // decision too, and must stop the rule guessing one.
    //
    // Deliberately not awaited for correctness of the response: this never
    // throws, and the note is already saved either way.
    await recordPendingDealLink(
      locationId, ENTITY_NOTE, note?.id, opportunityId || null, req.session?.userId || null,
      'app'
    );

    // No relations call on create, for either link.
    //
    //   company → sent in the create body above. POST accepts businessId.
    //   deal    → cannot be sent. It needs PUT /notes/:id/relations and the
    //             `notes.write` scope this app does not hold.
    //
    // The deal the rep picked is therefore DROPPED here. NoteCreate inserts
    // the row and resolves the deal itself via resolveOppForContact, which
    // returns the contact's earliest open deal — not necessarily the one
    // picked. On a contact with one open deal those agree, which is why this
    // looked correct in testing; with two, the note is filed against the
    // wrong deal with no error shown.
    //
    // Fixing that means recording the pick for the webhook to read (see
    // services/noteWriter.js). Until then the relations call is not a
    // workaround for it — that call 401s, so it only ever produced a warning
    // about a link the webhook went on to make anyway.
    res.status(201).json({ note, source: 'ghl', relationError: null });
  } catch (err) {
    sendNoteError(res, err, next, { locationId, contactId });
  }
});

// PATCH /api/notes/:id — edit the text, title, colour or pinned state.
//
// Send only what changed. PATCH rather than PUT because that's what it is:
// GHL's endpoint is a PUT accepting a partial body, which is a PATCH by any
// other name.
notesRouter.patch('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const noteId = req.params.id;

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of fields to change' });
  }

  try {
    const { install, contactId } = await resolveNoteForWrite(locationId, noteId);
    const note = await updateGhlNote(install, { contactId, noteId }, req.body);
    res.json({ note, source: 'ghl' });
  } catch (err) {
    sendNoteError(res, err, next, { locationId, noteId });
  }
});

// PUT /api/notes/:id/relations
//   body: { opportunityId?, businessId?, remove?: boolean }
//
// Attach or detach the deal and the company a note belongs to.
//
// THE COMPANY NO LONGER NEEDS THIS ROUTE. `businessId` is a plain field on
// PUT /contacts/{contactId}/notes/{noteId}, so PATCH /api/notes/:id sets it in
// the same request as the body and title, using `contacts.write` — the scope
// we already hold. That matters because this route's endpoint needs
// `notes.write`, which the app does not have.
//
// Left here for the DEAL link, which has no equivalent field, and for a caller
// that wants to change a link without touching the note. Prefer PATCH for the
// company.
//
// Its own route rather than part of PATCH /:id, because these are not note
// fields: they go to a different GHL endpoint, they are additive/subtractive
// rather than a value being set, and buildNotePatch rejects anything it does
// not recognise. Folding them in would mean one request that half-succeeds.
//
// TWO GHL BEHAVIOURS THE CALLER INHERITS:
//
//   • The opportunity cap is ONE, so attaching a deal to a note that already
//     has a different one REPLACES it silently. That is the intent — a note is
//     about one deal — but it is a deletion the caller did not ask for, so the
//     service logs the overridden link.
//
//   • A note cannot be left with zero relations. Every note written through
//     this app has a contact, so removing the deal or company link is always
//     safe; a note with no contact would 400 and is rejected earlier by
//     resolveNoteForWrite with a clearer message.
notesRouter.put('/:id/relations', async (req, res, next) => {
  const locationId = req.locationId;
  const noteId = req.params.id;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of relations to change' });
  }
  const { opportunityId, businessId, remove = false } = body;
  if (!opportunityId && !businessId) {
    return res.status(400).json({
      error: 'Name a deal or a company to link',
      field: 'opportunityId'
    });
  }

  try {
    // Also proves the note is ours: resolveNoteForWrite reads under RLS, so a
    // note in another location 404s before any GHL call is made.
    const { install } = await resolveNoteForWrite(locationId, noteId);

    // The target records are checked against OUR tables first. GHL validates
    // them too, but its error is generic — this names which one is wrong and
    // costs one local query.
    await assertRelationTargets(locationId, { opportunityId, businessId });

    const note = remove
      ? await removeNoteRelations(install, noteId, { opportunityId, businessId })
      : await setNoteRelations(install, noteId, { opportunityId, businessId });

    res.json({ note, source: 'ghl' });
  } catch (err) {
    sendNoteError(res, err, next, { locationId, noteId });
  }
});

// ── PUT /api/notes/:id/local-links ─────────────────────────────────────
//
// Set a note's DEAL in our database only.
//
// The company is not here on purpose: `businessId` is a plain field on
// PUT /contacts/{contactId}/notes/{noteId}, so it saves to GHL through the
// ordinary note patch and stays in step upstream. Only the deal is stuck —
// it needs PUT /notes/:id/relations, which requires the `notes.write` scope
// this app does not hold.
//
// If that scope is granted later, prefer the real endpoint and retire this.
//
// Body: { opportunityId } — null clears it. A note has ONE deal (GHL's
// NOTE_OPPORTUNITY cap is 1), so this sets rather than appends.
notesRouter.put('/:id/local-links', async (req, res, next) => {
  const locationId = req.locationId;
  const noteId = req.params.id;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of links to set' });
  }
  if (!('opportunityId' in body)) {
    return res.status(400).json({
      error: 'Name the deal to file this note against, or null to clear it',
      field: 'opportunityId'
    });
  }
  const opportunityId = body.opportunityId || null;

  try {
    const result = await withTenant(locationId, async (client) => {
      const n = await client.query(
        `SELECT note_id, contact_id FROM notes
          WHERE location_id = $1 AND note_id = $2 AND status = 'active'`,
        [locationId, noteId]
      );
      if (!n.rowCount) return { error: 'That note no longer exists', status: 404 };

      if (opportunityId) {
        // The deal must EXIST **and** the note's contact must be on it.
        //
        // Existence alone let a note be filed against any deal in the
        // location, including one belonging to a different customer. The
        // picker is scoped to the contact's deals, so the UI never offers a
        // wrong one — but the UI is not the guard: this route takes an id
        // from the client.
        //
        // PRIMARY **or** additional contact, matching the message mapping
        // guard in routes/deals.js. An architect is on a deal through
        // opportunity_contacts without being its primary and their notes
        // belong to it, so testing opportunities.contact_id alone would
        // reject exactly the case the picker correctly offered.
        const o = await client.query(
          `SELECT 1 FROM opportunities o
            WHERE o.location_id = $1 AND o.opportunity_id = $2
              AND o.is_deleted = false AND o.deleted_at IS NULL
              AND (
                    o.contact_id = $3
                    OR EXISTS (
                         SELECT 1 FROM opportunity_contacts oc
                          WHERE oc.location_id    = o.location_id
                            AND oc.opportunity_id = o.opportunity_id
                            AND oc.contact_id     = $3
                            AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
                       )
                  )`,
          [locationId, opportunityId, n.rows[0].contact_id]
        );
        if (!o.rowCount) {
          return {
            error: 'That deal is not on this contact, so the note cannot be filed against it',
            status: 400, field: 'opportunityId'
          };
        }
      }

      await client.query(
        // deal_set_manually marks this as a DECISION, not a guess.
        //
        // It is what makes an unlink stick: opportunity_id = NULL alone reads
        // as "not decided yet" and the attribution rule refills it on the next
        // sync. With the flag, NULL means "deliberately no deal" and the rule
        // leaves it alone. Set on every write here, including the clear.
        `UPDATE notes
            SET opportunity_id    = $3,
                deal_set_manually = true,
                updated_at        = now()
          WHERE location_id = $1 AND note_id = $2`,
        [locationId, noteId, opportunityId]
      );
      return { ok: true };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error, field: result.field || null });
    }
    logger.info(
      { locationId, noteId, opportunityId },
      'note deal set locally (GHL note relations need the notes.write scope)'
    );
    res.json({ ok: true, source: 'local' });
  } catch (err) {
    logger.error({ err, locationId, noteId }, 'PUT /api/notes/:id/local-links failed');
    next(err);
  }
});

// DELETE /api/notes/:id
//
// GHL has a restore endpoint, but it is NOT available over OAuth
// (restrictOAuthChannel), so a delete here is final as far as this app is
// concerned. Our row is soft-deleted and keeps the text, which is the only
// recovery path we can offer — worth knowing before wiring a bulk delete.
notesRouter.delete('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const noteId = req.params.id;

  try {
    const { install, contactId } = await resolveNoteForWrite(locationId, noteId);
    await deleteGhlNote(install, { contactId, noteId });
    res.json({ ok: true, id: noteId });
  } catch (err) {
    sendNoteError(res, err, next, { locationId, noteId });
  }
});
