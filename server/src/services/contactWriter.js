// contactWriter.js — handles Contact webhook events + one-time backfill.
// Writes to `contacts` (migration 001 + 011 + 020 + 026).
//
// Events dispatched here from routes/webhooks.js:
//   • ContactCreate  → upsert with all fields
//   • ContactUpdate  → upsert with all fields (same code path)
//   • ContactDelete  → soft delete (deleted_at = now())
//   • ContactDndUpdate → writes promoted dnd / dnd_settings /
//     inbound_dnd_settings columns (migration 052) + refreshes raw_contact
//
// ContactTagUpdate is handled in webhooks.js directly via tagHistoryWriter.
// ContactCreate/ContactUpdate ALSO carry a tag list, and this writer now
// reconciles that into tag_history too (and fans it out to the contact's
// deals) — see handleContactUpsert. It used to write only the contacts.tags
// column, so a tag added during an ordinary contact edit never opened a
// history session and never reached the deals list tag filter.
//
// custom_fields promotion:
//   GHL sends customFields as [{ id, value }]. We keep the raw JSONB blob
//   AND resolve select field keys via ghl_custom_field_definitions (migration
//   023) into promoted columns per CSV blueprint. Unknown field IDs stay in
//   custom_fields JSONB — never dropped.

import { rawQuery } from '../db.js';
import { ghlRequest } from './ghlClient.js';
import { getUserName } from './ghlEnrichment.js';
import { logger } from '../utils/logger.js';
import { reconcileTags } from './tagHistoryWriter.js';
import { fanoutFromContact } from './tagFanout.js';

// Client-specific custom-field keys promoted into their own columns.
// Keys match the `field_key` column populated by customFieldsSync from GHL's
// fieldKey property. Values are the DB column names.
const PROMOTED_FIELD_KEYS = {
  'contact.client_type':                              'client_type',
  'contact.channel':                                  'channel',
  'contact.product_type':                             'product_type',
  'contact.please_explain_your_enquiry_leadform':     'leadform_enquiry_text',
  'contact.file_upload_leadform':                     'leadform_files',
  'contact.please_explain_your_inquiry_webchat':      'webchat_inquiry_text',
  'contact.please_upload_your_files_chatwidget':      'webchat_files',
  'contact.please_explain_your_inquiry_enquiries_at_gmail': 'enquiries_email_inquiry_text',
  'contact.enquiries_at_email_attachments':           'enquiries_email_attachments',
  'contact.file_upload__crittall_lead_form':          'crittall_leadform_files',
  'contact.ienquiry_crittall_email':                  'crittall_email_inquiry_text',
  'contact.file_upload_crittall_email':               'crittall_email_files',
  'contact.first_contact_method':                     'first_contact_method',
  'contact.checkbox_2wpw':                            'crittall_assignment_checkbox',
  'contact.value':                                    'contact_value_raw',
  'contact.file_upload_nonleadform':                  'nonleadform_files',

  // ── Paid-search attribution ──────────────────────────────────────────
  //
  // The website form has been capturing all nine of these since at least
  // 7 August, and every one landed in contacts.custom_fields and stopped
  // there — the columns exist (migration 026) but nothing ever promoted into
  // them. A complete Google Ads chain (click id, campaign, ad group, keyword)
  // was in the database and invisible to every query that reads the columns.
  //
  // Note the first line: GHL's key is `google_click_id`, our column is `gclid`.
  // That mismatch is presumably why it was missed — the other eight are named
  // identically and were simply never listed.
  'contact.google_click_id':                          'gclid',
  'contact.gbraid':                                   'gbraid',
  'contact.wbraid':                                   'wbraid',
  'contact.gad_source':                               'gad_source',
  'contact.utm_source':                               'utm_source',
  'contact.utm_medium':                               'utm_medium',
  'contact.utm_campaign':                             'utm_campaign',
  'contact.utm_content':                              'utm_content',
  'contact.utm_term':                                 'utm_term'
};

