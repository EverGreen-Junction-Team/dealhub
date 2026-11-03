import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import { extractAttachments } from '../utils/attachments.js';
import { parseLimit, decodeCursor, keysetClause, orderBy, toPage } from '../utils/paginate.js';
import { CHANNEL_ACCENT, CHANNEL_ICON, normaliseChannel } from '../utils/channels.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import {
  createGhlBusiness, updateGhlBusiness, deleteGhlBusiness,
  assertBusinessId, BusinessWriteError
} from '../services/ghlBusinessWrite.js';

export const businessesRouter = express.Router();
businessesRouter.use(requireSession);

// Businesses — the roll-up view.
//
// A business is the level above a deal: one company, several contacts, several
// deals, and one conversation stream across all of them. The deal-by-deal view
// structurally cannot show that last part, which is the whole reason this page
// exists.
//
// Rows come from the `businesses` table, populated by the daily businessesSync
// (GHL fires no webhooks for businesses). The link to everything else is
// contacts.business_id → deals via opportunities.contact_id.

const ACCENTS = ['sky', 'plum', 'clay', 'gold', 'rose', 'teal', 'pine'];
function accentFor(id) {
  if (!id) return 'gray';
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(h) % ACCENTS.length];
}

// The GHL "Company Info" fields, in the order the design lays them out.
// `key` is the merge-field identity shown in grey beside each label — it's what
// makes the page self-documenting about which GHL field a value came from.
//
// `writable: false` marks a field the API will not accept, so the UI can render
// it read-only rather than offering an edit that silently fails. Everything here
// is writable today; the flag exists because customFields is documented as
// rejected ("Custom fields are not supported yet") and will land here when it
// arrives.
const COMPANY_INFO_FIELDS = [
  { name: 'name',       label: 'Company name', key: '{{business.name}}',        column: 'name',        type: 'text' },
  { name: 'description',label: 'Description',  key: '{{business.description}}', column: 'description', type: 'multiline' },
  { name: 'website',    label: 'Website',      key: '{{business.website}}',     column: 'website',     type: 'url' },
  { name: 'email',      label: 'Email',        key: '{{business.email}}',       column: 'email',       type: 'email' },
  { name: 'phone',      label: 'Phone',        key: '{{business.phone}}',       column: 'phone',       type: 'phone' },
  { name: 'address',    label: 'Address',      key: '{{business.address}}',     column: 'address',     type: 'text' },
  { name: 'city',       label: 'City',         key: '{{business.city}}',        column: 'city',        type: 'text' },
  { name: 'state',      label: 'State',        key: '{{business.state}}',       column: 'state',       type: 'text' },
  { name: 'postalCode', label: 'Postal code',  key: '{{business.postalcode}}',  column: 'postal_code', type: 'text' },
  { name: 'country',    label: 'Country',      key: '{{business.country}}',     column: 'country',     type: 'select' },
  // Promoted out of raw_business by migration 059. domainname is UNIQUE PER
  // LOCATION on the public API, so the current value has to be visible before
  // anyone changes it — otherwise a clash is an opaque 422.
  { name: 'domainname', label: 'Domain',       key: '{{business.domainname}}',  column: 'domain_name', type: 'domain' }
];

function companyInfo(row) {
  return COMPANY_INFO_FIELDS.map((f) => ({
    name: f.name,
    label: f.label,
    key: f.key,
    type: f.type,
    writable: f.writable !== false,
    value: row[f.column] ?? null
  }));
}

