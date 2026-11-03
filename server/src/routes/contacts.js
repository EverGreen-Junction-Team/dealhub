import express from 'express';
import multer from 'multer';
import { contactLabel } from '../utils/contactLabel.js';
import { extractAttachments } from '../utils/attachments.js';
import { proxyAttachments } from '../services/attachmentProxy.js';
import { manualResolve } from '../services/attributionEngine.js';
import { uploadToCustomField, UploadError } from '../services/customFieldUpload.js';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import { updateGhlContact, ContactWriteError, createGhlContact, deleteGhlContact } from '../services/ghlContactWrite.js';
import { handleContactUpsert, handleContactDelete } from '../services/contactWriter.js';
import {
  addGhlContactTags, removeGhlContactTags, TagWriteError
} from '../services/ghlTagWrite.js';
import { logger } from '../utils/logger.js';
import { parseLimit, decodeCursor, keysetClause, orderBy, toPage } from '../utils/paginate.js';
import { labelForSenderType } from '../services/messageSource.js';

export const contactsRouter = express.Router();
contactsRouter.use(requireSession);

// Same accent hashing rule the deals router uses — one accent per contact
// stays stable across every page in the app.
const ACCENTS = ['sky', 'plum', 'clay', 'gold', 'rose', 'teal', 'pine'];
function accentFor(contactId) {
  if (!contactId) return 'gray';
  let h = 5381;
  for (let i = 0; i < contactId.length; i++) h = ((h << 5) + h + contactId.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(h) % ACCENTS.length];
}

// GET /api/contacts — list every contact in the location.
//   ?q=<search>      matches name / email / phone / business
//   ?limit=N         default 100, max 500
//
// Includes the count of open opportunities per contact so the frontend can
// show "3 deals" chips inline. Tags come as an array of active tag names.

// Per-channel contact permissions, from the promoted DND columns (migration
// 052). The dnd_* columns are generated and already encode GHL's
// active-means-blocked polarity, so this is a straight read.
//
// `blockedChannels` is what the UI badge counts ("1 channel off") and what the
// AI draft gate refuses (spec rule 7). `reasons` carries GHL's own per-channel
// message where present — useful when a rep asks why a channel is off.
// Custom fields for the contact editor, grouped into GHL's own folders.
//
// WHY THIS SHAPE. GHL's contact panel renders one collapsible section per
// folder — "General Info", "Website Form", "Charlie lead upload (Crittall)".
// Our editor showed none of them: the definitions were synced (migration 023)
// but never sent to the client, and the folder each belongs to was not stored
// until migration 064.
//
// The VALUES live in contacts.custom_fields (JSONB, keyed by field id); the
// LABELS, TYPES and OPTIONS live in the definitions table. Neither is useful
// alone, so they are joined here rather than leaving the client to correlate
// two lists.
//
// Fields with no folder — and fields whose folder was deleted in GHL — fall
// into a synthetic "Other fields" group rather than vanishing. A value a rep
// can see in the CRM must not disappear here because its folder did.
async function customFieldGroups(client, locationId, rawValues) {
  const values = (rawValues && typeof rawValues === 'object') ? rawValues : {};

  const { rows: defs } = await client.query(
    `SELECT d.field_id, d.field_key, d.display_name, d.field_type,
            d.options, d.placeholder, d.parent_id, d.position,
            -- maxFileLimit for FILE_UPLOAD fields lives here, not in a column.
            d.raw_definition,
            f.name AS folder_name, f.position AS folder_position
       FROM ghl_custom_field_definitions d
       LEFT JOIN ghl_custom_field_folders f
         ON  f.location_id = d.location_id
         AND f.object_type = d.object_type
         AND f.folder_id   = d.parent_id
         AND f.is_active
      WHERE d.location_id = $1
        AND d.object_type = 'contact'
        AND d.is_active
      ORDER BY f.position NULLS LAST, f.name NULLS LAST,
               d.position NULLS LAST, d.display_name`,
    [locationId]
  );

  const groups = new Map();
  for (const d of defs) {
    // A field whose folder is missing or inactive groups under a stable
    // sentinel key, so several orphans share ONE section rather than each
    // producing an empty-named group.
    const key = d.folder_name ? d.parent_id : '__ungrouped__';
    if (!groups.has(key)) {
      groups.set(key, {
        id: d.folder_name ? d.parent_id : null,
        name: d.folder_name || 'Other fields',
        position: d.folder_position ?? 9999,
        fields: []
      });
    }
    groups.get(key).fields.push({
      id: d.field_id,
      key: d.field_key,
      label: d.display_name || d.field_key || 'Untitled field',
      type: d.field_type || 'TEXT',
      placeholder: d.placeholder || null,
      // Picklist choices, already normalised by the sync.
      options: d.options?.values || null,
      // The value keyed by id, falling back to the stable field_key —
      // customFields blobs have used both across API versions.
      value: values[d.field_id] ?? (d.field_key ? values[d.field_key] : undefined) ?? null,
      // FILE_UPLOAD is UPLOADABLE — POST /locations/:id/customFields/upload.
      //
      // This was flagged readOnly on the claim that there is "no OAuth
      // documents API". That was a wrong generalisation: EMAIL attachments
      // have no upload API, and I carried it over to custom fields, which do.
      //
      // Nothing is read-only now; the flag stays so a future field type that
      // genuinely cannot be written has somewhere to say so.
      readOnly: false,
      // The client renders a file picker for these rather than a text box.
      upload: (d.field_type || '').toUpperCase() === 'FILE_UPLOAD',
      // The field's own ceiling, when its definition states one.
      maxFiles: d.raw_definition?.maxFileLimit ?? null
    });
  }

  return [...groups.values()].sort((a, b) =>
    a.position - b.position || a.name.localeCompare(b.name));
}

function dndOf(c) {
  const channels = {
    email:    c.dnd_email === true,
    sms:      c.dnd_sms === true,
    call:     c.dnd_call === true,
    whatsapp: c.dnd_whatsapp === true
  };
  const blocked = Object.entries(channels).filter(([, v]) => v).map(([k]) => k);
  const settings = (c.dnd_settings && typeof c.dnd_settings === 'object') ? c.dnd_settings : {};
  const reasons = {};
  for (const [key, label] of [['email','Email'], ['sms','SMS'], ['call','Call'], ['whatsapp','WhatsApp']]) {
    const msg = settings[label]?.message;
    if (channels[key] && msg) reasons[key] = msg;
  }
  return {
    all: c.dnd === true,
    inbound: c.dnd_inbound === true,
    channels,
    blockedChannels: blocked,
    blockedCount: blocked.length,
    reasons
  };
}