// Field types that should be stored as JSONB (arrays / structured values).
// Any field key NOT in this set is stored as TEXT.
const JSONB_COLUMNS = new Set([
  'leadform_files', 'webchat_files', 'enquiries_email_attachments',
  'crittall_leadform_files', 'crittall_email_files',
  'first_contact_method', 'crittall_assignment_checkbox',
  'nonleadform_files'
]);

// Resolve a payload's customFields ([{ id, value }, ...]) into
// { promoted: { columnName: value }, byKey: { fieldKey: value } }.
// - promoted → written into typed columns
// - byKey    → stored as the canonical custom_fields JSONB (stable keys)
// Falls back gracefully: unknown IDs stay in raw as { unknown_<id>: value }.
async function resolveCustomFields(locationId, customFieldsArr) {
  const promoted = {};
  const byKey = {};
  if (!Array.isArray(customFieldsArr) || customFieldsArr.length === 0) {
    return { promoted, byKey };
  }

  const ids = customFieldsArr.map((c) => c.id).filter(Boolean);
  if (ids.length === 0) return { promoted, byKey };

  // One lookup: fieldId → field_key for this location + object_type=contact
  const { rows } = await rawQuery(
    `SELECT field_id, field_key
       FROM ghl_custom_field_definitions
      WHERE location_id = $1
        AND object_type = 'contact'
        AND field_id = ANY($2::text[])`,
    [locationId, ids]
  );
  const idToKey = new Map(rows.map((r) => [r.field_id, r.field_key]));

  for (const cf of customFieldsArr) {
    if (!cf?.id) continue;
    const key = idToKey.get(cf.id);
    if (!key) {
      // Unknown field ID — keep in raw JSONB under provisional key so it
      // isn't silently lost until next customFieldsSync run.
      byKey[`unknown_${cf.id}`] = cf.value;
      continue;
    }
    byKey[key] = cf.value;
    const column = PROMOTED_FIELD_KEYS[key];
    if (column) promoted[column] = cf.value;
  }

  return { promoted, byKey };
}

// Extract every scalar/JSONB column value from a contact payload. Handles
// both webhook shape (flat top-level) and API shape (nested under .contact).
function pickContactFields(payload) {
  const c = payload.contact || payload; // Get Contact API wraps in { contact: {...} }

  // Date parsing — GHL sends ISO strings; new Date(undefined) → Invalid Date
  const dob = c.dateOfBirth ? new Date(c.dateOfBirth) : null;
  const createdAtGhl = c.dateAdded ? new Date(c.dateAdded) : null;
  const updatedAtGhl = c.dateUpdated ? new Date(c.dateUpdated) : null;

  return {
    contactId:      c.id || c.contactId,
    firstName:      c.firstName || null,
    lastName:       c.lastName || null,
    email:          c.email || null,
    phone:          c.phone || null,
    companyName:    c.companyName || null,
    // GHL's link from a contact to its business record. Both spellings
    // checked — the payload has used each.
    businessId:     c.businessId || c.business_id || null,
    // Contact owner. Same dual-spelling story as businessId above; '' is
    // GHL's "unassigned", which must land as NULL and not as an owner whose
    // id happens to be the empty string.
    assignedTo:     c.assignedTo || c.assigned_to || null,
    contactSource:  c.source || null,
    // THE CONTACT'S TYPE, NEVER THE EVENT'S.
    //
    // `type` collides. On the REST Get Contact shape (the backfill) `c` is
    // payload.contact and c.type is the real value: 'lead' | 'customer'. On
    // a WEBHOOK there is no `contact` wrapper — `c` is the flat envelope —
    // and its top-level `type` is the EVENT NAME, which is exactly what
    // webhooks.js reads it as (eventType = event.type). So every
    // ContactUpdate stored the literal string "ContactUpdate" into
    // contact_type. The column has no CHECK constraint, so it landed
    // silently and only showed up in the data.
    //
    // The real type is one of two words. Anything else is the envelope
    // leaking, and is sent as null — which the upsert's COALESCE turns into
    // "leave what the backfill set", rather than overwriting a good
    // 'lead' with an event name. An event type is not contact data and
    // must never reach this column; if we ever want it, it gets its own.
    contactType:    (c.type === 'lead' || c.type === 'customer') ? c.type : null,
    dateOfBirth:    dob && !isNaN(dob.getTime()) ? dob.toISOString().slice(0, 10) : null,
    address1:       c.address1 || null,
    city:           c.city || null,
    state:          c.state || null,
    postalCode:     c.postalCode || null,
    country:        c.country || null,
    website:        c.website || null,
    timezone:       c.timezone || null,
    tags:           Array.isArray(c.tags) ? c.tags : [],
    // WHETHER THE PAYLOAD CARRIED A TAG LIST AT ALL.
    //
    // `tags` above collapses "absent" and "empty" to the same [], which is
    // fine for the contacts.tags column (it mirrors current state and an
    // absent list is treated as unchanged by the upsert). It is NOT fine for
    // tag_history: reconciling against [] CLOSES every open session, so a
    // payload that simply omitted tags would wipe the contact's tag history
    // — and, now, every deal it fans out to.
    hasTagList:     Array.isArray(c.tags),
    createdAtGhl,
    updatedAtGhl,
    customFieldsArr: Array.isArray(c.customFields) ? c.customFields : [],
    // DND — promoted as of migration 052. Shape per the ContactDndUpdate
    // payload. `dnd` is the master switch; dndSettings is per-channel where
    // status 'active' means the DND rule is active (channel BLOCKED).
    dnd: c.dnd === true,
    dndSettings: c.dndSettings && typeof c.dndSettings === 'object' ? c.dndSettings : null,
    inboundDndSettings:
      c.inboundDndSettings && typeof c.inboundDndSettings === 'object'
        ? c.inboundDndSettings
        : null,
    raw: c
  };
}