function shapeBusiness(row) {
  return {
    id: row.business_id,
    name: row.name || 'Unnamed business',
    // Distinguish "GHL has no name" from a name we chose to display. The UI
    // shouldn't let an unnamed business look like a real one.
    hasName: !!row.name,
    accent: accentFor(row.business_id),
    description: row.description || null,
    website: row.website || null,
    email: row.email || null,
    phone: row.phone || null,
    address: row.address || null,
    city: row.city || null,
    state: row.state || null,
    postalCode: row.postal_code || null,
    country: row.country || null,
    // Migration 059. domainname is unique per location in GHL, so the current
    // value must be visible before anyone edits it.
    domainname: row.domain_name || null,
    // Normalised to a single url. GHL's shape is an array of { url, meta? }
    // capped at one entry, and every read we do wants the url — but the array
    // is what goes back on a write, so keep both.
    companylogo: row.company_logo || null,
    logoUrl: Array.isArray(row.company_logo) && row.company_logo[0]?.url
      ? row.company_logo[0].url
      : null,
    isActive: row.is_active !== false,
    contactCount: Number(row.contact_count || 0),
    dealCount: Number(row.deal_count || 0),
    openDealCount: Number(row.open_deal_count || 0),
    totalValue: row.total_value != null ? Number(row.total_value) : 0,
    messageCount: Number(row.message_count || 0),
    lastActivityAt: row.last_activity_at || null,
    updatedAtGhl: row.updated_at_ghl || null,
    lastSyncedAt: row.last_synced_at || null,
    companyInfo: companyInfo(row)
  };
}

// The roll-up counts, as a correlated subquery block shared by the list and
// detail queries.
//
// Deals reach a business only through contacts: opportunities carry contact_id,
// contacts carry business_id. There's no opportunities.business_id in GHL.
const ROLLUP = `
  (SELECT count(*) FROM contacts ct
    WHERE ct.location_id = b.location_id
      AND ct.business_id = b.business_id
      AND ct.deleted_at IS NULL) AS contact_count,
  (SELECT count(*) FROM opportunities o
     JOIN contacts ct ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
    WHERE o.location_id = b.location_id
      AND ct.business_id = b.business_id
      AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false) AS deal_count,
  (SELECT count(*) FROM opportunities o
     JOIN contacts ct ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
    WHERE o.location_id = b.location_id
      AND ct.business_id = b.business_id
      AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false
      AND o.status = 'open') AS open_deal_count,
  (SELECT COALESCE(sum(o.monetary_value), 0) FROM opportunities o
     JOIN contacts ct ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
    WHERE o.location_id = b.location_id
      AND ct.business_id = b.business_id
      AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false) AS total_value,
  (SELECT count(*) FROM messages m
     JOIN contacts ct ON ct.location_id = m.location_id AND ct.contact_id = m.contact_id
    WHERE m.location_id = b.location_id
      AND ct.business_id = b.business_id
      AND m.deleted_at IS NULL) AS message_count,
  (SELECT max(m.message_timestamp) FROM messages m
     JOIN contacts ct ON ct.location_id = m.location_id AND ct.contact_id = m.contact_id
    WHERE m.location_id = b.location_id
      AND ct.business_id = b.business_id
      AND m.deleted_at IS NULL) AS last_activity_at
`;

// The list's sort orders, each with the keyset it pages on. All newest /
// largest first.
//
//   recent   — last updated in GHL (the original, and still the default)
//   activity — newest message with anyone at the business (the design's
//              default on the Businesses toolbar)
//   created  — newest added
//   value    — total deal value
//
// `activity` and `value` are per-business aggregates, computed in a LATERAL
// join so the WHERE (keyset), ORDER BY and cursor all read the same column.
// No name sort: the cursor carries a timestamp or a number, not text — and a
// business renamed mid-scroll would repeat or vanish between pages.
const BUSINESS_SORTS = {
  recent:   { tsExpr: 'b.updated_at_ghl', cursorOf: (b) => ({ ts: b.updated_at_ghl, id: b.business_id }) },
  activity: { tsExpr: 'srt.last_activity_at', cursorOf: (b) => ({ ts: b.sort_activity, id: b.business_id }) },
  created:  { tsExpr: 'b.created_at_ghl', cursorOf: (b) => ({ ts: b.created_at_ghl, id: b.business_id }) },
  value:    { numExpr: 'srt.total_value', cursorOf: (b) => ({ num: b.sort_value, id: b.business_id }) }
};

