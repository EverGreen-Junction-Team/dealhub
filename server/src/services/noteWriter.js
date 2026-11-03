// noteWriter.js — handles NoteCreate / NoteUpdate / NoteDelete webhooks.
// Writes to the `notes` table (migration 017).
//
// Attribution order for opportunity_id:
//   1. GHL's own relations array (returned by GET /contacts/.../notes/{id}).
//      This is the authoritative source — if GHL says the note is on opp X,
//      we take it verbatim.
//   2. Shared attribution engine (opportunity_contacts + rules) as fallback
//      when GHL didn't send a relation. Same logic messages and tasks use,
//      so notes on FOLLOWER contacts still attribute correctly.
//   3. OpportunityUpdate safety-net (associationRefresher) — the final
//      catch-all that verifies against GHL periodically and fills any gap.
//
// Notes are REP-AUTHORED and never treated as customer evidence for AI.

import { rawQuery } from '../db.js';
import { ghlRequest } from './ghlClient.js';
import { ensureContactExists } from './contactStub.js';
import { resolveOppForContact } from './attributionEngine.js';
import {
  consumePendingDealLink, ENTITY_NOTE
} from './pendingDealLink.js';
import { logger } from '../utils/logger.js';

function pickNoteFields(payload) {
  return {
    noteId: payload.id || payload.noteId,
    contactId: payload.contactId || null,
    authorUserId: payload.userId || null,
    body: payload.body || payload.bodyText || null,
    // title/color/pinned were stored only inside raw_note until migration 058.
    // They must be promoted here too, or a title saved through our own editor
    // would be dropped by the NoteUpdate webhook that follows it.
    //
    // An empty title becomes NULL rather than '': the UI falls back to deriving
    // a heading from the body when there's no title, and a blank string would
    // suppress that fallback while showing nothing.
    // Same absent-vs-cleared rule as `color` below — a webhook that omits the
    // field must not wipe a title the rep set in GHL.
    title: Object.prototype.hasOwnProperty.call(payload, 'title')
      ? ((payload.title || '').trim() || null)
      : undefined,
    // hasOwnProperty, not `|| null`. ABSENT and CLEARED are different:
    //
    //   • The API response (GET /notes/:id) carries `color`, so a rep who
    //     removed it sends an empty string and we must clear ours.
    //   • The WEBHOOK payload does not carry it at all — the NoteUpdate body
    //     is just { id, body, contactId, dateAdded }. Treating that absence
    //     as "cleared" wiped the colour on every note edited in GHL, and on
    //     every note at all once the API fetch started failing.
    //
    // undefined here means "not sent", which the upsert below skips.
    color: Object.prototype.hasOwnProperty.call(payload, 'color')
      ? ((payload.color || '').trim() || null)
      : undefined,
    // pinned is DIFFERENT, deliberately: GHL omits the field on an unpinned
    // note rather than sending false, so absent genuinely does mean false
    // here. It keeps its outright assignment; the $17 flag is always true.
    pinned: payload.pinned === true,
    createdAtGhl: payload.dateAdded ? new Date(payload.dateAdded) : null,
    updatedAtGhl: payload.dateUpdated ? new Date(payload.dateUpdated) : null,
    raw: payload
  };
}

async function resolveAuthorName(locationId, userId) {
  if (!userId) return null;
  const { rows } = await rawQuery(
    `SELECT name FROM users WHERE location_id = $1 AND user_id = $2 LIMIT 1`,
    [locationId, userId]
  );
  return rows[0]?.name || null;
}