async function upsertContact(locationId, f, promoted, byKey, { fromBackfill = false, assignedToName = null } = {}) {
  // 34 columns in the INSERT, matching the schema in migration 026 (plus the
  // existing columns from 001). tags is a TEXT[] — pg driver handles arrays.
  await rawQuery(
    `INSERT INTO contacts (
       location_id, contact_id,
       first_name, last_name, email, phone, company_name,
       contact_source, contact_type, date_of_birth,
       address1, city, state, postal_code, country, website, timezone,
       tags, custom_fields, raw_contact,
       client_type, channel, product_type,
       leadform_enquiry_text, leadform_files,
       webchat_inquiry_text, webchat_files,
       enquiries_email_inquiry_text, enquiries_email_attachments,
       crittall_leadform_files, crittall_email_inquiry_text, crittall_email_files,
       first_contact_method, crittall_assignment_checkbox,
       contact_value_raw, nonleadform_files,
       -- Paid-search attribution. The columns have existed since migration 026
       -- and were never in this statement, so nine fields the website form
       -- captures landed in custom_fields and stopped there.
       gclid, gbraid, wbraid, gad_source,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       from_backfill,
       created_at_ghl, updated_at_ghl,
       dnd, dnd_settings, inbound_dnd_settings,
       business_id,
       assigned_to, assigned_to_name,
       imported_at, updated_at
     ) VALUES (
       $1,$2,
       $3,$4,$5,$6,$7,
       $8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,
       $18,$19::jsonb,$20::jsonb,
       $21::jsonb,$22,$23::jsonb,
       $24,$25::jsonb,
       $26,$27::jsonb,
       $28,$29::jsonb,
       $30::jsonb,$31,$32::jsonb,
       $33::jsonb,$34::jsonb,
       $35,$36::jsonb,
       $37,$38,$39,$40,
       $41,$42,$43,$44,$45,
       $46,
       $47,$48,
       $49,$50::jsonb,$51::jsonb,
       $52,$53,$54,
       now(), now()
     )
     ON CONFLICT (location_id, contact_id) DO UPDATE SET
       first_name    = COALESCE(EXCLUDED.first_name, contacts.first_name),
       last_name     = COALESCE(EXCLUDED.last_name, contacts.last_name),
       email         = COALESCE(EXCLUDED.email, contacts.email),
       phone         = COALESCE(EXCLUDED.phone, contacts.phone),
       company_name  = COALESCE(EXCLUDED.company_name, contacts.company_name),
       business_id   = COALESCE(EXCLUDED.business_id, contacts.business_id),
       assigned_to   = COALESCE(EXCLUDED.assigned_to, contacts.assigned_to),
       assigned_to_name = COALESCE(EXCLUDED.assigned_to_name, contacts.assigned_to_name),
       contact_source= COALESCE(EXCLUDED.contact_source, contacts.contact_source),
       contact_type  = COALESCE(EXCLUDED.contact_type, contacts.contact_type),
       date_of_birth = COALESCE(EXCLUDED.date_of_birth, contacts.date_of_birth),
       address1      = COALESCE(EXCLUDED.address1, contacts.address1),
       city          = COALESCE(EXCLUDED.city, contacts.city),
       state         = COALESCE(EXCLUDED.state, contacts.state),
       postal_code   = COALESCE(EXCLUDED.postal_code, contacts.postal_code),
       country       = COALESCE(EXCLUDED.country, contacts.country),
       website       = COALESCE(EXCLUDED.website, contacts.website),
       timezone      = COALESCE(EXCLUDED.timezone, contacts.timezone),
       tags          = EXCLUDED.tags,
       custom_fields = EXCLUDED.custom_fields,
       raw_contact   = EXCLUDED.raw_contact,
       -- COALESCEd like the other promoted fields: an event that carries no
       -- custom fields must not wipe an attribution chain captured at signup.
       -- These are first-touch values — they should never change after the
       -- first event that carries them.
       gclid         = COALESCE(EXCLUDED.gclid, contacts.gclid),
       gbraid        = COALESCE(EXCLUDED.gbraid, contacts.gbraid),
       wbraid        = COALESCE(EXCLUDED.wbraid, contacts.wbraid),
       gad_source    = COALESCE(EXCLUDED.gad_source, contacts.gad_source),
       utm_source    = COALESCE(EXCLUDED.utm_source, contacts.utm_source),
       utm_medium    = COALESCE(EXCLUDED.utm_medium, contacts.utm_medium),
       utm_campaign  = COALESCE(EXCLUDED.utm_campaign, contacts.utm_campaign),
       utm_content   = COALESCE(EXCLUDED.utm_content, contacts.utm_content),
       utm_term      = COALESCE(EXCLUDED.utm_term, contacts.utm_term),
       -- Assigned, not COALESCEd: turning a channel back ON is expressed as
       -- status 'inactive', so COALESCE would pin the old block permanently.
       dnd                  = EXCLUDED.dnd,
       dnd_settings         = COALESCE(EXCLUDED.dnd_settings, contacts.dnd_settings),
       inbound_dnd_settings = COALESCE(EXCLUDED.inbound_dnd_settings, contacts.inbound_dnd_settings),
       client_type   = COALESCE(EXCLUDED.client_type, contacts.client_type),
       channel       = COALESCE(EXCLUDED.channel, contacts.channel),
       product_type  = COALESCE(EXCLUDED.product_type, contacts.product_type),
       leadform_enquiry_text        = COALESCE(EXCLUDED.leadform_enquiry_text, contacts.leadform_enquiry_text),
       leadform_files               = COALESCE(EXCLUDED.leadform_files, contacts.leadform_files),
       webchat_inquiry_text         = COALESCE(EXCLUDED.webchat_inquiry_text, contacts.webchat_inquiry_text),
       webchat_files                = COALESCE(EXCLUDED.webchat_files, contacts.webchat_files),
       enquiries_email_inquiry_text = COALESCE(EXCLUDED.enquiries_email_inquiry_text, contacts.enquiries_email_inquiry_text),
       enquiries_email_attachments  = COALESCE(EXCLUDED.enquiries_email_attachments, contacts.enquiries_email_attachments),
       crittall_leadform_files      = COALESCE(EXCLUDED.crittall_leadform_files, contacts.crittall_leadform_files),
       crittall_email_inquiry_text  = COALESCE(EXCLUDED.crittall_email_inquiry_text, contacts.crittall_email_inquiry_text),
       crittall_email_files         = COALESCE(EXCLUDED.crittall_email_files, contacts.crittall_email_files),
       first_contact_method         = COALESCE(EXCLUDED.first_contact_method, contacts.first_contact_method),
       crittall_assignment_checkbox = COALESCE(EXCLUDED.crittall_assignment_checkbox, contacts.crittall_assignment_checkbox),
       contact_value_raw            = COALESCE(EXCLUDED.contact_value_raw, contacts.contact_value_raw),
       nonleadform_files            = COALESCE(EXCLUDED.nonleadform_files, contacts.nonleadform_files),
       created_at_ghl = COALESCE(EXCLUDED.created_at_ghl, contacts.created_at_ghl),
       updated_at_ghl = COALESCE(EXCLUDED.updated_at_ghl, contacts.updated_at_ghl),
       deleted_at     = NULL,
       updated_at     = now()`,
    [
      locationId, f.contactId,
      f.firstName, f.lastName, f.email, f.phone, f.companyName,
      f.contactSource, f.contactType, f.dateOfBirth,
      f.address1, f.city, f.state, f.postalCode, f.country, f.website, f.timezone,
      f.tags, JSON.stringify(byKey), JSON.stringify(f.raw),
      jsonbOrNull(promoted.client_type),
      promoted.channel ?? null,
      jsonbOrNull(promoted.product_type),
      promoted.leadform_enquiry_text ?? null,
      jsonbOrNull(promoted.leadform_files),
      promoted.webchat_inquiry_text ?? null,
      jsonbOrNull(promoted.webchat_files),
      promoted.enquiries_email_inquiry_text ?? null,
      jsonbOrNull(promoted.enquiries_email_attachments),
      jsonbOrNull(promoted.crittall_leadform_files),
      promoted.crittall_email_inquiry_text ?? null,
      jsonbOrNull(promoted.crittall_email_files),
      jsonbOrNull(promoted.first_contact_method),
      jsonbOrNull(promoted.crittall_assignment_checkbox),
      promoted.contact_value_raw ?? null,
      jsonbOrNull(promoted.nonleadform_files),
      // Paid-search attribution — order must match the column list above.
      promoted.gclid ?? null,
      promoted.gbraid ?? null,
      promoted.wbraid ?? null,
      promoted.gad_source ?? null,
      promoted.utm_source ?? null,
      promoted.utm_medium ?? null,
      promoted.utm_campaign ?? null,
      promoted.utm_content ?? null,
      promoted.utm_term ?? null,
      fromBackfill,
      f.createdAtGhl, f.updatedAtGhl,
      f.dnd,
      f.dndSettings ? JSON.stringify(f.dndSettings) : null,
      f.inboundDndSettings ? JSON.stringify(f.inboundDndSettings) : null,
      f.businessId,
      f.assignedTo,
      assignedToName
    ]
  );
}