// The aggregates the `activity` and `value` sorts page on. Same joins as the
// ROLLUP subqueries (a business reaches messages and deals only through its
// contacts), as one LATERAL so it is computed once per row.
const SORT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      (SELECT max(m.message_timestamp) FROM messages m
         JOIN contacts ct ON ct.location_id = m.location_id AND ct.contact_id = m.contact_id
        WHERE m.location_id = b.location_id
          AND ct.business_id = b.business_id
          AND m.deleted_at IS NULL)                                   AS last_activity_at,
      (SELECT sum(o.monetary_value) FROM opportunities o
         JOIN contacts ct ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
        WHERE o.location_id = b.location_id
          AND ct.business_id = b.business_id
          AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false) AS total_value
  ) srt ON true`;

// GET /api/businesses — cursor-paginated list.
//   ?q=<search>   name / email / city / website
//   ?sort=recent|activity|created|value   default recent
//   ?limit=N      default 20, max 100
//   ?cursor=...   opaque, from the previous page
businessesRouter.get('/', async (req, res) => {
  const { locationId } = req.session;
  const limit = parseLimit(req.query.limit);
  const q = (req.query.q || '').trim();
  const sortKey = Object.prototype.hasOwnProperty.call(BUSINESS_SORTS, req.query.sort)
    ? req.query.sort
    : 'recent';
  const sort = BUSINESS_SORTS[sortKey];

  let cursor = null;
  if (req.query.cursor) {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
    // A cursor from a different sort carries the other kind of key — a date
    // where a number is expected, or the reverse — and would page against
    // an unrelated column. Refuse it rather than return a wrong page.
    const numeric = 'num' in cursor;
    if (numeric !== !!sort.numExpr) return res.status(400).json({ error: 'Invalid cursor' });
  }

  try {
    const params = [locationId];
    const where = [
      'b.location_id = $1',
      // Soft-deleted businesses stay in the table for the contact links but
      // don't belong on the page.
      'b.is_active = true'
    ];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(
        lower(coalesce(b.name, ''))    LIKE ${p} OR
        lower(coalesce(b.email, ''))   LIKE ${p} OR
        lower(coalesce(b.city, ''))    LIKE ${p} OR
        lower(coalesce(b.website, '')) LIKE ${p}
      )`);
    }

    // Keyset on (sort key, business_id) — see BUSINESS_SORTS above.
    const ID = 'b.business_id';
    const keyArgs = { tsExpr: sort.tsExpr, numExpr: sort.numExpr, idExpr: ID };
    // Returns a clause already prefixed with AND, or '' — see utils/paginate.js.
    const keyset = keysetClause({ ...keyArgs, cursor }, params);
    // Only the aggregate sorts need the LATERAL; the plain ones skip its cost.
    const lateral = sortKey === 'activity' || sortKey === 'value' ? SORT_LATERAL : '';

    const { rows } = await withTenant(locationId, (client) =>
      client.query(
        `SELECT b.business_id, b.name, b.description, b.website, b.email, b.phone,
                b.address, b.city, b.state, b.postal_code, b.country,
                b.domain_name, b.company_logo,
                b.is_active, b.updated_at_ghl, b.created_at_ghl, b.last_synced_at,
                ${lateral ? 'srt.last_activity_at AS sort_activity, srt.total_value AS sort_value,' : ''}
                ${ROLLUP}
           FROM businesses b
           ${lateral}
          WHERE ${where.join(' AND ')}
          ${keyset}
          ${orderBy(keyArgs)}
          LIMIT ${limit + 1}`,
        params
      )
    );

    const page = toPage(rows, limit, sort.cursorOf);

    res.json({
      businesses: page.rows.map(shapeBusiness),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      sort: sortKey
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/businesses failed');
    res.status(500).json({ error: 'Could not load businesses' });
  }
});