// GHL's additionalEmails / additionalPhones are arrays of strings (sometimes
// objects). Normalise, and drop anything equal to the primary so the UI never
// shows the same address twice.
function extraList(raw, key, primary) {
  const arr = raw && Array.isArray(raw[key]) ? raw[key] : [];
  const out = [];
  for (const v of arr) {
    const val = typeof v === 'string' ? v : (v?.email || v?.phone || v?.value);
    if (!val) continue;
    const t = String(val).trim();
    if (!t || t === primary || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

function normaliseContactChannel(raw, isCall) {
  if (isCall) return 'call';
  const c = String(raw || '').toUpperCase();
  if (c.includes('EMAIL')) return 'email';
  if (c.includes('WHATSAPP')) return 'whatsapp';
  if (c.includes('IMESSAGE')) return 'imessage';
  if (c.includes('SMS')) return 'sms';
  if (c.includes('NOTE')) return 'note';
  return c.toLowerCase() || 'unknown';
}

contactsRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const q = (req.query.q || '').toString().trim();
  // Filters for the contacts table — mirrors what the deals list accepts.
  const contactType = (req.query.contactType || '').toString().trim();
  const assignedTo  = (req.query.assignedTo || '').toString().trim();
  const tag = (req.query.tag || '').toString().trim();
  // Open deal value, in whole currency units. Either bound may be sent alone.
  const minValue = Number.parseFloat(req.query.minValue);
  const maxValue = Number.parseFloat(req.query.maxValue);
  // Last activity, as a number of days. 'activeWithin=7' means "said something
  // in the last week"; 'quietFor=30' is the opposite — the list a rep actually
  // works from, since a silent contact is the one needing a call.
  const activeWithin = Number.parseInt(req.query.activeWithin, 10);
  const quietFor = Number.parseInt(req.query.quietFor, 10);
  const hasDeals = (req.query.hasDeals || '').toString().trim();
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);

  try {
    const rows = await withTenant(locationId, async (client) => {
      const params = [locationId];
      let qClause = '';
      if (q) {
        params.push(`%${q}%`);
        // $n, not a hardcoded $2 — this assumed the search was always the
        // second parameter, which stopped being true the moment another
        // filter could be pushed before it.
        const i = params.length;
        qClause = `AND (
          c.first_name ILIKE $${i}
          OR c.last_name ILIKE $${i}
          OR c.email     ILIKE $${i}
          OR c.phone     ILIKE $${i}
          OR c.company_name ILIKE $${i}
        )`;
      }
      // Contact type — 'lead' or 'customer', GHL's own two values.
      let typeClause = '';
      if (contactType) {
        params.push(contactType);
        typeClause = `AND lower(c.contact_type) = lower($${params.length})`;
      }
      // Owner. 'unassigned' is not a user id but a question managers actually
      // ask, so it is its own branch and pushes no param.
      let ownerClause = '';
      if (assignedTo === 'unassigned') {
        ownerClause = `AND c.assigned_to IS NULL`;
      } else if (assignedTo) {
        params.push(assignedTo);
        ownerClause = `AND c.assigned_to = $${params.length}`;
      }
      // One tag. Tags live in their own table, so an EXISTS rather than a
      // column match.
      // Open deal value. Summed across the contact's OPEN deals only — a
      // contact whose £40k deal was lost last year is not a £40k contact.
      const OPEN_VALUE = `(
        SELECT COALESCE(SUM(o2.monetary_value), 0)
          FROM opportunities o2
         WHERE o2.location_id = c.location_id
           AND o2.contact_id  = c.contact_id
           AND o2.status      = 'open'
           AND o2.is_deleted  = false
           AND o2.deleted_at IS NULL
           AND o2.is_ghost    = false
      )`;
      let valueClause = '';
      if (Number.isFinite(minValue)) {
        params.push(minValue);
        valueClause += ` AND ${OPEN_VALUE} >= $${params.length}`;
      }
      if (Number.isFinite(maxValue)) {
        params.push(maxValue);
        valueClause += ` AND ${OPEN_VALUE} <= $${params.length}`;
      }

      // Last activity — the most recent message either way.
      //
      // messages_loc_contact_ts covers exactly this lookup, so the subquery is
      // an index scan rather than a scan of the contact's whole history.
      const LAST_ACTIVITY = `(
        SELECT MAX(m.message_timestamp)
          FROM messages m
         WHERE m.location_id = c.location_id
           AND m.contact_id  = c.contact_id
      )`;
      let activityClause = '';
      if (Number.isFinite(activeWithin) && activeWithin > 0) {
        params.push(activeWithin);
        activityClause += ` AND ${LAST_ACTIVITY} >= now() - ($${params.length} || ' days')::interval`;
      }
      if (Number.isFinite(quietFor) && quietFor > 0) {
        params.push(quietFor);
        // NULL counts as quiet: a contact who has never messaged is the
        // quietest of all, and excluding them would hide exactly the people
        // this filter exists to surface.
        activityClause += ` AND (${LAST_ACTIVITY} IS NULL`
          + ` OR ${LAST_ACTIVITY} < now() - ($${params.length} || ' days')::interval)`;
      }

      // Has an open deal, or has none. A plain presence test, no parameter.
      let dealsClause = '';
      if (hasDeals === 'yes') dealsClause = `AND ${OPEN_VALUE} IS NOT NULL AND (
        SELECT COUNT(*) FROM opportunities o3
         WHERE o3.location_id = c.location_id AND o3.contact_id = c.contact_id
           AND o3.status = 'open' AND o3.is_deleted = false
           AND o3.deleted_at IS NULL AND o3.is_ghost = false) > 0`;
      if (hasDeals === 'no') dealsClause = `AND (
        SELECT COUNT(*) FROM opportunities o3
         WHERE o3.location_id = c.location_id AND o3.contact_id = c.contact_id
           AND o3.status = 'open' AND o3.is_deleted = false
           AND o3.deleted_at IS NULL AND o3.is_ghost = false) = 0`;

      let tagClause = '';
      if (tag) {
        params.push(tag);
        tagClause = `AND EXISTS (
          SELECT 1 FROM contact_tags ct
           WHERE ct.location_id = c.location_id
             AND ct.contact_id  = c.contact_id
             AND ct.tag_name    = $${params.length}
        )`;
      }
      // Everything pushed so far is a FILTER param; the keyset pushes cursor
      // params after this line. Snapshotting the length here is what lets the
      // count query reuse the same list — unlike a positional slice with one
      // ternary per filter, it cannot drift when a filter is added or
      // reordered, which is how "there is no parameter $n" happens.
      const filterParams = params.slice();

      // Sort key must match the cursor's — see utils/paginate.js.
      const TS = 'COALESCE(c.updated_at_ghl, c.created_at_ghl)';
      const ID = 'c.contact_id';
      const keyset = keysetClause({ tsExpr: TS, idExpr: ID, cursor }, params);

      const sql = `
        SELECT
          c.contact_id, c.first_name, c.last_name, c.email, c.phone,
          c.assigned_to, c.assigned_to_name,
          u.name AS owner_name, u.email AS owner_email,
          c.company_name, c.contact_type, c.address1, c.city, c.postal_code,
          c.country, c.timezone, c.created_at_ghl, c.updated_at_ghl,
          -- THE LINK, not just the typed label.
          --
          -- company_name above is free text someone typed; business_id is the
          -- relation to an actual business record (migration 056). The list
          -- returned only the first, so a card could show the word a rep had
          -- typed but never which business the contact is actually linked to
          -- — and so had no way to offer link/unlink the way the detail page
          -- does. The name is joined here rather than fetched per card.
          c.business_id,
          b.name AS business_name,
          c.dnd, c.dnd_email, c.dnd_sms, c.dnd_call, c.dnd_whatsapp,
          c.dnd_inbound, c.dnd_settings,
          -- Open tasks and live notes filed against this contact.
          --
          -- Shown on the card rather than behind Edit: whether someone has
          -- follow-up outstanding is the reason you scan a contact list, and
          -- it was only discoverable by opening each one.
          --
          -- Correlated subqueries, matching the deals aggregate below: a join
          -- would multiply the row and force a GROUP BY over every column.
          (SELECT COUNT(*)::int FROM tasks t
            WHERE t.location_id = c.location_id
              AND t.contact_id  = c.contact_id
              AND t.status <> 'completed'
              AND t.deleted_at IS NULL)                    AS open_task_count,
          (SELECT COUNT(*)::int FROM notes n
            WHERE n.location_id = c.location_id
              AND n.contact_id  = c.contact_id
              AND n.status = 'active')                     AS note_count,
          -- THE ITEMS, not only the counts — the first five open tasks and
          -- the five most recent notes. The design lists them on the card
          -- and in the list's pill menus; with counts alone the pill could
          -- only open the record. Capped so a contact with 200 notes does
          -- not drag 200 bodies into a 20-row page; the record has the rest.
          (SELECT COALESCE(json_agg(json_build_object(
                    'id', t.task_id, 'title', t.title, 'dueAt', t.due_at, 'status', t.status)
                    ORDER BY t.due_at ASC NULLS LAST), '[]'::json)
             FROM (SELECT task_id, title, due_at, status FROM tasks t
                    WHERE t.location_id = c.location_id
                      AND t.contact_id  = c.contact_id
                      AND t.status <> 'completed'
                      AND t.deleted_at IS NULL
                    ORDER BY t.due_at ASC NULLS LAST
                    LIMIT 5) t)                               AS open_tasks,
          (SELECT COALESCE(json_agg(json_build_object(
                    'id', n.note_id, 'title', n.title, 'body', left(n.body, 160),
                    'createdAt', COALESCE(n.created_at_ghl, n.imported_at))
                    ORDER BY COALESCE(n.created_at_ghl, n.imported_at) DESC), '[]'::json)
             FROM (SELECT note_id, title, body, created_at_ghl, imported_at FROM notes n
                    WHERE n.location_id = c.location_id
                      AND n.contact_id  = c.contact_id
                      AND n.status = 'active'
                    ORDER BY COALESCE(n.created_at_ghl, n.imported_at) DESC
                    LIMIT 5) n)                               AS recent_notes,
          -- Open deals as chips: name, value, stage, and whether this contact
          -- is the deal's primary. Aggregated in the query so a 20-row page is
          -- one round trip rather than 20 lookups.
          (
            SELECT COALESCE(json_agg(json_build_object(
                     'id',      o.opportunity_id,
                     'name',    o.name,
                     'value',   o.monetary_value,
                     'stage',   o.current_stage_name,
                     'primary', o.contact_id = c.contact_id
                   ) ORDER BY o.monetary_value DESC NULLS LAST), '[]'::json)
              FROM opportunities o
             WHERE o.location_id = c.location_id
               AND o.status = 'open'
               AND o.is_deleted = false
               AND o.deleted_at IS NULL
               AND o.is_ghost   = false
               AND (
                 o.contact_id = c.contact_id
                 -- Also the deals this contact is merely linked to: an
                 -- architect is on the deal without being its primary, and
                 -- the card has to show it.
                 OR EXISTS (
                   SELECT 1 FROM opportunity_contacts oc
                    WHERE oc.location_id     = c.location_id
                      AND oc.opportunity_id  = o.opportunity_id
                      AND oc.contact_id      = c.contact_id
                      AND oc.association_id  = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
                 )
               )
          )                                                    AS deals,
          (
            SELECT COALESCE(array_agg(ct.tag_name ORDER BY ct.applied_at), ARRAY[]::text[])
              FROM contact_tags ct
             WHERE ct.location_id = c.location_id
               AND ct.contact_id  = c.contact_id
               AND ct.removed_at IS NULL
          )                                                    AS tags
        FROM contacts c
        LEFT JOIN users u
          ON u.location_id = c.location_id
         AND u.user_id     = c.assigned_to
        -- LEFT, and filtered on is_active: a business deleted in GHL is kept
        -- and marked inactive, and the contact still points at it. An inner
        -- join would drop the whole contact; this drops only the name.
        LEFT JOIN businesses b
          ON b.location_id = c.location_id
         AND b.business_id = c.business_id
         AND b.is_active   = true
       WHERE c.location_id = $1
         AND c.deleted_at IS NULL
         ${qClause}
         ${typeClause}
         ${ownerClause}
         ${tagClause}
         ${valueClause}
         ${activityClause}
         ${dealsClause}
        ${keyset}
        ${orderBy({ tsExpr: TS, idExpr: ID })}
        LIMIT ${limit + 1}
      `;
      const r = await client.query(sql, params);

      // The REAL total for this filter, not the page size. The badge used to
      // read "20+" and then "25" as you scrolled, which told a rep nothing.
      // Same WHERE as the page minus the keyset, so the two can never
      // disagree. Its own query rather than COUNT(*) OVER (), which would run
      // per row of a page that already carries correlated subqueries.
      const countSql = `
        SELECT count(*)::int AS n
          FROM contacts c
         WHERE c.location_id = $1
           AND c.deleted_at IS NULL
           ${qClause}
           ${typeClause}
           ${ownerClause}
           ${tagClause}
           ${valueClause}
           ${activityClause}
           ${dealsClause}`;
      const c2 = await client.query(countSql, filterParams);
      return { rows: r.rows, total: c2.rows[0]?.n ?? null };
    });

    const page = toPage(rows.rows, limit, (c) => ({ ts: c.updated_at_ghl || c.created_at_ghl, id: c.contact_id }));
    res.json({
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      contacts: page.rows.map((c) => ({
        id: c.contact_id,
        firstName: c.first_name,
        lastName: c.last_name,
        // NEVER null: ContactsTab rendered `c.name || '—'`, so a contact
        // with no first/last name showed a dash while its email sat in the
        // very next column. See contactLabel.
        name: contactLabel(c),
        email: c.email,
        phone: c.phone,
        // The typed label. Kept because GHL holds it and some contacts have
        // nothing else; it is no longer offered as an editable field.
        business: c.company_name,
        // The actual link, and the name of what it points at. Same two keys
        // the detail route returns, so the card and the detail page can share
        // one picker component rather than each inventing a shape.
        businessId: c.business_id || null,
        businessName: c.business_name || null,
        contactType: c.contact_type,
        owner: c.owner_name || c.assigned_to_name || c.owner_email || c.assigned_to || null,
        assignedTo: c.assigned_to,
        openTaskCount: Number(c.open_task_count || 0),
        noteCount: Number(c.note_count || 0),
        // The first few items themselves — see open_tasks / recent_notes in
        // the query. pg hands json columns back parsed.
        tasks: Array.isArray(c.open_tasks) ? c.open_tasks : [],
        notes: Array.isArray(c.recent_notes) ? c.recent_notes : [],
        dnd: dndOf(c),
        // "14 Priory Lane, Harpenden AL5 2FE" — city and postcode read as one
        // unit, and the default country is dropped: every Crittall contact is
        // UK, so printing it on every card is noise. Same shaping as the Deal
        // card uses, so an address never renders two ways.
        address: [
          c.address1,
          [c.city, c.postal_code].filter(Boolean).join(' '),
          c.country && c.country !== 'United Kingdom' ? c.country : null
        ].filter(Boolean).join(', ') || null,
        timezone: c.timezone,
        // Derived from `deals`, not counted separately. A second COUNT(*) with
        // a narrower WHERE (owned deals only) disagreed with the chips below on
        // any contact merely LINKED to a deal — the card would read "1 open
        // deal" above two chips.
        openDeals: (c.deals || []).length,
        deals: (c.deals || []).map((d) => ({
          id: d.id,
          name: d.name || 'Unnamed deal',
          value: d.value != null ? Number(d.value) : null,
          stage: d.stage || null,
          primary: d.primary === true
        })),
        tags: c.tags || [],
        accent: accentFor(c.contact_id),
        createdAt: c.created_at_ghl,
        updatedAt: c.updated_at_ghl
      })),
      totalCount: rows.total
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/contacts failed');
    next(err);
  }
});

// GET /api/contacts/:id — one full contact + all their open deals.
// Powers the "click a contact → contact record" panel (future — mockup
// spec's contactView).

contactsRouter.get('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const contactId = req.params.id;

  try {
    const result = await withTenant(locationId, async (client) => {
      const c = await client.query(
        `SELECT *
           FROM contacts
          WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL`,
        [locationId, contactId]
      );
      if (!c.rowCount) return null;

      // EVERY deal this contact is on — as primary OR as an additional
      // contact. Matching only opportunities.contact_id found the primary's
      // deals and none of the ones they were merely added to, so a follower's
      // contact record showed "no deals" while GHL plainly showed one, and
      // the "file this message against a deal" picker had nothing to offer.
      //
      // opportunity_contacts is the table that holds both kinds; the
      // attribution engine already reads it (see contactOppIds). The
      // contact_id clause is kept as a UNION arm rather than dropped, because
      // a deal whose OPPORTUNITIES_CONTACTS row has not arrived yet still
      // belongs to its primary contact.
      const deals = await client.query(
        `SELECT o.opportunity_id, o.name AS opportunity_name, o.current_stage_name,
                o.monetary_value, o.currency, o.status, o.pipeline_name, o.created_at_ghl,
                (o.contact_id = $2) AS is_primary_contact
           FROM opportunities o
          WHERE o.location_id = $1
            AND o.is_deleted  = false
            AND o.deleted_at IS NULL
            AND o.is_ghost    = false
            AND (
                  o.contact_id = $2
                  OR EXISTS (
                       SELECT 1 FROM opportunity_contacts oc
                        WHERE oc.location_id    = o.location_id
                          AND oc.opportunity_id = o.opportunity_id
                          AND oc.contact_id     = $2
                          -- Same association filter the contacts LIST uses.
                          -- That table could hold other association types;
                          -- only this one means "is on this deal".
                          AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
                     )
                )
          ORDER BY o.created_at_ghl DESC NULLS LAST`,
        [locationId, contactId]
      );

      const tags = await client.query(
        `SELECT tag_name FROM contact_tags
          WHERE location_id = $1 AND contact_id = $2 AND removed_at IS NULL
          ORDER BY applied_at`,
        [locationId, contactId]
      );

      // Every message for this contact, newest first, with the deal it's filed
      // to. The point of showing ALL of them here — rather than per deal — is
      // that a wrongly-filed message stands out: it's the one whose tag looks
      // wrong next to its content.
      const messages = await client.query(
        `SELECT m.message_id, m.message_channel, m.message_direction,
                m.message_body, m.message_timestamp, m.is_call,
                m.sender_name, m.sender_type, m.raw_message,
                cp.name AS provider_name,
                ct.transcript_text,
                mom.opportunity_id,
                mom.mapping_status,
                o.name AS opportunity_name
           FROM messages m
           LEFT JOIN message_opportunity_map mom
             ON mom.location_id = m.location_id
            AND mom.message_id  = m.message_id
            AND mom.superseded_at IS NULL
           LEFT JOIN opportunities o
             ON o.location_id    = m.location_id
            AND o.opportunity_id = mom.opportunity_id
           LEFT JOIN call_transcriptions ct
             ON ct.location_id = m.location_id AND ct.message_id = m.message_id
           LEFT JOIN conversation_providers cp
             ON cp.location_id = m.location_id
            AND cp.provider_id = m.conversation_provider_id
          WHERE m.location_id = $1
            AND m.contact_id  = $2
            AND m.deleted_at IS NULL
          ORDER BY m.message_timestamp DESC
          LIMIT 200`,
        [locationId, contactId]
      );

      // The linked business's NAME, for display beside the link. Looked up
      // rather than stored on the contact: the name lives on the business
      // record and renaming it there must not leave a stale copy here.
      let businessName = null;
      if (c.rows[0]?.business_id) {
        const b = await client.query(
          `SELECT name FROM businesses
            WHERE location_id = $1 AND business_id = $2 AND is_active = true`,
          [locationId, c.rows[0].business_id]
        );
        businessName = b.rows[0]?.name || null;
      }

      return {
        contact: c.rows[0],
        businessName,
        deals: deals.rows,
        // Inside withTenant so the definitions query runs under the same RLS
        // context — a folder list must not cross sub-accounts.
        customFieldGroups: await customFieldGroups(
          client, locationId, c.rows[0]?.custom_fields
        ),
        tags: tags.rows.map((r) => r.tag_name),
        messages: messages.rows
      };
    });

    if (!result) return res.status(404).json({ error: 'Contact not found' });

    const c = result.contact;
    res.json({
      id: c.contact_id,
      firstName: c.first_name,
      lastName: c.last_name,
      // As above — never null.
      name: contactLabel(c),
      email: c.email,
      phone: c.phone,
      business: c.company_name,
      // THE LINK, distinct from the free-text name above.
      //
      // `business` is GHL's companyName — a label someone typed, with no
      // record behind it. `businessId` is the actual link to a business
      // record (contacts.business_id, migration 056), and it is what the
      // Businesses page and every deal's business list read. Both are sent
      // because they mean different things and a contact can legitimately
      // have one without the other.
      businessId: c.business_id || null,
      businessName: result.businessName || null,
      contactType: c.contact_type,
      dnd: dndOf(c),
      // One section per GHL folder, each with its fields, types and values.
      customFieldGroups: result.customFieldGroups || [],
      address: [c.address1, c.city, c.postal_code, c.country].filter(Boolean).join(', ') || null,
      timezone: c.timezone,
      accent: accentFor(c.contact_id),
      tags: result.tags,
      deals: result.deals.map((d) => ({
        id: d.opportunity_id,
        name: d.opportunity_name,
        stage: d.current_stage_name,
        pipeline: d.pipeline_name,
        status: d.status,
        value: d.monetary_value != null
          ? new Intl.NumberFormat('en-GB', {
              style: 'currency', currency: d.currency || 'GBP', maximumFractionDigits: 0
            }).format(d.monetary_value)
          : null,
        createdAt: d.created_at_ghl
      })),
      // Secondary email/phone aren't promoted columns — GHL sends them as
      // additionalEmails / additionalPhones, so read them from the raw
      // payload rather than adding columns we may not need.
      secondaryEmails: extraList(c.raw_contact, 'additionalEmails', c.email),
      secondaryPhones: extraList(c.raw_contact, 'additionalPhones', c.phone),
      messages: result.messages.map((m) => {
        const isCall = m.is_call || /CALL|VOICEMAIL/i.test(m.message_channel || '');
        return {
          id: m.message_id,
          channel: normaliseContactChannel(m.message_channel, isCall),
          direction: m.message_direction === 'inbound' ? 'in' : 'out',
          // "Us" was a dishonest generic label when GHL's own payload omits
          // which rep sent an outbound message — see the identical fix and
          // rationale in routes/deals.js. This view doesn't join `users`
          // for a live name lookup (sender_name is the only name source
          // here), but sender_type + the connected-integration name still
          // say WHY there's no rep name instead of a blanket "Us".
          who: m.message_direction === 'inbound'
            ? [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Contact'
            : (m.sender_name || labelForSenderType(m.sender_type, m.provider_name)),
          body: isCall ? m.transcript_text : m.message_body,
          at: m.message_timestamp,
          // Which deal it's filed to. null = not attributed to any deal, which
          // the UI should show as "Unassigned" rather than hiding.
          dealId: m.opportunity_id || null,
          dealName: m.opportunity_name || null,
          mappingStatus: m.mapping_status || 'unassigned',
          // Same shape the deal timeline renders — see utils/attachments.js.
          attachments: proxyAttachments(locationId, extractAttachments(m.raw_message))
        };
      }),
      createdAt: c.created_at_ghl,
      updatedAt: c.updated_at_ghl
    });
  } catch (err) {
    logger.error({ err, contactId, locationId }, 'GET /api/contacts/:id failed');
    next(err);
  }
});

// ── PATCH /api/contacts/:id ───────────────────────────────────────────
// Edit the contact's own fields. Local-only for now: GHL write-back needs the
// contacts.write scope and its own error handling, so this updates our copy
// and marks it, rather than pretending the change reached GoHighLevel.


// ── PUT /api/contacts/:id/dnd ─────────────────────────────────────────
// Turn a channel on or off. Writes the same promoted columns the webhook
// writes (migration 052), so the AI draft gate and every deal card pick the
// change up immediately.
//
// Also local-only. Worth being explicit about the asymmetry: GHL remains the
// source of truth and a ContactDndUpdate webhook will overwrite this. Until
// write-back exists, treat this as "record what we know", not "tell GHL".

const DND_CHANNELS = { email: 'Email', sms: 'SMS', call: 'Call', whatsapp: 'WhatsApp' };

// ── PATCH /api/contacts/:id ────────────────────────────────────────────
//
// The first write endpoint in the app. It does NOT write to Postgres.
//
// GHL is the source of truth: we PUT the change, GHL applies it and fires
// ContactUpdate back at /webhooks/ghl, and handleContactUpsert writes our row
// from that payload. This route used to UPDATE the contacts table directly and
// never call GHL at all — which is worse than having no write path: the edit
// looked saved, then the next contactsSync silently overwrote it.
//
// The response returns GHL's echo, not our row, so the client can apply what
// GHL actually stored (including any phone reformatting it did) while the
// webhook reconciles Postgres a moment later.
// POST /api/contacts — create a contact in GHL.
//
// The row is landed LOCALLY in the same request, through the writer the
// ContactCreate webhook uses, rather than waiting for that webhook: the list
// the rep is looking at has to show the contact they just made, and the
// webhook can be seconds behind or, on a dropped delivery, never. The webhook
// then upserts over the same row harmlessly (COALESCE on every column).
contactsRouter.post('/', async (req, res, next) => {
  const { locationId } = req.session;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of contact fields' });
  }
  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      return res.status(409).json({ error: (await explainInactiveInstall(locationId)).message });
    }
    const contact = await createGhlContact(install, req.body);
    if (contact?.id) {
      try { await handleContactUpsert(install, contact); }
      catch (landErr) {
        logger.warn({ err: landErr, locationId, contactId: contact.id },
          'POST /api/contacts: created in GHL but the local row did not land — the webhook will');
      }
    }
    res.status(201).json({ contact, source: 'ghl' });
  } catch (err) {
    if (err instanceof ContactWriteError) {
      return res.status(err.status).json({ error: err.message, field: err.field || null, ...(err.reason ? { reason: err.reason } : {}) });
    }
    logger.error({ err, locationId }, 'POST /api/contacts failed');
    next(err);
  }
});