// JSONB columns get a JSON *string* plus an explicit ::jsonb cast in the SQL.
//
// Do NOT hand the pg driver a raw JS value and trust it to serialise. It does
// not produce JSON: `prepareValue` passes a JS string through VERBATIM (so
// "hello" arrives as bare `hello`, invalid JSON) and converts a JS ARRAY into a
// POSTGRES ARRAY LITERAL (`[1,2]` -> `{"1","2"}`, also invalid JSON). Both fail
// as `invalid input syntax for type json` (22P02) -- which is exactly what the
// contact backfill hit on every contact carrying a checkbox/file field.
//
// Scalars wrap into { value } so the column shape stays an object/array.
function jsonbOrNull(v) {
  if (v === undefined || v === null) return null;
  const shaped = (Array.isArray(v) || typeof v === 'object') ? v : { value: v };
  return JSON.stringify(shaped);
}

// ── Public API ─────────────────────────────────────────────────────────

export async function handleContactUpsert(install, event, { fromBackfill = false } = {}) {
  const locationId = install.location_id;
  const f = pickContactFields(event);
  if (!f.contactId) {
    logger.warn({ event }, 'contactWriter: event missing contact id — dropping');
    return;
  }
  const { promoted, byKey } = await resolveCustomFields(locationId, f.customFieldsArr);
  // Snapshot the owner's name alongside the id. Reads prefer a live `users`
  // join, but a user DELETED from GHL drops out of that join entirely, and
  // without this the contact would then show a raw user id. getUserName hits
  // the local users table first and only falls back to the API.
  let assignedToName = null;
  if (f.assignedTo) {
    try {
      assignedToName = await getUserName(install, f.assignedTo);
    } catch (err) {
      // A name we cannot resolve must not cost us the contact write.
      logger.debug({ err, assignedTo: f.assignedTo }, 'contactWriter: owner name lookup failed');
    }
  }
  await upsertContact(locationId, f, promoted, byKey, { fromBackfill, assignedToName });

  // TAGS INTO tag_history, AND ON TO THE CONTACT'S DEALS.
  //
  // ContactCreate/ContactUpdate carry the contact's full tag list, but this
  // writer only ever wrote the contacts.tags column — tag_history was left
  // to ContactTagUpdate alone. That was a real gap even before deals were
  // involved: a tag added as part of an ordinary contact edit never opened a
  // session, so "when was this tagged" could not answer it.
  //
  // It matters more now. A deal's tags are derived from its contacts'
  // tag_history rows (see tagFanout.js), so a tag that never reached
  // tag_history never reaches the deals list filter either.
  //
  // Guarded by hasTagList: a payload that OMITS tags must not be read as
  // "no tags", which would close every open session. Only a list that was
  // actually sent is reconciled.
  //
  // Best-effort throughout: a tag is a filter facet, and losing one must
  // never cost us the contact write that carried it.
  if (f.hasTagList) {
    try {
      await reconcileTags({
        locationId,
        entityType: 'contact',
        entityId: f.contactId,
        currentTags: f.tags,
        detectedVia: event.type || 'contact_upsert'
      });
      await fanoutFromContact(locationId, f.contactId);
    } catch (err) {
      logger.warn(
        { err, locationId, contactId: f.contactId },
        'contactWriter: tag reconcile/fanout failed (non-fatal)'
      );
    }
  }

  logger.info(
    { locationId, contactId: f.contactId, email: f.email, eventType: event.type, fromBackfill },
    'contactWriter: contact upserted'
  );
}