// GET /api/businesses/:id — one business, with its contacts and deals.
//
// Conversations are a separate paginated call: a business with two years of
// history has thousands of messages and they must not all land in this
// response.
businessesRouter.get('/:id', async (req, res) => {
  const { locationId } = req.session;
  const businessId = req.params.id;

  try {
    const result = await withTenant(locationId, async (client) => {
      const b = await client.query(
        `SELECT b.business_id, b.name, b.description, b.website, b.email, b.phone,
                b.address, b.city, b.state, b.postal_code, b.country,
                b.domain_name, b.company_logo,
                b.is_active, b.updated_at_ghl, b.last_synced_at,
                ${ROLLUP}
           FROM businesses b
          WHERE b.location_id = $1 AND b.business_id = $2`,
        [locationId, businessId]
      );
      if (b.rows.length === 0) return null;

      const contacts = await client.query(
        `SELECT ct.contact_id, ct.first_name, ct.last_name, ct.email, ct.phone,
                ct.contact_type, ct.company_name,
                (SELECT count(*) FROM opportunities o
                  WHERE o.location_id = ct.location_id
                    AND o.contact_id  = ct.contact_id
                    AND o.is_deleted = false AND o.deleted_at IS NULL
                    AND o.is_ghost = false) AS deal_count
           FROM contacts ct
          WHERE ct.location_id = $1
            AND ct.business_id = $2
            AND ct.deleted_at IS NULL
          ORDER BY ct.first_name NULLS LAST, ct.last_name NULLS LAST`,
        [locationId, businessId]
      );

      // current_stage_name / pipeline_name are denormalised onto opportunities
      // and are what the deals route reads — no join to pipeline_stages needed.
      const deals = await client.query(
        `SELECT o.opportunity_id, o.name, o.monetary_value, o.status,
                o.contact_id, o.current_stage_name, o.pipeline_name
           FROM opportunities o
           JOIN contacts ct
             ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
          WHERE o.location_id = $1
            AND ct.business_id = $2
            AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false
          ORDER BY o.monetary_value DESC NULLS LAST`,
        [locationId, businessId]
      );

      return { business: b.rows[0], contacts: contacts.rows, deals: deals.rows };
    });

    if (!result) return res.status(404).json({ error: 'Business not found' });

    res.json({
      business: shapeBusiness(result.business),
      contacts: result.contacts.map((c) => ({
        id: c.contact_id,
        name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed contact',
        initials: initialsOf(c.first_name, c.last_name),
        accent: accentFor(c.contact_id),
        email: c.email || null,
        phone: c.phone || null,
        role: c.contact_type || null,
        dealCount: Number(c.deal_count || 0)
      })),
      deals: result.deals.map((d) => ({
        id: d.opportunity_id,
        name: d.name || 'Unnamed deal',
        stage: d.current_stage_name || null,
        pipeline: d.pipeline_name || null,
        status: d.status || null,
        value: d.monetary_value != null ? Number(d.monetary_value) : null,
        contactId: d.contact_id
      }))
    });
  } catch (err) {
    logger.error({ err, locationId, businessId }, 'GET /api/businesses/:id failed');
    res.status(500).json({ error: 'Could not load the business' });
  }
});