// DELETE /api/contacts/:id — delete in GHL, soft-delete here.
//
// Soft, not hard, locally: messages, notes, tasks and opportunity_contacts
// still point at this id, and the timeline on a deal this person was on
// should keep reading their name. Same treatment the ContactDelete webhook
// gives it, via the same function, so nothing diverges between the two.
contactsRouter.delete('/:id', async (req, res, next) => {
  const { locationId } = req.session;
  const contactId = req.params.id;
  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      return res.status(409).json({ error: (await explainInactiveInstall(locationId)).message });
    }
    await deleteGhlContact(install, contactId);
    try { await handleContactDelete(install, { id: contactId }); }
    catch (landErr) {
      logger.warn({ err: landErr, locationId, contactId },
        'DELETE /api/contacts/:id: deleted in GHL but the local row did not follow — the webhook will');
    }
    res.json({ ok: true, id: contactId });
  } catch (err) {
    if (err instanceof ContactWriteError) {
      return res.status(err.status).json({ error: err.message, field: err.field || null });
    }
    logger.error({ err, locationId, contactId }, 'DELETE /api/contacts/:id failed');
    next(err);
  }
});

contactsRouter.patch('/:id', async (req, res, next) => {
  const { locationId } = req.session;
  const contactId = req.params.id;

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of fields to change' });
  }

  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      return res.status(409).json({
        error: (await explainInactiveInstall(locationId)).message
      });
    }

    const contact = await updateGhlContact(install, contactId, req.body);

    // MIRROR THE BUSINESS LINK LOCALLY, rather than waiting to be told.
    //
    // GHL has no opportunities.business_id — a deal reaches a business only
    // through contacts.business_id (migration 056). So this PATCH is the one
    // write that links a business to a deal, and until now nothing wrote our
    // own row: we returned GHL's echo and waited for a webhook.
    //
    // That wait is the bug. GHL fires no ContactUpdate for a business-link
    // change — it emits a BUSINESSES_CONTACTS_ASSOCIATION relation swap
    // instead, which businessContactRelationWriter now handles. But relying
    // on that alone leaves the link invisible to us whenever the webhook is
    // slow, dropped, or retried out of order: the rep saw the business
    // appear and then vanish on the next read.
    //
    // We know what we just wrote and GHL accepted it, so we record it
    // ourselves. The webhook remains the authority for links made IN GHL and
    // simply writes the same value again; this only closes the window.
    //
    // 'businessId' in req.body, not a truthy check: null is a deliberate
    // UNLINK and must clear the column, where undefined means the caller
    // never mentioned it.
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'businessId')) {
      const nextBusinessId = req.body.businessId || null;
      try {
        // withTenant, not a bare query: this file's other writes all run
        // under RLS, and the policy is a second guard that this row really
        // belongs to the session's location.
        await withTenant(locationId, async (client) => {
          await client.query(
            `UPDATE contacts
                SET business_id = $3
              WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL`,
            [locationId, contactId, nextBusinessId]
          );
        });
      } catch (mirrorErr) {
        // GHL has the change; a local mirror that fails must not report the
        // save as failed. The webhook and the daily sync both still repair it.
        logger.warn(
          { err: mirrorErr, locationId, contactId },
          'PATCH /api/contacts/:id: business link saved in GHL but the local row did not follow'
        );
      }
    }

    res.json({ contact, source: 'ghl' });
  } catch (err) {
    if (err instanceof ContactWriteError) {
      // The field name travels so the UI can mark the offending input rather
      // than showing a banner that doesn't say which box is wrong.
      return res.status(err.status).json({ error: err.message, field: err.field || null, ...(err.reason ? { reason: err.reason } : {}) });
    }
    logger.error({ err, locationId, contactId }, 'PATCH /api/contacts/:id failed');
    next(err);
  }
});