export async function handleContactDelete(install, event) {
  const locationId = install.location_id;
  const contactId = event.id || event.contactId || event.contact?.id;
  if (!contactId) {
    logger.warn({ event }, 'contactWriter: ContactDelete missing contact id — dropping');
    return;
  }
  const { rowCount } = await rawQuery(
    `UPDATE contacts
        SET deleted_at = now(),
            updated_at = now()
      WHERE location_id = $1 AND contact_id = $2`,
    [locationId, contactId]
  );

  // CASCADE to the records that hang off the contact.
  //
  // GHL deletes a contact's notes and tasks with it, but sends no
  // NoteDelete / TaskDelete for them — so ours were left 'active', pointing at
  // a contact that no longer exists. They kept appearing in the queues and on
  // deal timelines, and editing one failed against GHL with "not found",
  // which is what a rep saw instead of an explanation.
  //
  // Soft, matching how NoteDelete and TaskDelete behave: the text is kept so
  // a deal's history does not silently lose its context, and a mistaken
  // delete in GHL stays recoverable on our side.
  const notes = await rawQuery(
    `UPDATE notes
        SET status = 'deleted', deleted_at = now(), updated_at = now()
      WHERE location_id = $1 AND contact_id = $2 AND status = 'active'`,
    [locationId, contactId]
  );
  const tasks = await rawQuery(
    `UPDATE tasks
        SET status = 'deleted', deleted_at = now(), updated_at = now()
      WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL`,
    [locationId, contactId]
  );

  logger.info(
    {
      locationId, contactId, matched: rowCount,
      notesDeleted: notes.rowCount, tasksDeleted: tasks.rowCount
    },
    'contactWriter: contact soft-deleted (notes and tasks cascaded)'
  );
}