// Fetch the full note from GHL and extract the linked opportunity from
// note.relations. Returns { opportunityId, businessId, fullPayload } — never
// throws; on any error every id is null and the caller falls back to the
// webhook payload alone.
async function fetchNoteWithRelations(install, contactId, noteId) {
  // BOTH required again: contactId is back in the URL path, so calling
  // without it would request /contacts/undefined/notes/:id.
  if (!contactId || !noteId) {
    return { opportunityId: null, businessId: null, fetched: false, fullPayload: null };
  }
  try {
    // BACK TO the contact-scoped path.
    //
    // I switched this to the location-level `/notes/:id` to pick up
    // `attachments`, and it 401'd on every note — which halted the whole
    // sub-account and lost webhook events while the flag was set.
    //
    // The cause was almost certainly the VERSION HEADER, not a scope:
    // ghlClient sends `Version: 2021-07-28` (config.ghl.apiVersion) for every
    // request, and `/notes/:id` is a v3 endpoint expecting `Version: v3`. A v3
    // path called with a v1 header is rejected, and GHL answers 401 rather
    // than 400 — which is what made it look like an auth failure.
    //
    // Reverting rather than adding a per-request version override: this path
    // works today, it is what every other note read uses, and the only thing
    // the v3 path bought was the attachment list. Attachments can come back
    // once the version handling is deliberate rather than a special case
    // bolted onto one call.
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`,
      // SCOPE-OPTIONAL, kept even though this path is expected to work.
      //
      // It is not about this endpoint's scope any more — it is about blast
      // radius. A 401 from ONE note fetch should never mark an install
      // reauth_required, because that halts every sync for the location and
      // (until the webhook fix) discarded inbound events too. A dead token
      // 401s everything; one endpoint failing proves far less than that.
      //
      // This is the tasksSync lesson applied preventively rather than after
      // the fact.
      scopeOptional: true
    });
    const note = data?.note || data;
    const rels = Array.isArray(note?.relations) ? note.relations : [];
    const pick = (key) => rels.find((r) => r?.objectKey === key)?.recordId || null;
    return {
      opportunityId: pick('opportunity'),
      // The company the note is filed against — NOTE_BUSINESS_ASSOCIATION.
      // Was being dropped: this function only ever looked for 'opportunity',
      // so a note associated with a business in GHL lost that link entirely.
      //
      // FIRST ONLY. The note↔business cap is 1000, so GHL can hold several,
      // but notes.business_id is scalar (see migration 061) and the UI offers
      // one. Taking the first is the same narrowing, made explicit here rather
      // than looking like an oversight.
      //
      // ALSO read as a PLAIN FIELD. `businessId` is writable directly on
      // PUT /contacts/{contactId}/notes/{noteId}, so a company set that way
      // comes back on the note object rather than in `relations` — and this
      // function, looking only at `relations`, reported null. The PATCH
      // returned 200, GHL stored it, and reopening the editor still showed
      // "Not linked to a company" because our row was never updated.
      //
      // Relations first: if GHL reports both, the association is the richer
      // source and they should agree anyway.
      businessId: pick('business')
        || (typeof note?.businessId === 'string' && note.businessId ? note.businessId : null),
      // Distinguishes "GHL says no company" from "we could not ask" — the
      // caller needs that to know whether a null may clear the column.
      fetched: true,
      fullPayload: note || null
    };
  } catch (err) {
    // 404 = note was deleted between webhook + our fetch. Non-fatal;
    // OpportunityUpdate will catch the linkage later if the note lives on.
    const status = err.response?.status;
    if (err.code === 'GHL_SCOPE_MISSING') {
      // A 401 that did NOT condemn the install. Whatever the cause — scope,
      // version header, a per-location restriction — the note itself is still
      // written from the webhook payload, which carries the body. What is
      // lost is enrichment: the opportunity/business relations and the author,
      // which only the API response provides.
      //
      // warn, not info: the earlier version logged this at info as a "known
      // benign gap", and that judgement was wrong — it hid a real failure for
      // a full deploy cycle. If this fires, something needs looking at.
      logger.warn(
        { err, contactId, noteId },
        'noteWriter: note fetch 401 — writing from the webhook payload, relations and author will be missing'
      );
    } else if (status === 404) {
      logger.debug({ contactId, noteId }, 'noteWriter: note fetch 404 (deleted between events?)');
    } else {
      // `err`, not `err.message` — the serialiser needs the Error itself to
      // reach GHL's response body, status and scopes. Passing the string is
      // why this logged {"err":{"type":"Error"}} and told us nothing about a
      // 401 that halted the location.
      logger.warn({ err, contactId, noteId, status }, 'noteWriter: note fetch failed');
    }
    return { opportunityId: null, businessId: null, fetched: false, fullPayload: null };
  }
}

// --- NoteCreate + NoteUpdate --------------------------------------------
// Same UPSERT path — both create fresh state on the row. The only difference
// is NoteUpdate is expected to change body/updated_at, whereas NoteCreate
// is the first sighting.

async function upsertFromEvent(install, event, { isDelete = false } = {}) {
  const locationId = install.location_id;
  const n = pickNoteFields(event);
  if (!n.noteId) {
    logger.warn({ event }, 'noteWriter: event missing note id — dropping');
    return;
  }

  // On create/update, fetch the note to get inline relations + any fields
  // the webhook payload doesn't carry. On delete, skip the API call —
  // the note is gone and the row is just being soft-deleted.
  //
  // GHL's NoteCreate webhook payload sometimes omits `userId` (the author).
  // The full note fetched via GET /contacts/.../notes/{id} always carries it
  // as `note.userId`. Prefer the API response for author resolution, fall
  // back to the webhook payload only if the API fetch failed.
  let opportunityId = null;
  let businessId = null;
  // Did we actually get an answer from GHL? A failed fetch reports null for
  // every link, and that absence must not be mistaken for a removal.
  let relationsFetched = false;
  let mergedRaw = n.raw;
  let authorUserId = n.authorUserId;
  let attributionRule = null;
  let attributionStatus = null;
  // TRUE when the deal on this note came from a person, not the rule — a
  // pick made at create time. Written to notes.deal_set_manually so the rule
  // never revises it (migration 068).
  let setDealManually = false;
  if (!isDelete) {
    const { opportunityId: oppId, businessId: bizId, fetched, fullPayload } =
      await fetchNoteWithRelations(install, n.contactId, n.noteId);
    opportunityId = oppId;
    businessId = bizId;
    relationsFetched = fetched;
    if (fullPayload) {
      mergedRaw = fullPayload;

      // RE-PICK title, color and pinned FROM THE API RESPONSE.
      //
      // This is why colours were never stored. pickNoteFields runs on the
      // WEBHOOK payload, which carries only
      //   { id, body, contactId, dateAdded }
      // — no colour. The absent-vs-cleared guard then correctly reported
      // "not sent" and the upsert preserved the old value, so a colour set in
      // GHL never landed. Confirmed against a live row: GHL returned
      // color "#d3f8df" and our column held null.
      //
      // The API response carries all three (its keys are body, bodyText,
      // color, contactId, dateAdded, id, pinned, relations, title, userId),
      // so it is the authority whenever the fetch succeeds — the same reason
      // authorUserId is taken from it below.
      //
      // Re-running pickNoteFields keeps ONE definition of how each field is
      // normalised: trimming, empty-to-null, and the hasOwnProperty check
      // that distinguishes cleared from absent.
      const fromApi = pickNoteFields(fullPayload);
      n.title = fromApi.title;
      n.color = fromApi.color;
      n.pinned = fromApi.pinned;

      // API response wins when present — the webhook payload can be sparse.
      authorUserId = fullPayload.userId || authorUserId;
    }
    // GHL didn't send a relation? Fall back to the shared attribution engine
    // (opportunity_contacts + rules). Same logic messages and tasks use — so
    // notes on a follower contact still get attributed even when GHL's own
    // relations array is empty.
    //
    // ONLY WHEN WE DO NOT ALREADY HOLD AN ANSWER.
    //
    // The note->deal link is OURS ALONE. GHL has no field for it that we can
    // read or write (that needs the notes.write scope this app does not
    // hold), so the fetch above returns null for the deal on EVERY sync — its
    // emptiness says nothing about what the link should be.
    //
    // Without this check the rule re-guessed on every NoteUpdate and handed
    // the upsert a value competing with the one already on the row. A note a
    // rep had moved to the right deal snapped back to the contact's earliest
    // open deal the next time the note was touched in GHL — editing a typo
    // was enough to undo it.
    //
    // So read what we hold first. A deal on record is an ANSWER, whether a
    // human set it or an earlier run of this rule did. The rule fills gaps;
    // it does not revisit answers.
    if (!opportunityId) {
      const held = await rawQuery(
        `SELECT opportunity_id, deal_set_manually FROM notes
          WHERE location_id = $1 AND note_id = $2`,
        [locationId, n.noteId]
      );
      // No row = a note we have never seen, so there is nothing to keep.
      const existing = held.rows[0]?.opportunity_id || null;
      // A PERSON set this — including setting it to nothing.
      //
      // Without this the rule refilled every deliberate unlink: NULL alone
      // reads as "not decided yet". The flag is the difference between "no
      // deal yet" and "no deal, on purpose" (migration 068).
      const manual = held.rows[0]?.deal_set_manually === true;

      // Did the rep choose a deal when they CREATED this? (migration 069)
      //
      // Checked before the rule, and it wins outright: an explicit choice is
      // an answer, not a hint. Consuming it deletes the intent, so a later
      // edit of the same note does not pick up a stale pick.
      //
      // `pending` null means nobody chose; { opportunityId: null } means the
      // rep chose "no deal" — different things, and only the first invites
      // the rule to guess.
      const pending = (!existing && !manual)
        ? await consumePendingDealLink(locationId, ENTITY_NOTE, n.noteId)
        : null;

      if (existing || manual) {
        opportunityId = existing;
      } else if (pending) {
        opportunityId = pending.opportunityId;
        // A note our app created through the API carries NO userId in GHL —
        // GHL records the app, not the rep — so the webhook names nobody and
        // the row read "by Unknown". The rep who pressed the button is on the
        // pending link, recorded by the create route; they are the author.
        if (!authorUserId && pending.createdBy) authorUserId = pending.createdBy;
        // A person chose this, so the rule must never revise it later.
        setDealManually = true;
        attributionRule = 'created_with_deal';
        attributionStatus = pending.opportunityId ? 'mapped' : 'unmapped';
      } else {
        const decision = await resolveOppForContact(
          locationId, n.contactId, n.createdAtGhl || new Date()
        );
        if (decision && decision.mappingStatus === 'mapped') {
          opportunityId = decision.opportunityId;
        }
        attributionRule = decision?.rule || null;
        attributionStatus = decision?.mappingStatus || null;
      }
    }
  }

  const authorName = await resolveAuthorName(locationId, authorUserId);

  // FK safety: NoteCreate/Update can arrive before ContactCreate on
  // out-of-order deliveries. Ensure the parent contact row exists (stub
  // if needed) so the FK doesn't reject. contactsSync fills in the real
  // fields.
  await ensureContactExists(locationId, n.contactId);

  // Notes have no status semantics beyond active/deleted, so we don't
  // overload `status`. We use status='active' as the default; NoteDelete
  // flips to 'deleted' and stamps deleted_at.
  await rawQuery(
    `INSERT INTO notes (
       location_id, note_id, contact_id, opportunity_id, business_id,
       author_user_id, author_name,
       body, title, color, pinned, status,
       raw_note, from_backfill,
       created_at_ghl, updated_at_ghl,
       deal_set_manually,
       imported_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,false,$13,$14,$19, now(), now())
     ON CONFLICT (location_id, note_id) DO UPDATE SET
       contact_id       = COALESCE(EXCLUDED.contact_id, notes.contact_id),
       -- EXISTING WINS, like tasks.opportunity_id in taskWriter.js.
       --
       -- The incoming value used to win, and that quietly undid every manual
       -- move. The deal on a note is OURS — GHL has no note->deal field we can
       -- read or write (that needs the notes.write scope this app does not
       -- hold), so fetchNoteWithRelations returns null for it on every
       -- sync and the engine below re-guesses from the rules. With the
       -- arguments the other way round that guess overwrote the rep's choice:
       -- a note moved to the right deal snapped back to the contact's
       -- earliest open deal the next time the note was touched in GHL —
       -- an edited typo was enough.
       --
       -- Proven against Postgres: a note manually moved to deal B came back
       -- from a NoteUpdate carrying deal A and ended up on A.
       --
       -- So the rule may only FILL A GAP, never replace an answer. The cost
       -- is the same one tasks already accept: a deal cleared in GHL cannot
       -- clear ours, because "null" here means "GHL did not tell us", which
       -- is indistinguishable from a removal. Unlinking is done in the UI
       -- (PUT /api/notes/:id/local-links), which writes the column directly
       -- and is not affected by this clause.
       -- A manual decision is kept VERBATIM, NULL included. COALESCE alone
       -- cannot express "deliberately no deal": it would fall through to the
       -- incoming value and undo the unlink. Everything else keeps the
       -- existing value and lets the rule fill only a genuine gap.
       opportunity_id   = CASE WHEN notes.deal_set_manually THEN notes.opportunity_id
                               ELSE COALESCE(notes.opportunity_id, EXCLUDED.opportunity_id) END,
       -- Latches ON only. A create-time pick sets it; nothing here clears it,
       -- because a later webhook carrying no pick is not a retraction.
       deal_set_manually = notes.deal_set_manually OR EXCLUDED.deal_set_manually,
       -- Clearable, but only on a SUCCESSFUL fetch.
       --
       -- COALESCE alone made detaching a company impossible: the rep picked
       -- "not linked", GHL stored it, and the old value won here forever.
       -- Assigning outright is wrong too — fetchNoteWithRelations returns
       -- null when the fetch FAILED, which would erase a link nobody touched.
       --
       -- $18 is that distinction: true only when GHL answered. Then null
       -- means "no company" and is written; otherwise the existing value
       -- stands. ($15-$17 are the title/color/pinned _sent flags — using $15
       -- here would have keyed the company off whether the TITLE changed.)
       business_id      = CASE WHEN $18 THEN EXCLUDED.business_id
                               ELSE COALESCE(EXCLUDED.business_id, notes.business_id) END,
       author_user_id   = COALESCE(EXCLUDED.author_user_id, notes.author_user_id),
       author_name      = COALESCE(EXCLUDED.author_name, notes.author_name),
       body             = EXCLUDED.body,
       -- title/color/pinned: assigned outright so CLEARING one in GHL clears
       -- it here — COALESCE would make removal impossible and a deleted title
       -- would linger forever.
       --
       -- The catch is that "not sent" must not look like "cleared". A
       -- NoteUpdate webhook carries only { id, body, contactId, dateAdded },
       -- so falling back to it — which happens whenever the API fetch fails —
       -- used to wipe the colour a rep had just set.
       --
       -- pickNoteFields now yields undefined for a field the payload did not
       -- carry, and these params are passed as NULL only when the field was
       -- genuinely cleared. The sentinel below distinguishes them: a NULL
       -- parameter means "cleared", and the matching *_sent flag being false
       -- means "absent, keep what we have".
       title  = CASE WHEN $15 THEN EXCLUDED.title ELSE notes.title END,
       color  = CASE WHEN $16 THEN EXCLUDED.color ELSE notes.color END,
       pinned = CASE WHEN $17 THEN EXCLUDED.pinned ELSE notes.pinned END,
       raw_note         = EXCLUDED.raw_note,
       updated_at_ghl   = COALESCE(EXCLUDED.updated_at_ghl, notes.updated_at_ghl),
       updated_at       = now()`,
    [
      locationId, n.noteId, n.contactId, opportunityId, businessId,
      authorUserId, authorName,
      // undefined -> null for the INSERT (a brand-new note with no colour is
      // genuinely colourless); the *_sent flags below tell the DO UPDATE
      // branch whether that null meant "cleared" or "not sent".
      n.body, n.title ?? null, n.color ?? null, n.pinned ?? null,
      mergedRaw, n.createdAtGhl, n.updatedAtGhl,
      n.title !== undefined,
      n.color !== undefined,
      n.pinned !== undefined,
      // $18 — whether the relations fetch actually answered.
      relationsFetched,
      // $19 — the deal came from a person (a pick made at create time), so
      // the rule must never revise it.
      setDealManually
    ]
  );

  logger.info(
    {
      locationId, noteId: n.noteId, contactId: n.contactId,
      opportunityId, businessId, authorUserId, attributionRule, attributionStatus
    },
    'noteWriter: note upserted'
  );
}

export async function handleNoteCreate(install, event) {
  return upsertFromEvent(install, event);
}

export async function handleNoteUpdate(install, event) {
  return upsertFromEvent(install, event);
}

// --- NoteDelete --------------------------------------------------------

export async function handleNoteDelete(install, event) {
  const locationId = install.location_id;
  const n = pickNoteFields(event);
  if (!n.noteId) {
    logger.warn({ event }, 'noteWriter: NoteDelete missing note id — dropping');
    return;
  }

  const { rowCount } = await rawQuery(
    `UPDATE notes
        SET status     = 'deleted',
            deleted_at = COALESCE(deleted_at, now()),
            updated_at = now()
      WHERE location_id = $1 AND note_id = $2`,
    [locationId, n.noteId]
  );

  if (rowCount === 0) {
    logger.warn(
      { locationId, noteId: n.noteId },
      'noteWriter: NoteDelete for unknown note_id — never saw NoteCreate'
    );
    return;
  }
  logger.info({ locationId, noteId: n.noteId }, 'noteWriter: NoteDelete applied');
}