contactsRouter.put('/:id/dnd', async (req, res, next) => {
  const locationId = req.locationId;
  const contactId = req.params.id;
  const { channel, blocked } = req.body || {};

  if (typeof blocked !== 'boolean') {
    return res.status(400).json({ error: 'blocked must be a boolean' });
  }
  const isAll = channel === 'all';
  const isInbound = channel === 'inbound';
  if (!isAll && !isInbound && !DND_CHANNELS[channel]) {
    return res.status(400).json({
      error: `channel must be all, inbound, or one of: ${Object.keys(DND_CHANNELS).join(', ')}`
    });
  }

  try {
    const dnd = await withTenant(locationId, async (client) => {
      if (isAll) {
        const r = await client.query(
          `UPDATE contacts SET dnd = $3, updated_at = now()
            WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL
            RETURNING dnd, dnd_email, dnd_sms, dnd_call, dnd_whatsapp,
                      dnd_inbound, dnd_settings`,
          [locationId, contactId, blocked]
        );
        return r.rows[0] || null;
      }

      // Per-channel lives in the dnd_settings JSONB, and the generated dnd_*
      // columns derive from it. GHL's polarity: status 'active' means the DND
      // rule is active, i.e. the channel is BLOCKED.
      const key = isInbound ? null : DND_CHANNELS[channel];
      const status = blocked ? 'active' : 'inactive';
      const sql = isInbound
        ? `UPDATE contacts
              SET inbound_dnd_settings =
                    jsonb_set(
                      COALESCE(inbound_dnd_settings, '{}'::jsonb),
                      '{all}',
                      jsonb_build_object('status', $3::text),
                      true
                    ),
                  updated_at = now()
            WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL
            RETURNING dnd, dnd_email, dnd_sms, dnd_call, dnd_whatsapp,
                      dnd_inbound, dnd_settings`
        : `UPDATE contacts
              SET dnd_settings =
                    jsonb_set(
                      COALESCE(dnd_settings, '{}'::jsonb),
                      ARRAY[$4::text],
                      jsonb_build_object('status', $3::text),
                      true
                    ),
                  updated_at = now()
            WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL
            RETURNING dnd, dnd_email, dnd_sms, dnd_call, dnd_whatsapp,
                      dnd_inbound, dnd_settings`;
      const params = isInbound
        ? [locationId, contactId, status]
        : [locationId, contactId, status, key];
      const r = await client.query(sql, params);
      return r.rows[0] || null;
    });

    if (!dnd) return res.status(404).json({ error: 'Contact not found' });
    logger.info({ locationId, contactId, channel, blocked }, 'contacts: dnd updated');
    res.json({ dnd: dndOf(dnd) });
  } catch (err) {
    logger.error({ err, locationId, contactId }, 'PUT /api/contacts/:id/dnd failed');
    next(err);
  }
});