// ContactDndUpdate — writes the promoted DND columns (migration 052).
//
// This event is the ONLY signal when a rep toggles DND in GHL without
// otherwise editing the contact. Before it was subscribed, DND could only
// refresh as a side effect of an unrelated ContactUpdate, which meant the
// draft-channel gate could be enforcing days-old permissions. Given the gate
// decides whether we message someone who asked us not to, that's not a
// staleness we can accept.
//
// Assigned, not COALESCEd: re-enabling a channel arrives as status
// 'inactive', so preserving the old value would pin the block forever.
export async function handleContactDndUpdate(install, event) {
  const locationId = install.location_id;
  const contactId = event.id || event.contactId || event.contact?.id;
  if (!contactId) {
    logger.warn({ event }, 'contactWriter: ContactDndUpdate missing contact id — dropping');
    return;
  }
  const f = pickContactFields(event);
  const { rowCount } = await rawQuery(
    `UPDATE contacts
        SET dnd                  = $3,
            dnd_settings         = COALESCE($4::jsonb, dnd_settings),
            inbound_dnd_settings = COALESCE($5::jsonb, inbound_dnd_settings),
            raw_contact          = $6,
            updated_at_ghl       = COALESCE($7, updated_at_ghl),
            updated_at           = now()
      WHERE location_id = $1 AND contact_id = $2`,
    [
      locationId,
      contactId,
      f.dnd,
      f.dndSettings ? JSON.stringify(f.dndSettings) : null,
      f.inboundDndSettings ? JSON.stringify(f.inboundDndSettings) : null,
      f.raw,
      f.updatedAtGhl
    ]
  );
  // A DND event for a contact we've never synced is a real case (the contact
  // predates the install). Create the row rather than dropping the event —
  // losing a DND flag is worse than an otherwise-sparse contact.
  if (rowCount === 0) {
    logger.info({ locationId, contactId }, 'contactWriter: DND for unknown contact — upserting');
    const { promoted, byKey } = await resolveCustomFields(locationId, f.customFieldsArr);
    await upsertContact(locationId, f, promoted, byKey);
    return;
  }
  logger.info(
    { locationId, contactId, dnd: f.dnd },
    'contactWriter: DND update applied'
  );
}