// GET /api/businesses/:id/conversations — every message with any contact at
// this business, across all its deals, newest first.
//
// This is the view the deal hub can't produce. Each row carries the deal it was
// attributed to (or null → "Unassigned"), so a rep can see a message that
// arrived against no deal at all — which is exactly the message that otherwise
// goes unanswered.
businessesRouter.get('/:id/conversations', async (req, res) => {
  const { locationId } = req.session;
  const businessId = req.params.id;
  const limit = parseLimit(req.query.limit);
  const channel = (req.query.channel || '').trim().toUpperCase();

  let cursor = null;
  if (req.query.cursor) {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
  }

  try {
    const params = [locationId, businessId];
    const where = [
      'm.location_id = $1',
      'ct.business_id = $2',
      'm.deleted_at IS NULL'
    ];

    if (channel) {
      params.push(channel);
      // Match on the normalised value, so ?channel=SMS also catches the
      // TYPE_SMS / CUSTOM_SMS variants still present in older rows.
      where.push(`upper(coalesce(m.message_channel, '')) LIKE '%' || $${params.length} || '%'`);
    }

    const TS = 'm.message_timestamp';
    const ID = 'm.message_id';
    const keyset = keysetClause({ tsExpr: TS, idExpr: ID, cursor }, params);

    const { rows } = await withTenant(locationId, (client) =>
      client.query(
        `SELECT m.message_id, m.message_direction, m.message_channel,
                m.message_body, m.message_timestamp, m.raw_message,
                m.sender_name, m.is_call, m.call_duration_seconds,
                m.contact_id,
                ct.first_name, ct.last_name,
                ct2.transcript_text IS NOT NULL AND ct2.fetch_status = 'ok' AS has_transcript,
                mom.opportunity_id,
                o.name AS deal_name
           FROM messages m
           JOIN contacts ct
             ON ct.location_id = m.location_id AND ct.contact_id = m.contact_id
           -- LEFT, not JOIN: a message with no deal attribution is the most
           -- important row on this page. An inner join would hide it.
           LEFT JOIN message_opportunity_map mom
             ON mom.location_id = m.location_id
            AND mom.message_id  = m.message_id
            AND mom.superseded_at IS NULL
            AND mom.mapping_status = 'mapped'
           LEFT JOIN opportunities o
             ON o.location_id = m.location_id
            AND o.opportunity_id = mom.opportunity_id
           LEFT JOIN call_transcriptions ct2
             ON ct2.location_id = m.location_id AND ct2.message_id = m.message_id
          WHERE ${where.join(' AND ')}
          ${keyset}
          ${orderBy({ tsExpr: TS, idExpr: ID })}
          LIMIT ${limit + 1}`,
        params
      )
    );

    const page = toPage(rows, limit, (m) => ({
      ts: m.message_timestamp, id: m.message_id
    }));

    res.json({
      messages: page.rows.map((m) => {
        const ch = normaliseChannel(m.message_channel);
        const isCall = m.is_call || ch === 'CALL' || ch === 'VOICEMAIL';
        // Stored as 'inbound' / 'outbound' by messageWriter. Compare against
        // those exactly — an 'in' / 'out' test silently never matches.
        const isInbound = m.message_direction === 'inbound';
        return {
          id: m.message_id,
          channel: ch,
          channelAccent: CHANNEL_ACCENT[ch] || 'gray',
          channelIcon: CHANNEL_ICON[ch] || 'chat',
          direction: isInbound ? 'in' : 'out',
          contactId: m.contact_id,
          who: isInbound
            ? ([m.first_name, m.last_name].filter(Boolean).join(' ') || 'Contact')
            : (m.sender_name || 'Rep'),
          body: isCall
            ? `Call · ${formatDuration(m.call_duration_seconds)}${m.has_transcript ? '' : ' · no transcript'}`
            : (m.message_body || null),
          timestamp: m.message_timestamp,
          isCall,
          hasTranscript: !!m.has_transcript,
          // null → the UI shows "Unassigned"
          dealId: m.opportunity_id || null,
          dealName: m.deal_name || null,
          // raw_message was already selected here and never read — see
          // utils/attachments.js.
          attachments: extractAttachments(m.raw_message)
        };
      }),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    });
  } catch (err) {
    logger.error({ err, locationId, businessId }, 'GET /api/businesses/:id/conversations failed');
    res.status(500).json({ error: 'Could not load conversations' });
  }
});