// ── Tags ───────────────────────────────────────────────────────────────
//
// Separate from PATCH /:id on purpose. That route goes through
// buildContactPatch, which REFUSES `tags` — PUT /contacts/{id} replaces the
// whole array, so a partial list silently deletes the rest. These two
// endpoints are additive and can only touch the tags they're given, which is
// what makes tag editing safe to offer.
//
// Neither writes Postgres. ContactTagUpdate fires with the full new list and
// tagHistoryWriter.reconcileTags maintains tag_history plus the mirrored
// contacts.tags array — the only path that keeps history correct. The response
// carries GHL's post-change list so the UI can settle without waiting.

// Shared: confirm the contact is ours (under RLS) and the install is live.
async function contactTagPreflight(locationId, contactId) {
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
    throw new TagWriteError('That contact no longer exists', { status: 404 });
  }
  const install = await getActiveInstall(locationId);
  if (!install) {
    // reauth_required and uninstalled need different fixes (clear a flag vs
    // reinstall the app) and shared one message. See explainInactiveInstall.
    const { message, reason } = await explainInactiveInstall(locationId);
    throw new TagWriteError(message, { status: 409, reason });
  }
  return install;
}

function sendTagError(res, err, next, ctx) {
  if (err instanceof TagWriteError) {
    return res.status(err.status).json({ error: err.message, field: err.field || null, ...(err.reason ? { reason: err.reason } : {}) });
  }
  logger.error({ err, ...ctx }, 'contact tag write failed');
  return next(err);
}