// One-time backfill helper — called from scripts/backfillContacts.js.
// GHL's /contacts/ endpoint is paginated via startAfterId + startAfter cursor.
export async function backfillContactsForLocation(install) {
  const locationId = install.location_id;
  logger.info({ locationId }, 'contactBackfill: starting');

  let total = 0;
  let startAfterId = null;
  let startAfter = null;
  const pageSize = 100;

  // Paginate until GHL stops returning contacts.
  // Endpoint: GET /contacts/?locationId=X&limit=100&startAfterId=<id>&startAfter=<epochMs>
  for (let page = 0; page < 1000; page++) { // 1000-page safety cap = 100k contacts
    const params = new URLSearchParams({
      locationId,
      limit: String(pageSize)
    });
    if (startAfterId) params.set('startAfterId', startAfterId);
    if (startAfter) params.set('startAfter', String(startAfter));

    let data;
    try {
      const resp = await ghlRequest(install, {
        method: 'GET',
        url: `/contacts/?${params.toString()}`
      });
      data = resp.data;
    } catch (err) {
      logger.error(
        { locationId, page, err, status: err.response?.status },
        'contactBackfill: page fetch failed — stopping'
      );
      break;
    }

    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    if (contacts.length === 0) break;

    for (const raw of contacts) {
      try {
        await handleContactUpsert(install, { contact: raw }, { fromBackfill: true });
        total++;
      } catch (err) {
        logger.warn(
          { locationId, contactId: raw?.id, err },
          'contactBackfill: contact upsert failed — skipped'
        );
      }
    }

    // Advance cursor. GHL returns the last contact's id + dateAdded epoch.
    const last = contacts[contacts.length - 1];
    startAfterId = last?.id || null;
    startAfter = last?.dateAdded ? new Date(last.dateAdded).getTime() : null;

    if (contacts.length < pageSize) break; // partial page → done
    logger.info({ locationId, page: page + 1, total }, 'contactBackfill: page done');
  }

  logger.info({ locationId, total }, 'contactBackfill: complete');
  return { count: total };
}