function initialsOf(first, last) {
  const a = (first || '').trim()[0] || '';
  const b = (last || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return 'unknown length';
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return 'unknown length';
  if (s < 60) return `${Math.round(s)} sec`;
  return `${Math.round(s / 60)} min`;
}

// ── Writes ─────────────────────────────────────────────────────────────
//
// Scope is businesses.write — NOT contacts.write, and not the
// businesses.readonly the daily sync uses. The install needs reauthorising.
//
// Unlike contacts, notes and tags, businesses have NO WEBHOOKS. Nothing fires
// on create, update or delete — which is why businessesSync is a nightly cron.
// So ghlBusinessWrite applies the echoed response to Postgres itself; without
// that, a change would be invisible here for up to 24 hours.
//
// locationId is never taken from the caller. On create it comes from the
// session's install, so a client cannot create a business in another tenant.
// On update GHL doesn't accept it at all — a business cannot move location.

// Confirm the business is ours, under RLS, before aiming a write at it. A
// businessId from the browser would otherwise let a caller edit another
// location's record: GHL's own guard authorises against the BUSINESS's
// location, not the token's, for get/update/delete.
async function resolveBusinessForWrite(locationId, businessId) {
  assertBusinessId(businessId);

  const row = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT business_id, name
         FROM businesses
        WHERE location_id = $1 AND business_id = $2 AND is_active = true
        LIMIT 1`,
      [locationId, businessId]
    );
    return rows[0] || null;
  });

  if (!row) {
    // Same wording as a business that never existed — nothing leaks about
    // another tenant's data.
    throw new BusinessWriteError('That business no longer exists', { status: 404 });
  }

  const install = await getActiveInstall(locationId);
  if (!install) {
    // reauth_required and uninstalled need different fixes (clear a flag vs
    // reinstall the app) and shared one message. See explainInactiveInstall.
    const { message, reason } = await explainInactiveInstall(locationId);
    throw new BusinessWriteError(message, { status: 409, reason });
  }
  return { install, name: row.name };
}

function sendBusinessError(res, err, next, ctx) {
  if (err instanceof BusinessWriteError) {
    return res.status(err.status).json({ error: err.message, field: err.field || null, ...(err.reason ? { reason: err.reason } : {}) });
  }
  logger.error({ err, ...ctx }, 'business write failed');
  return next(err);
}

// POST /api/businesses — create a business in this sub-account.
//
// Body: { name, phone?, email?, website?, address?, city?, state?,
//         postalCode?, country?, description?, domainname?, companylogo? }
//
// locationId is NOT read from the body — it comes from the session.
businessesRouter.post('/', async (req, res, next) => {
  const locationId = req.locationId;

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of business fields' });
  }

  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }
    const business = await createGhlBusiness(install, req.body);
    res.status(201).json({ business, source: 'ghl' });
  } catch (err) {
    sendBusinessError(res, err, next, { locationId });
  }
});

// PATCH /api/businesses/:id — edit a business.
//
// Send only what changed. PATCH rather than PUT because that's what it is:
// GHL's endpoint is a PUT accepting a partial body.
businessesRouter.patch('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const businessId = req.params.id;

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of fields to change' });
  }

  try {
    const { install } = await resolveBusinessForWrite(locationId, businessId);
    const business = await updateGhlBusiness(install, businessId, req.body);
    res.json({ business, source: 'ghl' });
  } catch (err) {
    sendBusinessError(res, err, next, { locationId, businessId });
  }
});

// DELETE /api/businesses/:id
//
// A soft delete on both sides: GHL sets deleted: true, we set is_active = false
// and keep the row. businessesSync already reads is_active = false as "gone from
// GHL", so the two agree and a re-created business resurrects cleanly.
//
// Contacts are NOT deleted with it — contacts.business_id is deliberately not an
// FK (see migration 056), so they simply stop resolving to a business. Worth
// knowing: a delete quietly unlinks every contact that pointed at it.
businessesRouter.delete('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const businessId = req.params.id;

  try {
    const { install } = await resolveBusinessForWrite(locationId, businessId);
    await deleteGhlBusiness(install, businessId);
    res.json({ ok: true, id: businessId });
  } catch (err) {
    sendBusinessError(res, err, next, { locationId, businessId });
  }
});