// Files are held in MEMORY, not written to disk.
//
// These are form attachments — tens of KB to a few MB — and they are
// forwarded to GHL immediately. Disk storage would need a temp directory, a
// cleanup path for failed requests, and a disk-full failure mode, for no gain
// at this size.
//
// The limits are enforced HERE as well as at GHL: a 200 MB body would
// otherwise be read into memory in full before anyone rejected it.
const uploadFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    // GHL's own per-field ceiling is 15 files.
    files: 15,
    // 25 MB each. Larger than any quote or drawing this client sends, small
    // enough that fifteen at once cannot exhaust the process.
    fileSize: 25 * 1024 * 1024
  }
});

// POST /api/contacts/:id/custom-fields/:fieldKey/files
//
// Upload one or more files to a FILE_UPLOAD custom field.
//
// WHY IT PROXIES rather than the browser posting straight to GHL: the access
// token would have to reach the browser, and it is the credential that reads
// every contact in the sub-account. Going through here also means the contact
// is verified under RLS before a byte is forwarded, so an id from another
// sub-account fails as "not found" rather than being attempted upstream.
//
// multipart, field name `files`. multer keeps them in memory — these are form
// attachments, tens of KB to a few MB, and writing to disk would need a temp
// directory and a cleanup path for no gain at this size.
contactsRouter.post(
  '/:id/custom-fields/:fieldKey/files',
  uploadFiles.array('files', 15),
  async (req, res, next) => {
    const locationId = req.locationId;
    const contactId = req.params.id;
    const fieldKey = req.params.fieldKey;

    try {
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No file was sent', field: 'file' });
      }

      // Ownership + the field's own limit, in one round trip. The definition
      // lookup also proves the field EXISTS and is a FILE_UPLOAD — uploading
      // to a text field would be accepted by GHL and then be unreadable.
      const check = await withTenant(locationId, async (client) => {
        const { rows: c } = await client.query(
          `SELECT 1 FROM contacts
            WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL
            LIMIT 1`,
          [locationId, contactId]
        );
        const { rows: d } = await client.query(
          `SELECT field_type, raw_definition
             FROM ghl_custom_field_definitions
            WHERE location_id = $1
              AND object_type = 'contact'
              AND field_key   = $2
              AND is_active
            LIMIT 1`,
          [locationId, fieldKey]
        );
        return { contact: c.length > 0, def: d[0] || null };
      });

      if (!check.contact) {
        return res.status(404).json({ error: 'That contact was not found' });
      }
      if (!check.def) {
        return res.status(404).json({ error: 'That field was not found', field: 'fieldKey' });
      }
      if (String(check.def.field_type || '').toUpperCase() !== 'FILE_UPLOAD') {
        return res.status(400).json({
          error: 'That field does not take files', field: 'fieldKey'
        });
      }

      const install = await getActiveInstall(locationId);
      if (!install) {
        const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
      }

      const uploaded = await uploadToCustomField(install, {
        recordId: contactId,
        fieldKey,
        files,
        // The field's own ceiling when it states one; the service falls back
        // to GHL's 15.
        maxFiles: check.def.raw_definition?.maxFileLimit
      });

      // Nothing is written locally. The ContactUpdate webhook carries the new
      // field value and is what updates our row, the same as every other
      // contact edit.
      return res.json({ files: uploaded });
    } catch (err) {
      if (err instanceof UploadError) {
        return res.status(err.status || 400).json({ error: err.message, field: err.field, ...(err.reason ? { reason: err.reason } : {}) });
      }
      logger.error({ err, locationId, contactId, fieldKey }, 'file upload failed');
      return next(err);
    }
  }
);

// POST /api/contacts/:id/tags   body: { tags: ["vip", "newsletter"] }
//
// Additive. Tags absent from the location's catalogue are created there by GHL.
// `tagsAdded` is empty when they were all already on the contact — a no-op, not
// a failure, so this still returns 200.
contactsRouter.post('/:id/tags', async (req, res, next) => {
  const locationId = req.locationId;
  const contactId = req.params.id;

  try {
    const install = await contactTagPreflight(locationId, contactId);
    const result = await addGhlContactTags(install, contactId, req.body);
    res.json({ ...result, source: 'ghl' });
  } catch (err) {
    sendTagError(res, err, next, { locationId, contactId });
  }
});

// DELETE /api/contacts/:id/tags   body: { tags: ["vip"] }
//
// Only removes what's actually on the contact. A tag it doesn't have is
// ignored rather than erroring.
contactsRouter.delete('/:id/tags', async (req, res, next) => {
  const locationId = req.locationId;
  const contactId = req.params.id;

  try {
    const install = await contactTagPreflight(locationId, contactId);
    const result = await removeGhlContactTags(install, contactId, req.body);
    res.json({ ...result, source: 'ghl' });
  } catch (err) {
    sendTagError(res, err, next, { locationId, contactId });
  }
});

// GET /api/contacts/tags/catalogue — every tag defined in this location.
//
// Powers autocomplete, so a rep picks an existing tag rather than creating
// "hot-lead" beside "hot lead" and "Hot Lead". Read from OUR tags table
// (migration 018, refreshed by the daily tagsSync) rather than calling GHL per
// keystroke.
//
// Mounted before /:id routes would shadow it? No — Express matches in
// declaration order and '/tags/catalogue' has two segments, so /:id/tags
// cannot capture it. Kept explicit here because that is easy to get wrong.
// ── GET /api/contacts/:id/messages ─────────────────────────────────────
//
// Every message for this contact, with the deal each one is filed against.
// This is the view James asked for: somewhere a manager can see the messages
// that did NOT get attributed and file them by hand.
//
// UNLIKE the deal timeline, this returns messages whatever their mapping —
// mapped, manually resolved, ambiguous, unassigned. That is the point: the
// deal timeline shows what belongs to a deal, this shows everything and lets
// someone decide.
//
// ?unlinkedOnly=true narrows it to the ones needing attention.
contactsRouter.get('/:id/messages', async (req, res, next) => {
  const locationId = req.locationId;
  const contactId = req.params.id;
  const unlinkedOnly = req.query.unlinkedOnly === 'true';
  const limit = parseLimit(req.query.limit, 100, 300);

  try {
    const rows = await withTenant(locationId, async (client) => {
      const r = await client.query(
        `SELECT m.id, m.message_id, m.message_channel, m.message_direction,
                m.message_body, m.message_timestamp, m.subject, m.thread_id,
                m.sender_name, m.sender_type, m.is_call,
                cp.name AS provider_name,
                -- Needed for attachments: the deal timeline showed a message's
                -- PDF while the same message here showed nothing at all.
                m.raw_message,
                mom.opportunity_id AS mapped_opp_id,
                mom.mapping_status,
                mom.reviewed_by    AS mapped_by,
                o.name             AS opportunity_name,
                o.status           AS opportunity_status
           FROM messages m
           LEFT JOIN message_opportunity_map mom
                  ON mom.location_id = m.location_id
                 AND mom.message_id  = m.message_id
                 AND mom.superseded_at IS NULL
           LEFT JOIN opportunities o
                  ON o.location_id    = m.location_id
                 AND o.opportunity_id = mom.opportunity_id
           LEFT JOIN conversation_providers cp
                  ON cp.location_id = m.location_id
                 AND cp.provider_id = m.conversation_provider_id
          WHERE m.location_id = $1
            AND m.contact_id  = $2
            AND m.deleted_at IS NULL
            ${unlinkedOnly ? "AND (mom.opportunity_id IS NULL)" : ''}
          ORDER BY m.message_timestamp DESC
          LIMIT ${limit}`,
        [locationId, contactId]
      );
      return r.rows;
    });

    res.json({
      messages: rows.map((m) => ({
        id: m.id,
        messageId: m.message_id,
        channel: m.message_channel,
        direction: m.message_direction,
        body: m.message_body,
        subject: m.subject,
        threadId: m.thread_id,
        // No name at all only happens outbound, when GHL's own payload
        // omitted which rep sent it — same honest fallback as deals.js and
        // this contact's own message list above, rather than the blanket
        // "Us" the frontend previously fell back to.
        senderName: m.sender_name || (
          m.message_direction === 'outbound'
            ? labelForSenderType(m.sender_type, m.provider_name)
            : null
        ),
        isCall: m.is_call === true,
        ts: m.message_timestamp,
        // The deal it is filed against, or null. `mappingStatus` distinguishes
        // "nothing matched" from "a manager put it here" — they look the same
        // on the row otherwise.
        deal: m.mapped_opp_id
          ? {
              id: m.mapped_opp_id,
              name: m.opportunity_name || 'Untitled deal',
              status: m.opportunity_status || null
            }
          : null,
        mappingStatus: m.mapping_status || 'unassigned',
        mappedManually: m.mapping_status === 'manually_resolved',
        mappedBy: m.mapped_by || null,
        // Same shape the deal timeline renders — see utils/attachments.js.
        attachments: proxyAttachments(locationId, extractAttachments(m.raw_message))
      })),
      unlinkedOnly
    });
  } catch (err) {
    logger.error({ err, locationId, contactId }, 'GET /api/contacts/:id/messages failed');
    next(err);
  }
});

// ── PUT /api/contacts/:id/messages/mapping ─────────────────────────────
//
// Bulk-assign messages to a deal. Body: { messageIds: [...], opportunityId }
//
// opportunityId null unlinks them. Local only — GHL has no concept of a
// message belonging to a deal, so there is nothing to write upstream.
//
// Each is recorded as `manually_resolved`, which the attribution engine skips
// on every later run.
contactsRouter.put('/:id/messages/mapping', async (req, res, next) => {
  const locationId = req.locationId;
  const contactId = req.params.id;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of changes' });
  }
  const { messageIds, opportunityId = null } = body;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'Pick at least one message', field: 'messageIds' });
  }
  // A generous cap rather than none: a runaway selection would hold a
  // connection for minutes and time out halfway, leaving a partial result
  // nobody can see.
  if (messageIds.length > 500) {
    return res.status(400).json({
      error: 'Move at most 500 messages at a time', field: 'messageIds'
    });
  }

  try {
    const check = await withTenant(locationId, async (client) => {
      if (opportunityId) {
        const t = await client.query(
          `SELECT 1 FROM opportunities o
            WHERE o.location_id = $1 AND o.opportunity_id = $2
              AND o.is_deleted = false AND o.deleted_at IS NULL
              -- PRIMARY **or** additional contact.
              --
              -- Matching opportunities.contact_id alone tests the primary
              -- only, so a deal offered to an additional contact — the list
              -- reads opportunity_contacts and correctly showed it — was
              -- then rejected on save with "that deal is not on this
              -- contact". The UI and the guard disagreed about what being
              -- on a deal means.
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
          [locationId, opportunityId, contactId]
        );
        if (!t.rowCount) return { error: 'That deal is not on this contact' };
      }
      // Every id must belong to THIS contact. Without this a caller could
      // move another contact's messages by passing their ids.
      const owned = await client.query(
        `SELECT message_id FROM messages
          WHERE location_id = $1 AND contact_id = $2
            AND message_id = ANY($3::text[]) AND deleted_at IS NULL`,
        [locationId, contactId, messageIds]
      );
      return { owned: owned.rows.map((r) => r.message_id) };
    });

    if (check.error) return res.status(400).json({ error: check.error });

    const owned = check.owned;
    const rejected = messageIds.filter((id) => !owned.includes(id));

    let moved = 0;
    for (const messageId of owned) {
      try {
        await manualResolve({
          locationId,
          messageId,
          opportunityId,
          reviewedBy: req.session?.userId || 'unknown',
          reviewNote: opportunityId ? 'bulk assigned from contact record' : 'bulk unlinked'
        });
        moved += 1;
      } catch (err) {
        // One failure must not lose the rest of the batch.
        logger.warn({ err, locationId, messageId }, 'bulk mapping: one message failed');
      }
    }

    logger.info(
      { locationId, contactId, opportunityId, requested: messageIds.length, moved },
      'messages bulk-mapped by hand'
    );
    // `rejected` is reported rather than silently dropped — a caller sending
    // 20 ids and seeing "12 moved" needs to know which 8 were not theirs.
    res.json({ ok: true, moved, rejected });
  } catch (err) {
    logger.error({ err, locationId, contactId }, 'PUT /api/contacts/:id/messages/mapping failed');
    next(err);
  }
});

contactsRouter.get('/tags/catalogue', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const tags = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT name, namespace FROM tags
          WHERE location_id = $1
          ORDER BY name ASC
          LIMIT 2000`,
        [locationId]
      );
      return rows;
    });
    res.json({
      tags: tags.map((t) => ({ name: t.name, namespace: t.namespace || null })),
      totalCount: tags.length
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/contacts/tags/catalogue failed');
    next(err);
  }
});
