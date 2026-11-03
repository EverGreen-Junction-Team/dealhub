import express from 'express';
import multer from 'multer';
import { contactLabel } from '../utils/contactLabel.js';
import { extractAttachments } from '../utils/attachments.js';
import { proxyAttachments } from '../services/attachmentProxy.js';
import { uploadToCustomField, UploadError } from '../services/customFieldUpload.js';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import { parseLimit, decodeCursor, keysetClause, orderBy, toPage } from '../utils/paginate.js';
import {
  CHANNEL_ACCENT, CHANNEL_ICON, eventLabelFromRaw, normaliseChannel, channelOfRow
} from '../utils/channels.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import { manualResolve, attributeMessage } from '../services/attributionEngine.js';
import { sendGhlMessage, MessageWriteError } from '../services/ghlMessageWrite.js';
import { recordPendingDealLink, ENTITY_MESSAGE } from '../services/pendingDealLink.js';
import {
  uploadMessageAttachments, AttachmentError, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES
} from '../services/messageAttachmentUpload.js';
import {
  updateGhlOpportunity, setGhlOpportunityStatus, createGhlOpportunity,
  deleteGhlOpportunity, addGhlOpportunityFollowers, removeGhlOpportunityFollowers,
  fetchGhlLostReasons, OpportunityWriteError
} from '../services/ghlOpportunityWrite.js';
import {
  OUTCOME_REASON_FIELD, outcomeReasonFor, outcomeReasonKey, CLOSED_STATUSES
} from '../services/outcomeReason.js';
import {
  addDealContact, removeDealContact, AssociationError
} from '../services/ghlAssociations.js';
import { labelForSenderType } from '../services/messageSource.js';
import { pageTimeline } from '../utils/timelinePage.js';
import { emailAddr } from '../utils/email.js';
import {
  PROMOTED_CUSTOM_FIELDS, withPromotedFields, applyClearedCustomFields
} from '../services/opportunityFields.js';

export const dealsRouter = express.Router();
dealsRouter.use(requireSession);

// ── shared helpers ──────────────────────────────────────────────────────

// Stable contact-accent mapping. One of 7 accents per contact, deterministic
// on contact_id so the same person always renders in the same colour across
// the whole app.
const ACCENTS = ['sky', 'plum', 'clay', 'gold', 'rose', 'teal', 'pine'];
// client_type / product_system / product_type / first_contact_method are
// JSONB arrays as of migration 027 — they're GHL multi-selects, so a deal can
// carry several products at once. Flatten to a display string; a bare string
// (pre-027 rows, or a scalar someone wrote by hand) still renders.
// The opportunity columns that are ALSO custom fields in GHL.
//
// Each of these is stored twice: promoted to its own column by the upsert, and
// inside the custom_fields JSONB blob. They normally agree — but the blob is
// whatever the last event happened to carry, so it is empty on a deal whose
// upsert rolled back, and on any deal that predates the promotion. The column
// is the one the upsert maintains, so it is the reliable copy.
//
// The custom-field editor renders from the blob, which is why a deal could
// show "Not set" in the grid while the card above it displayed the value. The
// detail route now merges these columns INTO the blob it returns, keyed by the
// short field key the definitions endpoint reports — so the grid fills itself
// from whatever the database holds, with no per-field wiring in the UI.
//
// Adding a promoted column later means adding it HERE and nowhere else: the
// SELECT below builds its column list from this same array.
// PROMOTED_CUSTOM_FIELDS / withPromotedFields live in services/opportunityFields.js
// now — the AI's field tools need the same merge, and two copies would drift.

function flattenMulti(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const parts = value.filter((v) => v != null && v !== '').map(String);
    return parts.length ? parts.join(', ') : null;
  }
  const s = String(value).trim();
  return s || null;
}

function accentFor(contactId) {
  if (!contactId) return 'gray';
  let h = 5381;
  for (let i = 0; i < contactId.length; i++) h = ((h << 5) + h + contactId.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(h) % ACCENTS.length];
}

// ── GET /api/deals ───────────────────────────────────────────────────
// Newest INBOUND message attributed to a deal — the "Last customer message"
// column, and one of the sort keys. Defined once because the SELECT list and
// the ORDER BY / keyset predicate must use the IDENTICAL expression: a column
// alias is not visible to the keyset's WHERE clause, so the sort would
// silently order by a different value than the one on screen.
const LAST_CUSTOMER_TS = `(
                 SELECT MAX(m.message_timestamp) FROM messages m
                   JOIN message_opportunity_map mom
                     ON mom.location_id = m.location_id
                    AND mom.message_id  = m.message_id
                    AND mom.superseded_at IS NULL
                    AND mom.mapping_status IN ('mapped', 'manually_resolved')
                  WHERE m.location_id     = o.location_id
                    AND mom.opportunity_id = o.opportunity_id
                    AND m.message_direction = 'inbound'
                    AND m.deleted_at IS NULL
               )`;

// The sortable columns, by the name the client sends.
//
// A FIXED MAP, never interpolated from the query string: these expressions
// land in the SQL TEXT, where a parameter placeholder cannot be used, so an
// unmapped value would be an injection point. An unknown ?sort= falls back to
// 'recent' rather than erroring — the list still renders, just in the default
// order.
//
// Only timestamps and the numeric value are here. A text column (deal, owner,
// stage) would need the cursor to carry a collation-matched text key, which is
// a different change; the rest of the table stays unsorted rather than
// offering a control that quietly sorts one page.
const DEAL_SORTS = {
  recent: { tsExpr: 'COALESCE(o.updated_at_ghl, o.created_at_ghl)' },
  created: { tsExpr: 'o.created_at_ghl' },
  // The SAME expression the SELECT exposes as last_customer_contact_at — a
  // column alias is not visible to the keyset's WHERE clause, so sharing the
  // constant is what stops the sort ordering by a different value than the one
  // on screen.
  lastCustomerMessage: { tsExpr: LAST_CUSTOMER_TS },
  value: { numExpr: 'o.monetary_value' }
};

// List open deals for the caller's location. Used by the deal-switcher
// dropdown + the Deals tab. Ordered newest-touched first so the most
// active work is at the top.
//
// Filters (all optional, all query params):
//   ?status=open|won|lost|abandoned|all   (default: open)
//   ?limit=N                              (default 50, max 500)
//   ?q=<search string>                    (matches opportunity name)

dealsRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const status = (req.query.status || 'open').toString();
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  // Which column to sort by, and which way. Validated against SORTS below —
  // the value reaches the SQL text, not a placeholder.
  const sortParam = (req.query.sort || 'recent').toString();
  // Resolved HERE, not inside the transaction: the query picks its ORDER BY
  // and the cursor is built from the rows afterwards, and the two must agree
  // on one value. An unknown name falls back to the default order.
  const activeSort = Object.prototype.hasOwnProperty.call(DEAL_SORTS, sortParam)
    ? sortParam
    : 'recent';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const q = (req.query.q || '').toString().trim();
  // Scope to one contact's deals.
  //
  // Used by the note and task editors' deal pickers. A note belongs to a
  // contact, so offering every deal in the location invites filing it against
  // a deal that contact has nothing to do with — and the picker searches the
  // server, so the rep never sees that the list is unscoped.
  const contactId = (req.query.contactId || '').toString().trim();
  // Board and table filters.
  //
  // stageId scopes to one pipeline stage — the board loads a column at a time
  // rather than fetching every deal and grouping client-side, which would mean
  // holding the whole pipeline in memory to render one screen.
  const stageId = (req.query.stageId || '').toString().trim();
  const pipelineId = (req.query.pipelineId || '').toString().trim();
  const assignedTo = (req.query.assignedTo || '').toString().trim();
  const tag = (req.query.tag || '').toString().trim();

  try {
    const rows = await withTenant(locationId, async (client) => {
      // Match status set. 'all' skips the status filter.
      const statusClause = status === 'all' ? '' : 'AND o.status = $2';
      const params = [locationId];
      if (statusClause) params.push(status);
      // Capture the index at PUSH time. The clause below is built much later,
      // after stage / pipeline / owner / tag have each pushed, so reading
      // params.length there pointed at whichever filter pushed last — with
      // q + owner + tag set it referenced $6 while the value sat at $2, and
      // Postgres answered "could not determine data type of parameter $3".
      // Pre-existing: it held only while q was the last filter to push.
      let qParam = 0;
      if (q) { params.push(`%${q}%`); qParam = params.length; }

      // PRIMARY OR LINKED, matching the contact card's own deal chips.
      // A contact is on a deal either as its primary (o.contact_id) or
      // through opportunity_contacts — an architect sits on the deal without
      // being its primary, and their notes still belong to it. Filtering on
      // o.contact_id alone would hide those.
      // Simple equality filters. Each pushes its own parameter, so the count
      // slice below MUST include every one of them — a clause whose parameter
      // is sliced off throws "there is no parameter $n".
      // ONE id or SEVERAL, comma-separated.
      //
      // The board merges every pipeline into one set of columns, keyed by
      // stage NAME — "Quote Sent" exists in most pipelines, each with its own
      // stage_id — so a single column has to ask for all of them at once.
      // Previously it could only ask for one, which is why the board had to
      // render a separate full-height grid per pipeline.
      //
      // Capped: this is a board column, not a bulk export, and an unbounded
      // list in an IN-clause is a way to make one request expensive.
      let stageClause = '';
      if (stageId) {
        const ids = stageId.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
        if (ids.length === 1) {
          params.push(ids[0]);
          stageClause = `AND o.current_stage_id = $${params.length}`;
        } else if (ids.length > 1) {
          params.push(ids);
          stageClause = `AND o.current_stage_id = ANY($${params.length}::text[])`;
        }
      }
      let pipelineClause = '';
      if (pipelineId) {
        params.push(pipelineId);
        pipelineClause = `AND o.pipeline_id = $${params.length}`;
      }
      // 'unassigned' is its own branch and pushes no param — contacts and
      // tasks both treat it this way, and without it the filter would run
      // `assigned_to = 'unassigned'`, matching nothing and reading as "there
      // are no unowned deals" rather than "this filter does not work".
      let ownerClause = '';
      if (assignedTo === 'unassigned') {
        ownerClause = `AND o.assigned_to IS NULL`;
      } else if (assignedTo) {
        params.push(assignedTo);
        ownerClause = `AND o.assigned_to = $${params.length}`;
      }

      // One tag, matching the contacts route's shape so the two tabs behave
      // identically. Tags live in tag_history rather than on the row, so this
      // is an EXISTS.
      //
      // removed_at IS NULL means CURRENTLY tagged. tag_history keeps the
      // application even after a tag is taken off (019), which is what makes
      // "was this ever tagged X" answerable — but a filter labelled "Tag:
      // hot-lead" must mean "has it now", or removing a tag would not remove
      // the deal from the list.
      let tagClause = '';
      if (tag) {
        params.push(tag);
        tagClause = `AND EXISTS (
          SELECT 1 FROM tag_history th
           WHERE th.location_id = o.location_id
             AND th.entity_type = 'opportunity'
             AND th.entity_id   = o.opportunity_id
             AND th.tag_name    = $${params.length}
             AND th.removed_at IS NULL
        )`;
      }

      let contactClause = '';
      if (contactId) {
        params.push(contactId);
        const i = params.length;
        contactClause = `AND (
             o.contact_id = $${i}
             OR EXISTS (
               SELECT 1 FROM opportunity_contacts oc
                WHERE oc.location_id    = o.location_id
                  AND oc.opportunity_id = o.opportunity_id
                  AND oc.contact_id     = $${i}
                  AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
             )
           )`;
      }
      // Searches the DEAL NAME and its CONTACT.
      //
      // It was `o.name ILIKE` alone, so looking up a deal by the customer's
      // email or phone found nothing — and GHL names an opportunity after
      // its contact, so a rep types a person far more often than a deal
      // title. Joined against contacts for exactly that.
      const qClause = q
        ? `AND (
             o.name ILIKE $${qParam}
             OR c.first_name   ILIKE $${qParam}
             OR c.last_name    ILIKE $${qParam}
             OR c.email        ILIKE $${qParam}
             OR c.phone        ILIKE $${qParam}
             OR c.company_name ILIKE $${qParam}
           )`
        : '';

      // Sort key must match the cursor's — see utils/paginate.js.
      const ID = 'o.opportunity_id';
      const sortCol = DEAL_SORTS[activeSort];
      const TS = sortCol.tsExpr;
      // Everything pushed up to here is a FILTER parameter. keysetClause
      // pushes the CURSOR's params on the next line, and the count query must
      // not see those — it counts the whole filtered set, not one page of it.
      // So this is captured before the keyset, not after.
      const filterParamCount = params.length;

      const keyset = keysetClause({ ...sortCol, idExpr: ID, cursor, dir }, params);

      const sql = `
        SELECT o.opportunity_id, o.name AS opportunity_name, o.contact_id,
               o.pipeline_name, o.current_stage_name,
               -- IDs, not just names. Every GHL write endpoint takes an id and
               -- accepts no name, so the inline editor on the list could not
               -- save a pipeline or stage change without these.
               o.pipeline_id, o.current_stage_id,
               o.assigned_to, o.assigned_to_name,
               o.monetary_value, o.currency, o.status,
               o.created_at_ghl, o.updated_at_ghl,
               o.forecast_close_date, o.lead_source_opportunity,
               o.opportunity_source,
               o.product_system, o.product_type, o.tags,
               c.first_name, c.last_name, c.email, c.phone, c.company_name,
               -- The primary contact's BUSINESS record, for the board card's
               -- Business row. A deal reaches a business only through its
               -- contacts (no opportunities.business_id in GHL — see the
               -- detail route); the primary is the one a card has room for.
               cb.name AS business_name,
               -- Its id, so the card's View BUSINESS can open the record.
               cb.business_id AS business_id,
               -- The other two promoted custom fields the grid card shows.
               o.client_type, o.first_contact_method,
               -- The primary contact's tags. GHL's tags are contact-scoped,
               -- so this is what the grid card's "+ Tag" edits — the same
               -- split the Deal hub draws between contact and deal tags.
               (SELECT COALESCE(array_agg(DISTINCT ctg.tag_name ORDER BY ctg.tag_name), '{}')
                  FROM contact_tags ctg
                 WHERE ctg.location_id = o.location_id
                   AND ctg.contact_id  = o.contact_id
                   AND ctg.removed_at IS NULL)              AS contact_tags,
               u.name AS owner_name, u.email AS owner_email,
               -- Every contact linked to the deal, primary first, as JSON so
               -- the card can render the full "contacts on this deal" row
               -- without an N+1 fetch per card.
               (
                 SELECT json_agg(x ORDER BY x.is_primary DESC, x.first_name ASC)
                   FROM (
                     -- ONE ROW PER CONTACT — the same guard the detail route
                     -- carries, and for the same reason.
                     --
                     -- opportunity_contacts is keyed on (location_id,
                     -- relation_id), not (opportunity, contact), so one person
                     -- holds TWO rows: the synthetic
                     -- 'primary:<opp>:<contact>' written from the
                     -- opportunity's own contact_id (stageHistoryWriter), and
                     -- GHL's real relation id for the same pairing once the
                     -- associations sync sees it.
                     --
                     -- Without DISTINCT ON the person was listed twice, both
                     -- badged PRIMARY. The detail route was fixed; this one
                     -- was not, so the same deal read correctly in the panel
                     -- and doubled in the card.
                     SELECT DISTINCT ON (oc2.contact_id)
                            lc.contact_id, lc.first_name, lc.last_name,
                            lc.email, lc.phone,
                            lc.company_name, lc.contact_type, oc2.is_primary
                       FROM opportunity_contacts oc2
                       JOIN contacts lc
                         ON lc.location_id = oc2.location_id
                        AND lc.contact_id  = oc2.contact_id
                      WHERE oc2.location_id    = o.location_id
                        AND oc2.opportunity_id = o.opportunity_id
                        AND oc2.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
                      -- Prefer GHL's real relation over the synthetic one.
                      ORDER BY oc2.contact_id,
                               (oc2.relation_id LIKE 'primary:%') ASC,
                               oc2.is_primary DESC
                   ) x
               ) AS linked_contacts,
               -- Stage entry time for "N days in stage" on each card.
               (
                 SELECT sh.entered_at FROM stage_history sh
                  WHERE sh.location_id    = o.location_id
                    AND sh.opportunity_id = o.opportunity_id
                    AND sh.current_stage  = true
                  ORDER BY sh.entered_at DESC
                  LIMIT 1
               ) AS current_stage_entered_at,
               -- Newest inbound message attributed to this deal — "last
               -- contact" on the card. Same mapping filter as the timeline
               -- route so the date always matches a visible message.
               ${LAST_CUSTOMER_TS} AS last_customer_contact_at,
               -- Open tasks and live notes on this deal.
               --
               -- The DETAIL route has carried these for the nav pills; the
               -- list did not, so the edit panel — which renders from a list
               -- row — could not say whether a deal had any follow-up on it
               -- at all. Correlated subqueries rather than joins: a join
               -- would multiply the row and force a GROUP BY over every
               -- column already selected above.
               (SELECT COUNT(*)::int FROM tasks t
                 WHERE t.location_id    = o.location_id
                   AND t.opportunity_id = o.opportunity_id
                   AND t.status <> 'completed'
                   AND t.deleted_at IS NULL)                AS open_task_count,
               (SELECT COUNT(*)::int FROM notes n
                 WHERE n.location_id    = o.location_id
                   AND n.opportunity_id = o.opportunity_id
                   AND n.status = 'active')                 AS note_count
          FROM opportunities o
          LEFT JOIN contacts c
            ON c.location_id = o.location_id
           AND c.contact_id  = o.contact_id
          LEFT JOIN businesses cb
            ON cb.location_id = c.location_id
           AND cb.business_id = c.business_id
           AND cb.is_active   = true
          LEFT JOIN users u
            ON u.location_id = o.location_id
           AND u.user_id     = o.assigned_to
         WHERE o.location_id = $1
           AND o.is_deleted  = false
           AND o.deleted_at  IS NULL
           AND o.is_ghost    = false
           ${statusClause}
           ${qClause}
           ${contactClause}
           ${stageClause}
           ${pipelineClause}
           ${ownerClause}
           ${tagClause}
         ${keyset}
         ${orderBy({ ...sortCol, idExpr: ID, dir })}
         LIMIT ${limit + 1}`;
      const r = await client.query(sql, params);

      // The REAL total for this filter, not the page size.
      //
      // `totalCount` used to be page.rows.length, so a switcher showing the
      // first 4 of 40 open deals reported "4" — indistinguishable from a
      // sub-account that genuinely has four. Counted under the same WHERE as
      // the page (minus the keyset), so the two can never disagree.
      //
      // Its own query rather than a window function: COUNT(*) OVER () runs
      // per row of a page that already carries several correlated
      // subqueries, and this list is on the hot path for every deal view.
      const countSql = `
        SELECT count(*)::int                                          AS n,
               count(*) FILTER (WHERE o.status = 'open')::int         AS n_open,
               -- The filtered set's VALUE, not just its size. The board's
               -- column header and pipeline strip show a stage total; summing
               -- the loaded page undercounts any stage with more than one
               -- page of deals.
               COALESCE(sum(o.monetary_value), 0)::float              AS total_value
          FROM opportunities o
          LEFT JOIN contacts c
            ON c.location_id = o.location_id AND c.contact_id = o.contact_id
         WHERE o.location_id = $1
           AND o.is_deleted  = false
           AND o.deleted_at  IS NULL
           AND o.is_ghost    = false
           ${statusClause}
           ${qClause}
           ${contactClause}
           ${stageClause}
           ${pipelineClause}
           ${ownerClause}
           ${tagClause}`;
      // COUNT BY LENGTH, NOT BY RE-DERIVING THE LIST.
      //
      // This used to slice a hand-maintained count of which filters were
      // active, which held only while every filter's param was pushed before
      // the cursor's. It was already fragile — contactId is pushed LAST, after
      // stage, pipeline and owner — and adding the tag filter broke it: with
      // q + owner + tag set, the slice ended before tag's parameter and
      // Postgres answered "could not determine data type of parameter $3".
      //
      // `filterParamCount` is captured right here, after every filter clause
      // has pushed and before the cursor pushes anything, so it cannot drift
      // out of step with the list. A filter added later needs no arithmetic
      // updated — which is the failure this replaces.
      const countParams = params.slice(0, filterParamCount);
      const c2 = await client.query(countSql, countParams);

      // ?summary=stages — the same filtered set, GROUPED BY STAGE.
      //
      // For the Deals tab's pipeline-value strip, which sits above every view.
      // The board can sum its own columns, but the list and grid views hold
      // one page of deals at a time, so a total built from them would be the
      // page's. Same WHERE and same params as the count, so the strip, the
      // count and the list can never disagree.
      let stageTotals;
      if (req.query.summary === 'stages') {
        const s = await client.query(
          `SELECT o.current_stage_id                         AS stage_id,
                  count(*)::int                              AS n,
                  COALESCE(sum(o.monetary_value), 0)::float  AS total_value,
                  max(o.currency)                            AS currency
             FROM opportunities o
             LEFT JOIN contacts c
               ON c.location_id = o.location_id AND c.contact_id = o.contact_id
            WHERE o.location_id = $1
              AND o.is_deleted  = false
              AND o.deleted_at  IS NULL
              AND o.is_ghost    = false
              ${statusClause}
              ${qClause}
              ${contactClause}
              ${stageClause}
              ${pipelineClause}
              ${ownerClause}
              ${tagClause}
            GROUP BY o.current_stage_id`,
          countParams
        );
        stageTotals = s.rows.map((x) => ({
          stageId: x.stage_id,
          count: x.n,
          value: x.total_value,
          currency: x.currency || 'GBP'
        }));
      }

      // Both numbers from one pass. The switcher shows "Deals (12) · Open (4)",
      // and running a second query for the open half would let the two drift
      // if a webhook landed between them.
      //
      // n_open is the open count WITHIN the current filter — with
      // status='open' the two are equal, which is correct rather than
      // redundant: the header then reads "Open (4)" either way.
      return {
        rows: r.rows,
        total: c2.rows[0]?.n ?? null,
        openTotal: c2.rows[0]?.n_open ?? null,
        totalValue: c2.rows[0]?.total_value ?? null,
        stageTotals
      };
    });

    // The cursor MUST carry the column the query sorted by. Building it from
    // updated_at while the query ordered by value or last-customer-message
    // gives a predicate that filters on an unrelated column, which drops and
    // repeats rows at every page boundary instead of failing outright.
    const cursorOf = {
      recent: (d) => ({ ts: d.updated_at_ghl || d.created_at_ghl, id: d.opportunity_id }),
      created: (d) => ({ ts: d.created_at_ghl, id: d.opportunity_id }),
      lastCustomerMessage: (d) => ({ ts: d.last_customer_contact_at, id: d.opportunity_id }),
      // `num`, not `ts` — a numeric cursor is its own shape; see encodeCursor.
      value: (d) => ({
        num: d.monetary_value === null ? null : Number(d.monetary_value),
        id: d.opportunity_id
      })
    }[activeSort];

    const page = toPage(rows.rows, limit, cursorOf);
    res.json({
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      deals: page.rows.map((d) => ({
        id: d.opportunity_id,
        opportunityName: d.opportunity_name,
        dealTag: d.opportunity_name,
        stage: d.current_stage_name,
        pipeline: d.pipeline_name,
        owner: d.owner_name || d.assigned_to_name || d.owner_email || d.assigned_to || null,
        status: d.status,
        // The editable counterparts of the three names above. `owner` is a
        // display label built from a COALESCE chain and is not a user id — the
        // Owner picker needs assignedTo.
        pipelineId: d.pipeline_id,
        stageId: d.current_stage_id,
        assignedTo: d.assigned_to,
        source: d.opportunity_source,
        // Formatted for DISPLAY. Never feed this to an editable control: the
        // input adds its own £ prefix, so "£0" renders as "£ £0" — and the
        // formatted string is what would be sent back on save.
        value: d.monetary_value != null
          ? new Intl.NumberFormat('en-GB', {
              style: 'currency', currency: d.currency || 'GBP', maximumFractionDigits: 0
            }).format(d.monetary_value)
          : null,
        // The raw number, for anything editable.
        monetaryValue: d.monetary_value != null ? Number(d.monetary_value) : null,
        currency: d.currency || 'GBP',
        createdAt: d.created_at_ghl,
        updatedAt: d.updated_at_ghl,
        forecastCloseDate: d.forecast_close_date,
        leadSource: d.lead_source_opportunity,
        product: [flattenMulti(d.product_system), flattenMulti(d.product_type)]
          .filter(Boolean).join(' · ') || null,
        // The same two, apart — the board card gives each its own row.
        productSystem: flattenMulti(d.product_system) || null,
        productType: flattenMulti(d.product_type) || null,
        businessName: d.business_name || null,
        businessId: d.business_id || null,
        clientType: flattenMulti(d.client_type) || null,
        firstContactMethod: flattenMulti(d.first_contact_method) || null,
        contactTags: d.contact_tags || [],
        currentStageEnteredAt: d.current_stage_entered_at,
        lastCustomerContactAt: d.last_customer_contact_at,
        tags: d.tags || [],
        contact: d.contact_id ? {
          id: d.contact_id,
          firstName: d.first_name,
          lastName: d.last_name,
          email: d.email,
          phone: d.phone,
          business: d.company_name,
          accent: accentFor(d.contact_id)
        } : null,
        // Follow-up on this deal, for the edit panel's counts.
        openTaskCount: Number(d.open_task_count || 0),
        noteCount: Number(d.note_count || 0),
        // Full linked-contact list. Falls back to the primary contact when
        // no opportunity_contacts rows exist yet (same rule as the detail
        // route) so a card never shows zero people.
        people: (d.linked_contacts || (d.contact_id
          ? [{
              contact_id: d.contact_id,
              first_name: d.first_name,
              last_name: d.last_name,
              email: d.email,
              phone: d.phone,
              company_name: d.company_name,
              contact_type: null,
              is_primary: true
            }]
          : [])).map((p) => ({
            id: p.contact_id,
            firstName: p.first_name,
            lastName: p.last_name,
            // Needed by the pill: a contact created from an inbound SMS has no
            // name, and without these there is nothing left to identify it —
            // every pill rendered as a generic "Contact".
            email: p.email,
            phone: p.phone,
            business: p.company_name,
            contactType: p.contact_type,
            primary: !!p.is_primary || p.contact_id === d.contact_id,
            accent: accentFor(p.contact_id)
          }))
      })),
      // Everything matching the filter, not just this page. `deals.length`
      // is still the page; this is what a header should show.
      totalCount: rows.total,
      // How many of those are open. Lets a caller showing every status still
      // say how many need attention.
      openCount: rows.openTotal,
      // Sum of monetary_value over the same filtered set as totalCount.
      totalValue: rows.totalValue,
      // Only when asked for (?summary=stages); absent otherwise.
      ...(rows.stageTotals ? { stageTotals: rows.stageTotals } : null)
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/deals failed');
    next(err);
  }
});

// ── GET /api/deals/:id ──────────────────────────────────────────────────
// Header card + people list for one opportunity. RLS is the security
// GET /api/deals/custom-field-options — the picklist choices for the five
// opportunity custom fields the Deal card shows as chips.
//
// Those chips were read-only text because nothing ever sent their options. GHL
// defines them as picklists and customFieldsSync has been storing the choices
// in ghl_custom_field_definitions.options since migration 023 — they were just
// never exposed.
//
// Read from OUR table, not GHL: the definitions change rarely, the daily sync
// keeps them current, and a per-render API call would be a request every time a
// deal is opened.
//
// ── GET /api/deals/users ───────────────────────────────────────────────
//
// The location's CRM users, for the Owner and Followers dropdowns.
//
// Owner and Followers both take a GHL user id, and until now the dashboard had
// no way to list them — Owner was a read-only Input labelled "Reassigning an
// owner writes back to your CRM — coming next".
//
// Active users only, and deliberately so: `active` is GHL's soft-deletion flag
// (migration 014), so an inactive row is someone who has left. Assigning a deal
// to them would be a write GHL accepts and nobody acts on. A deal ALREADY owned
// by a departed user still displays — the deal response carries owner_name from
// its own join, so this list not containing them does not blank the field.
//
// MUST be registered before GET /:id — same single-segment shadowing trap as
// /pipelines and /lost-reasons.
// ── GET /api/deals/me ──────────────────────────────────────────────────
// The SIGNED-IN user's own name, for the Co-Pilot sidebar's avatar.
//
// Not /users. That list is the REP PICKER: active account users attached to
// this sub-account, which deliberately excludes agency staff — and the person
// signed in is often exactly that, an agency admin who owns the location
// without being a member of it. Resolving a name from a list built to exclude
// them could never work, which is why the avatar rendered as a lone dot.
//
// So this asks about ONE user, by id, with no type filter: whoever is holding
// the session, whatever kind of user they are.
//
// MUST be registered before GET /:id — same single-segment shadowing trap as
// /users and /pipelines.
dealsRouter.get('/me', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;
  if (!userId) return res.json({ user: null });

  try {
    const row = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT user_id, name, email, user_type
           FROM users
          WHERE location_id = $1 AND user_id = $2
          LIMIT 1`,
        [locationId, userId]
      );
      return rows[0] || null;
    });
    // null, not a 404: "we do not know your name" is a normal answer for a
    // user who has never been synced, and the sidebar falls back to an icon.
    res.json({
      user: row
        ? { id: row.user_id, name: row.name, email: row.email, userType: row.user_type }
        : null
    });
  } catch (err) {
    logger.error({ err, locationId, userId }, 'GET /api/deals/me failed');
    next(err);
  }
});

dealsRouter.get('/users', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const rows = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        // ACCOUNT USERS ONLY, and only active ones.
        //
        // roles.type = 'agency' means the user works for the agency that owns
        // this sub-account, not inside it — one such user is attached to four
        // locations at once. They appeared in every owner dropdown and in
        // "deals by rep", counted alongside people who actually sell.
        //
        // NULL NO LONGER PASSES, which is a deliberate reversal.
        //
        // It used to: a row whose payload carried no type was "unknown, not
        // known-agency", and hiding a real rep was judged worse than showing
        // one extra name. That was right while nothing could reliably fill
        // the column — 133's backfill only reached rows whose raw_user
        // already held roles.
        //
        // Both gaps are now closed. Every UserCreate/UserUpdate fetches
        // GET /users/{id} and stores roles.type (userWriter.js), and
        // `npm run sync:user-roles` repairs every existing row across every
        // install. So NULL has stopped meaning "we never asked" and started
        // meaning "GHL answered and said nothing" — which is not a sales rep
        // this sub-account can assign work to.
        //
        // A rep missing from the dropdown is now a REPAIRABLE state with a
        // named fix, rather than a silent one: run the sync.
        // AND ATTACHED TO *THIS* SUB-ACCOUNT.
        //
        // The row's own location_id is not proof of membership: every path
        // that writes a user stamps it with whichever location was being
        // synced, so a user who merely appeared in one location's list gets a
        // row there regardless of what GHL says they belong to.
        // roles.locationIds is GHL's own answer, and migration 139 promoted
        // it — one user in this account is attached to six sub-accounts at
        // once and would otherwise be a "rep" in all six.
        //
        // NULL passes HERE, unlike user_type above, and the asymmetry is
        // deliberate. user_type is a single scalar every payload carries;
        // locationIds is a list that an older raw_user may simply not hold,
        // and 139's backfill can only fill it where the payload did. Treating
        // a missing list as "belongs nowhere" would empty the dropdown on any
        // install whose rows predate the sync — a much louder failure than
        // one extra name. Once sync:user-roles has run, the list is present
        // and this clause does its job.
        `SELECT user_id, name, email, role, user_type
           FROM users
          WHERE location_id = $1
            AND active = true
            AND deleted_at IS NULL
            AND user_type = 'account'
            AND (location_ids IS NULL OR $1 = ANY(location_ids))
          ORDER BY name ASC NULLS LAST, email ASC`,
        [locationId]
      );
      return rows;
    });

    res.json({
      users: rows.map((u) => ({
        id: u.user_id,
        // Fall back to the email: a user row with no name still needs to be
        // pickable, and an empty label would render as a blank option.
        name: u.name || u.email || u.user_id,
        email: u.email,
        role: u.role
      }))
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/deals/users failed');
    next(err);
  }
});

// ── GET /api/deals/pipelines ───────────────────────────────────────────
//
// Every pipeline in the location with its stages nested, so the edit row can
// offer a Pipeline dropdown AND repopulate Stage when the pipeline changes.
//
// One request rather than /pipelines followed by a stages call per pipeline:
// the payload is small (a location has single-digit pipelines) and the row
// needs the target pipeline's stages the instant the rep picks it, with no
// spinner between two dependent dropdowns.
//
// Read from OUR tables — pipelines and pipeline_stages are kept current by
// pipelinesSync, and a per-render GHL call would be a request every time a row
// is expanded.
//
// MUST be registered before GET /:id. Express matches in declaration order and
// '/pipelines' is a single segment, so /:id would capture it and look up a deal
// whose id is the literal string "pipelines" — the trap that swallowed
// /lost-reasons and /custom-field-options.
dealsRouter.get('/pipelines', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const rows = await withTenant(locationId, async (client) => {
      // Active pipelines only: a retired pipeline is not somewhere a rep should
      // be able to move a live deal. Retired STAGES are kept (see below), which
      // is a different case — a deal may already be sitting on one.
      const pipelines = await client.query(
        `SELECT pipeline_id, name, position
           FROM pipelines
          WHERE location_id = $1
            AND is_active = true
          ORDER BY position ASC NULLS LAST, name ASC`,
        [locationId]
      );
      const stages = await client.query(
        `SELECT pipeline_id, stage_id, name, position, is_active
           FROM pipeline_stages
          WHERE location_id = $1
          ORDER BY position ASC NULLS LAST, name ASC`,
        [locationId]
      );
      return { pipelines: pipelines.rows, stages: stages.rows };
    });

    const byPipeline = new Map();
    for (const s of rows.stages) {
      if (!byPipeline.has(s.pipeline_id)) byPipeline.set(s.pipeline_id, []);
      byPipeline.get(s.pipeline_id).push({
        // GHL's update endpoint takes the stage id; a name is not accepted.
        id: s.stage_id,
        name: s.name,
        position: s.position,
        // Retired stages are RETURNED but flagged, because a deal may already
        // be parked on one and hiding it would make the Stage dropdown show
        // "no value" for a deal that plainly has one. The UI dims them and
        // does not offer them as new destinations.
        isActive: s.is_active
      });
    }

    res.json({
      pipelines: rows.pipelines.map((p) => ({
        id: p.pipeline_id,
        name: p.name,
        stages: byPipeline.get(p.pipeline_id) || []
      }))
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/deals/pipelines failed');
    next(err);
  }
});

// MUST be registered before GET /:id — Express matches in declaration order and
// a single-segment path would otherwise be read as a deal id. The same trap
// that swallowed /lost-reasons.
dealsRouter.get('/custom-field-options', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const rows = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        // EVERY active opportunity field, not only the picklists.
        //
        // This filtered on `options IS NOT NULL`, which was right when the
        // only consumer was the deal card's chips. The deal EDITOR needs the
        // text fields too — "Multi line Opportunity", "Last activity" — and
        // the folder each sits in, so it can render the same sections GHL
        // does. The picklist-only shape is still returned below, unchanged,
        // so the chips keep working.
        `SELECT d.field_id, d.field_key, d.display_name, d.field_type,
                d.options, d.placeholder, d.parent_id, d.position,
                f.name AS folder_name, f.position AS folder_position
           FROM ghl_custom_field_definitions d
           LEFT JOIN ghl_custom_field_folders f
             ON  f.location_id = d.location_id
             AND f.object_type = d.object_type
             AND f.folder_id   = d.parent_id
             AND f.is_active
          WHERE d.location_id = $1
            AND d.object_type = 'opportunity'
            AND d.is_active = true
          ORDER BY f.position NULLS LAST, f.name NULLS LAST,
                   d.position NULLS LAST, d.display_name`,
        [locationId]
      );
      return rows;
    });

    // Keyed by the SHORT name the deal response uses (clientType, not
    // opportunity.client_type), so the client can look them up without knowing
    // GHL's key format.
    const byField = {};
    for (const r of rows) {
      const short = String(r.field_key || '').replace(/^opportunity\./, '');
      const values = Array.isArray(r.options?.values) ? r.options.values : [];
      if (values.length === 0) continue;
      byField[short] = {
        // GHL's update endpoint takes customFields as [{ id, field_value }] —
        // the ID, not the key. Without this the UI has options to show but no
        // way to save a choice.
        id: r.field_id,
        label: r.display_name || short,
        // GHL sends either bare strings or { name, value } objects.
        options: values
          .map((v) => (typeof v === 'string' ? v : (v?.name || v?.value)))
          .filter(Boolean),
        // MULTIPLE_OPTIONS / CHECKBOX accept several; SINGLE_OPTIONS one.
        multiple: /CHECKBOX|MULTIPLE/i.test(r.field_type || '')
      };
    }

    // The same fields, grouped into GHL's folders — what the deal editor
    // renders as sections. Built from the same rows so the two views cannot
    // disagree about what a field is.
    const groups = new Map();
    for (const r of rows) {
      const key = r.folder_name ? r.parent_id : '__ungrouped__';
      if (!groups.has(key)) {
        groups.set(key, {
          id: r.folder_name ? r.parent_id : null,
          name: r.folder_name || 'Other fields',
          position: r.folder_position ?? 9999,
          fields: []
        });
      }
      const values = Array.isArray(r.options?.values) ? r.options.values : [];
      groups.get(key).fields.push({
        id: r.field_id,
        key: r.field_key,
        // The short name the deal response uses, so a caller can match a
        // field to the value already on the deal object.
        shortKey: String(r.field_key || '').replace(/^opportunity\./, ''),
        label: r.display_name || r.field_key || 'Untitled field',
        type: r.field_type || 'TEXT',
        placeholder: r.placeholder || null,
        options: values
          .map((v) => (typeof v === 'string' ? v : (v?.name || v?.value)))
          .filter(Boolean),
        // Uploadable — see the note in routes/contacts.js. The "no OAuth
        // documents API" claim was about EMAIL attachments, not these.
        readOnly: false,
        upload: /FILE_UPLOAD/i.test(r.field_type || ''),
        maxFiles: r.options?.maxFileLimit ?? null
      });
    }
    const fieldGroups = [...groups.values()]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    res.json({
      fields: byField,
      fieldGroups,
      totalCount: Object.keys(byField).length
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/deals/custom-field-options failed');
    next(err);
  }
});

// GET /api/deals/lost-reasons — for the picker shown when marking a deal lost.
//
// Read from GHL rather than our lost_reason_labels table: that table is
// populated opportunistically from webhooks, so a reason nobody has used yet
// would be missing from the very list whose job is to offer it.
//
// MUST be registered before GET /:id, which appears earlier in this file.
// Express matches in declaration order and '/lost-reasons' is a single segment,
// so /:id captures it and looks up a deal whose id is the literal string
// "lost-reasons". Verified: it returned {hit: 'get-by-id', id: 'lost-reasons'}
// until this was moved up.
dealsRouter.get('/lost-reasons', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }
    const reasons = await fetchGhlLostReasons(install);
    res.json({ reasons, totalCount: reasons.length });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/deals/lost-reasons failed');
    next(err);
  }
});

// boundary; a caller can only fetch deals inside their session's location.

dealsRouter.get('/:id', async (req, res, next) => {
  const opportunityId = req.params.id;
  const locationId = req.locationId;

  try {
    const result = await withTenant(locationId, async (client) => {
      const deal = await client.query(
        `SELECT o.opportunity_id, o.name AS opportunity_name, o.contact_id,
                o.pipeline_id, o.pipeline_name, o.assigned_to, o.assigned_to_name,
                o.monetary_value, o.currency, o.status, o.first_stage_name,
                o.current_stage_name, o.current_stage_id,
                o.forecast_close_date, o.all_initial_enquiry,
                -- Every promoted custom-field column, from ONE list — see
                -- PROMOTED_CUSTOM_FIELDS. Adding a column there adds it here,
                -- to the merged blob, and to the editor, with no other edit.
                ${PROMOTED_CUSTOM_FIELDS.map((c) => `o.${c}`).join(', ')},
                o.created_at_ghl, o.updated_at_ghl,
                o.won_at, o.lost_at, o.abandoned_at,
                o.tags, o.opportunity_source,
                -- The ten qualification values, pivoted into rows below.
                o.meddic_1, o.meddic_2, o.meddic_3, o.meddic_4, o.meddic_5,
                o.meddic_6, o.meddic_7, o.meddic_8, o.meddic_9, o.meddic_10,
                -- Outcome reason. Not a qualification heading — see the
                -- pivot's regex, which stops at 10 on purpose — so it is
                -- returned as its own field: won -> meddic_10,
                -- lost -> meddic_9, abandoned -> meddic_11.
                o.meddic_11,
                u.name AS owner_name, u.email AS owner_email,
                u.active AS owner_active
           FROM opportunities o
           LEFT JOIN users u
             ON u.location_id = o.location_id
            AND u.user_id     = o.assigned_to
          WHERE o.location_id = $1
            AND o.opportunity_id = $2
            AND o.is_deleted = false
            AND o.deleted_at IS NULL`,
        [locationId, opportunityId]
      );
      if (!deal.rowCount) return null;

      // Multi-contact people list via OPPORTUNITIES_CONTACTS_ASSOCIATION
      // (opportunity_contacts, populated by RelationCreate/Delete webhooks
      // + backfill). Falls back to opportunities.contact_id if we have no
      // relation rows yet — better to show one contact than none.
      const primary = deal.rows[0].contact_id;
      const linked = await client.query(
        `SELECT DISTINCT ON (oc.contact_id) c.contact_id, c.first_name, c.last_name, c.email, c.phone, c.company_name,
                c.contact_type,
                -- THE "CONTACT TYPE" CUSTOM FIELD ({{contact.contact_type}}),
                -- which is NOT contact_type above. That column is GHL's
                -- built-in contact.type ('lead' | 'customer') and renders as
                -- the LEAD badge; this is a free-text custom field a rep
                -- fills in ("Homeowner", "Partner") and renders as a row.
                -- Same words, two different facts — hence the suffix.
                --
                -- Both spellings of the key: contactWriter stores whatever
                -- field_key the definitions sync recorded, and GHL reports
                -- contact fields as 'contact.<key>' while the older promoted
                -- fields were read unprefixed (migration 060).
                COALESCE(c.custom_fields->>'contact_type',
                         c.custom_fields->>'contact.contact_type') AS contact_type_field,
                -- Address + timezone for the Deal card's customer column.
                c.address1, c.city, c.state, c.postal_code, c.country, c.timezone,
                c.dnd, c.dnd_email, c.dnd_sms, c.dnd_call, c.dnd_whatsapp,
                oc.is_primary,
                -- The LINK's id, not the contact's. DELETE
                -- /deals/:id/contacts/:relationId needs it, and it was never
                -- sent — so the UI could add someone to a deal but never
                -- remove them, and the Remove button sat inert.
                oc.relation_id
           FROM opportunity_contacts oc
           JOIN contacts c
             ON c.location_id = oc.location_id
            AND c.contact_id  = oc.contact_id
          WHERE oc.location_id     = $1
            AND oc.opportunity_id  = $2
            AND oc.association_id  = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
          -- ONE ROW PER CONTACT.
          --
          -- The table's key is (location_id, relation_id), not
          -- (opportunity, contact) — so one person can hold TWO rows: the
          -- synthetic 'primary:<opp>:<contact>' we write from the
          -- opportunity's own contact_id, and GHL's real relation id for the
          -- same pairing once the associations sync sees it. The deal card
          -- then listed that contact twice, both badged PRIMARY.
          --
          -- DISTINCT ON keeps GHL's real relation where both exist: the
          -- ordering puts a non-synthetic relation_id first, and the delete
          -- endpoint needs the id GHL will actually accept.
          ORDER BY oc.contact_id,
                   (oc.relation_id LIKE 'primary:%') ASC,
                   oc.is_primary DESC`,
        [locationId, opportunityId]
      );
      // DISTINCT ON dictates its own ORDER BY (contact_id first), so rows come
      // back in contact-id order rather than primary-first. Re-sorted here for
      // display: nothing downstream depends on position (primaryPerson finds
      // by flag), but a card listing the primary second reads as if it were
      // not the primary.
      let contacts = [...linked.rows].sort(
        (a, b) => (b.is_primary === true) - (a.is_primary === true)
          || String(a.first_name || '').localeCompare(String(b.first_name || ''))
      );
      if (!contacts.length && primary) {
        const fallback = await client.query(
          `SELECT contact_id, first_name, last_name, email, phone, company_name,
                  contact_type,
                  COALESCE(custom_fields->>'contact_type',
                           custom_fields->>'contact.contact_type') AS contact_type_field,
                  dnd, dnd_email, dnd_sms, dnd_call, dnd_whatsapp,
                  true AS is_primary
             FROM contacts
            WHERE location_id = $1 AND contact_id = $2`,
          [locationId, primary]
        );
        contacts = fallback.rows;
      }

      // Qualification: the ten meddic_N values on this opportunity, paired
      // with their GHL field name and placeholder description.
      //
      // Driven from the definitions table, so a renamed or added field needs
      // no code change here — and "missing" means "GHL defines this heading
      // but the opportunity has no value for it", which is the only reading
      // that makes the count meaningful.
      const qualification = await client.query(
        `WITH vals AS (
           SELECT * FROM (
             VALUES (1, $2::text), (2, $3), (3, $4), (4, $5), (5, $6),
                    (6, $7), (7, $8), (8, $9), (9, $10), (10, $11)
           ) AS t(idx, value)
         )
         SELECT d.field_key,
                -- GHL's own field id. The qualification panel is editable
                -- now, and the opportunity patch prefers an id over a key
                -- (see opportunityPatch.js) — without this the UI has no
                -- way to name the field it is writing.
                d.field_id,
                d.display_name,
                d.placeholder,
                v.idx,
                v.value
           FROM ghl_custom_field_definitions d
           JOIN vals v
             ON v.idx = (regexp_replace(d.field_key, '^.*_', ''))::int
          WHERE d.location_id = $1
            AND d.object_type = 'opportunity'
            AND d.is_active   = true
            AND d.field_key ~ '^opportunity[.]meddic_(10|[1-9])$'
          ORDER BY v.idx ASC`,
        [locationId, ...Array.from({ length: 10 }, (_, i) => deal.rows[0][`meddic_${i + 1}`])]
      );

      // Contact-level tags projected onto the deal. GHL's tag model is
      // contact-scoped (confirmed against vw_opportunity_effective_tags —
      // see migration 048), so these are the tags GHL's own opportunity
      // modal shows. Kept separate from opportunities.tags so the UI can
      // distinguish "tagged on this deal" from "tagged on the person".
      //
      // Scoped to every contact linked to the deal, not just the primary:
      // a follower's tags are equally part of the deal's picture, and on
      // single-contact deals (the common case) this is identical to the
      // primary-only query. Same active filter as the view (removed_at
      // IS NULL) so the two never disagree.
      const tagContactIds = [
        ...new Set(contacts.map((c) => c.contact_id).filter(Boolean))
      ];
      const tagRows = tagContactIds.length
        ? await client.query(
            `SELECT DISTINCT ct.tag_name
               FROM contact_tags ct
              WHERE ct.location_id = $1
                AND ct.contact_id  = ANY($2::text[])
                AND ct.removed_at IS NULL
              ORDER BY ct.tag_name ASC`,
            [locationId, tagContactIds]
          )
        : { rows: [] };

      // Two staleness signals for the Deal section:
      //   • when the deal entered the stage it's on now — drives "days in
      //     stage" (same open-row rule as vw_opportunity_flat: exactly one
      //     stage_history row per opp carries current_stage = true)
      //   • when the customer last made contact — the newest INBOUND
      //     message attributed to this deal. Uses the same
      //     message_opportunity_map filter as the timeline route, so the
      //     date always matches a message the user can actually see.
      const activity = await client.query(
        `SELECT
           (SELECT entered_at FROM stage_history
             WHERE location_id = $1 AND opportunity_id = $2
               AND current_stage = true
             ORDER BY entered_at DESC
             LIMIT 1)                                        AS current_stage_entered_at,
           (SELECT MAX(m.message_timestamp) FROM messages m
              JOIN message_opportunity_map mom
                ON mom.location_id = m.location_id
               AND mom.message_id  = m.message_id
               AND mom.superseded_at IS NULL
               AND mom.mapping_status IN ('mapped', 'manually_resolved')
             WHERE m.location_id = $1
               AND mom.opportunity_id = $2
               AND m.message_direction = 'inbound'
               AND m.deleted_at IS NULL)                     AS last_customer_contact_at`,
        [locationId, opportunityId]
      );

      // Per-opp counts for the top-nav pill counters.
      const counts = await client.query(
        `SELECT
           -- DISTINCT, not COUNT(*): one person can hold two rows here — the
           -- synthetic 'primary:<opp>:<contact>' and GHL's real relation id
           -- for the same pairing — so a plain count reported a deal with
           -- three people as having four.
           (SELECT COUNT(DISTINCT contact_id)::int FROM opportunity_contacts
             WHERE location_id = $1 AND opportunity_id = $2
               AND association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION')  AS contacts,
           (SELECT COUNT(*)::int FROM opportunities
             WHERE location_id = $1 AND contact_id = $3
               AND status = 'open'
               AND is_deleted = false AND deleted_at IS NULL
               AND is_ghost   = false)                                     AS deals,
           (SELECT COUNT(*)::int FROM tasks
             WHERE location_id = $1 AND opportunity_id = $2
               AND (deleted_at IS NULL))                                   AS tasks,
           (SELECT COUNT(*)::int FROM tasks
             WHERE location_id = $1 AND opportunity_id = $2
               AND status = 'open'
               AND (deleted_at IS NULL))                                   AS tasks_open,
           (SELECT COUNT(*)::int FROM notes
             WHERE location_id = $1 AND opportunity_id = $2
               AND (deleted_at IS NULL))                                   AS notes`,
        [locationId, opportunityId, primary]
      );

      // Businesses this deal reaches, through its contacts.
      //
      // There is no opportunities.business_id in GHL — a deal links to a
      // business only via the contacts on it (contacts.business_id, migration
      // 056). DISTINCT because two contacts at the same company would
      // otherwise list it twice.
      const businesses = await client.query(
        `SELECT DISTINCT b.business_id, b.name, b.city
           FROM contacts c
           JOIN businesses b
             ON b.location_id = c.location_id
            AND b.business_id = c.business_id
          WHERE c.location_id = $1
            AND c.business_id IS NOT NULL
            AND b.is_active = true
            AND c.contact_id IN (
              SELECT oc.contact_id FROM opportunity_contacts oc
               WHERE oc.location_id    = $1
                 AND oc.opportunity_id = $2
                 AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
              UNION
              -- The deal's own primary contact, which may predate any
              -- relation row.
              SELECT $3::text
            )
          ORDER BY b.name`,
        [locationId, opportunityId, primary]
      );

      return {
        deal: deal.rows[0],
        contacts,
        businesses: businesses.rows,
        counts: counts.rows[0],
        activity: activity.rows[0],
        contactTags: tagRows.rows.map((r) => r.tag_name),
        qualification: qualification.rows
      };
    });

    if (!result) return res.status(404).json({ error: 'Deal not found' });

    const d = result.deal;
    const people = result.contacts.map((c) => ({
      id: c.contact_id,
      firstName: c.first_name,
      lastName: c.last_name,
      email: c.email,
      phone: c.phone,
      business: c.company_name,
      contactType: c.contact_type,
      contactTypeField: c.contact_type_field || null,
      // One display line — "14 Priory Lane, Harpenden AL5 2FE". Joined here
      // rather than in the UI so every surface renders an address the same way.
      address: [
        c.address1,
        [c.city, c.postal_code].filter(Boolean).join(' '),
        c.country && c.country !== 'United Kingdom' ? c.country : null
      ].filter(Boolean).join(', ') || null,
      // The SAME address, unflattened. The joined line above is still what
      // compact surfaces render; the Deal hub labels each part separately, and
      // a pre-joined string cannot be taken apart again — "Harpenden AL5 2FE"
      // gives no way to tell the town from the postcode.
      //
      // Null rather than '' for an empty one, so the UI can tell "not recorded"
      // from a field that exists and is blank.
      address1: c.address1 || null,
      city: c.city || null,
      state: c.state || null,
      postalCode: c.postal_code || null,
      country: c.country || null,
      timezone: c.timezone || null,
      accent: accentFor(c.contact_id),
      primary: !!c.is_primary || c.contact_id === d.contact_id,
      // The LINK id, needed to unlink this contact from this deal:
      // DELETE /api/deals/:id/contacts/:relationId. Null for the synthesised
      // primary row (a deal whose contact has no opportunity_contacts entry
      // yet), which is correct — that link is not ours to delete.
      relationId: c.relation_id || null,
      // Contact permissions — the draft gate (spec rule 7) and the People
      // cards read the same source so they can't disagree.
      dnd: {
        all: c.dnd === true,
        channels: {
          email: c.dnd_email === true,
          sms: c.dnd_sms === true,
          call: c.dnd_call === true,
          whatsapp: c.dnd_whatsapp === true
        },
        blockedChannels: ['email', 'sms', 'call', 'whatsapp'].filter(
          (k) => c.dnd === true || c[`dnd_${k}`] === true
        )
      }
    }));

    res.json({
      id: d.opportunity_id,
      opportunityName: d.opportunity_name,
      dealTag: d.opportunity_name, // no dedicated "tag" field yet — use the name
      // Display-formatted; see the note on the list route. `monetaryValue`
      // below is what an editable control should bind to.
      value: d.monetary_value != null
        ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: d.currency || 'GBP', maximumFractionDigits: 0 }).format(d.monetary_value)
        : null,
      monetaryValue: d.monetary_value != null ? Number(d.monetary_value) : null,
      currency: d.currency || 'GBP',
      stage: d.current_stage_name,
      firstStage: d.first_stage_name,
      pipelineId: d.pipeline_id,
      pipelineName: d.pipeline_name,
      // `pipeline` and `stageId` duplicate pipelineName / current_stage_id
      // under the names the LIST route uses.
      //
      // Not redundancy for its own sake: the Deals tab patches a list row with
      // this response after an edit (usePagedList.patchItem), so any field the
      // list names differently would leave that row half-updated — the card
      // reads deal.pipeline and would render blank after a save.
      pipeline: d.pipeline_name,
      stageId: d.current_stage_id,
      // Owner resolution, best source first. `users` is kept live by the
      // UserCreate/Update/Delete webhooks, so it survives renames that the
      // denormalised opportunities.assigned_to_name snapshot never sees.
      // assigned_to_name is the fallback for deals whose owner has since
      // been hard-deleted from the account; the raw id is the last resort
      // so an assigned deal never renders as unassigned.
      owner: d.owner_name || d.assigned_to_name || d.owner_email || d.assigned_to || null,
      ownerId: d.assigned_to,
      // Same reason as `pipeline` above — the list calls this assignedTo, and
      // the edit panel's Owner picker binds to that name.
      assignedTo: d.assigned_to,
      // Left the account — the UI dims/annotates rather than hiding, since
      // the deal is still genuinely theirs until someone reassigns it.
      ownerActive: d.assigned_to ? d.owner_active !== false : null,
      status: d.status,
      forecastCloseDate: d.forecast_close_date,
      leadSource: d.lead_source_opportunity,
      // What the customer first asked for. `initialEnquiry` is the CURRENT
      // enquiry — the GHL automation overwrites it each time a new one comes
      // in — and `earlierEnquiries` is every previous value, oldest first,
      // kept by stageHistoryWriter so the earlier wording is not lost. See
      // migration 136 for why the history is ours alone and never written
      // back to GHL.
      initialEnquiry: d.master_initial_enquiry || null,
      earlierEnquiries: Array.isArray(d.all_initial_enquiry) ? d.all_initial_enquiry : [],
      product: [flattenMulti(d.product_system), flattenMulti(d.product_type)]
        .filter(Boolean).join(' · ') || null,
      // The five opportunity custom fields, sent individually as well as in the
      // combined `product` string — the Deal chip row shows each on its own,
      // and an unset one has to be distinguishable from an empty join.
      // All are JSONB arrays since migration 027 (GHL multi-select), so they go
      // through flattenMulti rather than being read as strings.
      clientType: flattenMulti(d.client_type),
      productSystem: flattenMulti(d.product_system),
      productType: flattenMulti(d.product_type),
      firstContactMethod: flattenMulti(d.first_contact_method),
      // EVERY custom field value, keyed by field id and by key.
      //
      // The four above are promoted COLUMNS — the ones the deal card shows as
      // chips. The editor needs the rest ("Multi line Opportunity", "Last
      // activity", "test opp"), and promoting a column for each would mean a
      // migration every time the client adds a field. The raw blob is already
      // stored; this simply stops hiding it.
      // The blob the custom-field editor renders from, with the promoted
      // columns merged in where it has no value of its own — see
      // withPromotedFields. Without that merge the grid showed "Not set" over
      // data this same response was already returning as a top-level key.
      customFields: withPromotedFields(d.custom_fields, d),
      createdAt: d.created_at_ghl,
      updatedAt: d.updated_at_ghl,
      currentStageEnteredAt: result.activity?.current_stage_entered_at || null,
      lastCustomerContactAt: result.activity?.last_customer_contact_at || null,
      // How the opportunity entered GHL — "public api", "manual", a form,
      // a workflow. Stored since migration 013 but never surfaced.
      source: d.opportunity_source || null,
      // Why the deal closed, and which GHL field holds it.
      //
      // One reason per deal, in the field that matches the outcome:
      //   won       -> meddic_10  "10. Deal Won Reason"
      //   lost      -> meddic_9   "9. Deal Lost reason"
      //   abandoned -> meddic_11  "11. Abandoned Reason"
      //
      // Resolved here rather than in the UI so there is ONE definition of the
      // mapping. `outcomeReasonField` is returned so a write can target the
      // same column without re-deriving it. An open deal has no reason.
      outcomeReason: outcomeReasonFor(d),
      outcomeReasonField: OUTCOME_REASON_FIELD[d.status] || null,
      // GHL's own lost-reason id, when the deal was marked lost through the
      // native picker. meddic_9 is the free text; this is the picklist id.
      lostReasonId: d.raw_opportunity?.lostReasonId || null,
      // Qualification headings with this deal's values. `missing` is what the
      // section tab badge counts — a heading the AI has no evidence filed
      // under yet.
      qualification: (result.qualification || []).map((q) => ({
        fieldKey: q.field_key,
        fieldId: q.field_id,
        index: q.idx,
        name: q.display_name,
        description: q.placeholder,
        value: q.value && String(q.value).trim() ? q.value : null,
        filled: !!(q.value && String(q.value).trim())
      })),
      // Tags on the opportunity record itself, when GHL sends them.
      // Businesses reached through this deal's contacts. Empty when none of
      // them carry a business_id — the Businesses sync is what populates it.
      businesses: (result.businesses || []).map((b) => ({
        id: b.business_id,
        name: b.name || 'Unnamed business',
        city: b.city || null
      })),
      dealTags: d.tags || [],
      // Tags on the primary contact — the ones GHL's own opportunity modal
      // surfaces, since its tag model is contact-scoped.
      contactTags: result.contactTags || [],
      wonAt: d.won_at, lostAt: d.lost_at, abandonedAt: d.abandoned_at,
      // Location name is resolved once during the auth handshake and lives
      // on the frontend via useAuth().location.name — no need to duplicate
      // that lookup on every deal payload.
      location: null,
      people,
      primaryContactId: d.contact_id,
      counts: result.counts || { contacts: people.length, deals: 0, tasks: 0, notes: 0 }
    });
  } catch (err) {
    logger.error({ err, opportunityId, locationId }, 'GET /api/deals/:id failed');
    next(err);
  }
});

// ── GET /api/deals/:id/timeline ────────────────────────────────────────
// All messages for the deal, ordered newest first. Filters happen client-
// side (chip toggles = instant JS, no roundtrip); this endpoint just
// returns the merged thread.
//
// Attribution: we return messages the mapping engine confidently assigned to
// this deal ('mapped'), PLUS any a sales manager moved here by hand
// ('manually_resolved'). Filtering on 'mapped' alone hid every manual
// correction — the manager moved a message and it vanished from both deals.
//
// Ambiguous / unassigned / excluded messages don't appear on a deal timeline
// — they live on the contact record until someone files them.

dealsRouter.get('/:id/timeline', async (req, res, next) => {
  const opportunityId = req.params.id;
  const locationId = req.locationId;

  // PAGING, optional — the Deal Hub's infinite scroll. `?limit=50` returns
  // the newest 50 rows; `&before=<ts>` the 50 before that. Without `limit`
  // the whole timeline comes back as it always has, so other callers are
  // unchanged. Each of the three queries is cut in SQL (limit + 1, to know
  // whether there is more), then the merge is cut to the page.
  //
  // A row with no timestamp sorts as the epoch — last, as the unpaged merge
  // already puts it — so the cursor never has to represent "null".
  const pageSize = req.query.limit
    ? Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 1), 200)
    : null;
  const beforeRaw = req.query.before ? new Date(String(req.query.before)) : null;
  if (beforeRaw && Number.isNaN(beforeRaw.getTime())) {
    return res.status(400).json({ error: 'before must be a timestamp', field: 'before' });
  }
  const before = beforeRaw ? beforeRaw.toISOString() : null;
  const sourceLimit = pageSize ? pageSize + 1 : null;

  try {
    const result = await withTenant(locationId, async (client) => {
      // Two queries so RLS + the message_opportunity_map join stays cheap.
      // First: verify the opp exists and grab the contact_id + provider set.
      const opp = await client.query(
        `SELECT contact_id, name AS opportunity_name FROM opportunities
          WHERE location_id = $1 AND opportunity_id = $2
            AND is_deleted = false AND deleted_at IS NULL`,
        [locationId, opportunityId]
      );
      if (!opp.rowCount) return null;
      const contactId = opp.rows[0].contact_id;
      const opportunityName = opp.rows[0].opportunity_name;

      // Ambiguity flag: is this contact on 2+ open opps? (D5-family: same
      // check we use for the excluded-duplicates list.)
      const ambiguity = await client.query(
        `SELECT COUNT(*) AS n FROM opportunities
          WHERE location_id = $1 AND contact_id = $2
            AND status = 'open'
            AND is_deleted = false AND deleted_at IS NULL
            AND is_ghost = false`,
        [locationId, contactId]
      );
      const contactHasMultipleOpps = Number(ambiguity.rows[0].n) > 1;

      // Main timeline pull. Left-join call_transcriptions to know readable
      // state per call; conversation_providers to resolve the sender name.
      const messages = await client.query(
        `SELECT m.id, m.message_id, m.message_direction, m.message_channel,
                m.message_body, m.message_timestamp, m.raw_message,
                -- Email subject. Stored since migration 031 and never
                -- selected, so the timeline showed an email as a wall of body
                -- text with no indication of what it was about — the one field
                -- a reader scans for.
                m.subject, m.thread_id,
                -- How this message came to be on this deal. The pill in the
                -- timeline shows 'moved here' for a manual link so a rep can
                -- tell a human decision from the engine's.
                mom.mapping_status AS mapping_status,
                mom.reviewed_by    AS mapped_by,
                -- The reviewer's NAME, not their id. reviewed_by holds a GHL
                -- user id (or the literal 'system'), and "moved by
                -- h07KvFvGuKUVRExims8y" tells a manager nothing.
                mu.name            AS mapped_by_name,
                m.sender_type, m.sender_user_id, m.sender_name,
                -- WHO ON OUR SIDE SENT IT.
                --
                -- sender_name is filled by resolveSenderName on write, but
                -- that is fire-and-forget: it races the insert, and any
                -- failure leaves the column NULL forever. Every outbound row
                -- then rendered as the literal "Us", which tells a rep
                -- nothing on a deal three colleagues have touched.
                --
                -- Joining at READ time means the name appears as soon as the
                -- user syncs, with no backfill.
                su.name  AS sender_user_name,
                su.email AS sender_user_email,
                m.is_call, m.call_duration_seconds, m.recording_url,
                m.from_backfill, m.conversation_provider_id,
                m.contact_id AS msg_contact_id,
                c.first_name, c.last_name, c.phone, c.email, c.company_name,
                cp.name  AS provider_name,
                cp.type  AS provider_type,
                cp.is_native AS provider_is_native,
                -- The provider's own logo, as GHL's provider payload carries
                -- it (icon, an SVG URL). A custom sender is a product with
                -- a face — WhatsApp QR, iMessage — and the row should show it
                -- rather than the generic SMS glyph its API type implies.
                cp.raw_provider->>'icon' AS provider_icon,
                ct.fetch_status AS transcript_status,
                ct.transcript_text,
                (x.subject_id IS NOT NULL) AS ai_excluded
           FROM messages m
           JOIN message_opportunity_map mom
             ON mom.location_id = m.location_id
            AND mom.message_id  = m.message_id
            AND mom.superseded_at IS NULL
            AND mom.mapping_status IN ('mapped', 'manually_resolved')
           LEFT JOIN contacts c
             ON c.location_id = m.location_id
            AND c.contact_id  = m.contact_id
           LEFT JOIN conversation_providers cp
             ON cp.location_id = m.location_id
            AND cp.provider_id = m.conversation_provider_id
           LEFT JOIN users su
             ON su.location_id = m.location_id
            AND su.user_id     = m.sender_user_id
           LEFT JOIN users mu
             ON mu.location_id = m.location_id
            AND mu.user_id     = mom.reviewed_by
           LEFT JOIN call_transcriptions ct
             ON ct.location_id = m.location_id
            AND ct.message_id  = m.message_id
           LEFT JOIN ai_exclusions x
             ON x.location_id    = m.location_id
            AND x.subject_type   = 'message'
            AND x.subject_id     = m.message_id
            AND x.opportunity_id = mom.opportunity_id
          WHERE m.location_id = $1
            AND mom.opportunity_id = $2
            AND m.deleted_at IS NULL
            AND ($3::timestamptz IS NULL
                 OR COALESCE(m.message_timestamp, 'epoch'::timestamptz) < $3::timestamptz)
          ORDER BY m.message_timestamp DESC
          LIMIT $4`,
        [locationId, opportunityId, before, sourceLimit]
      );

      // Tasks and notes belong in the timeline, not only in the side rail —
      // "send the revised quote" is part of the conversation's history, and
      // reading the thread without it leaves out what was actually agreed.
      const tasks = await client.query(
        `SELECT t.task_id, t.title, t.body, t.due_at, t.status,
                t.assigned_to_name, t.created_at_ghl, t.from_backfill,
                -- Whether the agent reads this task (migration 057).
                (x.subject_id IS NOT NULL) AS ai_excluded,
                -- WHO THE TASK IS FILED AGAINST — a task is stored against a
                -- contact in GHL, and the rail showed only the assignee, so
                -- "call back" gave no indication of who to call.
                t.contact_id,
                tc.first_name, tc.last_name, tc.email, tc.phone, tc.company_name
           FROM tasks t
           LEFT JOIN contacts tc
             ON tc.location_id = t.location_id
            AND tc.contact_id  = t.contact_id
           LEFT JOIN ai_exclusions x
             ON x.location_id    = t.location_id
            AND x.opportunity_id = t.opportunity_id
            AND x.subject_type   = 'task'
            AND x.subject_id     = t.task_id
          WHERE t.location_id = $1
            AND t.opportunity_id = $2
            AND t.deleted_at IS NULL
            AND ($3::timestamptz IS NULL
                 OR COALESCE(t.created_at_ghl, 'epoch'::timestamptz) < $3::timestamptz)
          ORDER BY t.created_at_ghl DESC NULLS LAST
          LIMIT $4`,
        [locationId, opportunityId, before, sourceLimit]
      );

      const notes = await client.query(
        `SELECT n.note_id, n.body, n.title, n.color, n.pinned,
                n.author_name, n.created_at_ghl, n.from_backfill,
                -- Same count as GET /api/notes — see the comment there for
                -- why the attachments field is either an array or absent.
                -- Both routes list notes, so both report the count or the
                -- timeline would silently differ from the notes tab.
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
                (x.subject_id IS NOT NULL) AS ai_excluded,
                -- WHO THE NOTE IS FILED AGAINST. A note is stored against a
                -- CONTACT in GHL, and the deal-hub rail showed only its
                -- author — so on a deal with several people there was no way
                -- to tell which of them a note concerned.
                n.contact_id,
                nc.first_name, nc.last_name, nc.email, nc.phone, nc.company_name
           FROM notes n
           LEFT JOIN contacts nc
             ON nc.location_id = n.location_id
            AND nc.contact_id  = n.contact_id
           LEFT JOIN ai_exclusions x
             ON x.location_id    = n.location_id
            AND x.opportunity_id = n.opportunity_id
            AND x.subject_type   = 'note'
            AND x.subject_id     = n.note_id
          WHERE n.location_id = $1
            AND n.opportunity_id = $2
            AND n.status = 'active'
            AND ($3::timestamptz IS NULL
                 OR COALESCE(n.created_at_ghl, 'epoch'::timestamptz) < $3::timestamptz)
          ORDER BY n.created_at_ghl DESC NULLS LAST
          LIMIT $4`,
        [locationId, opportunityId, before, sourceLimit]
      );

      return {
        messages: messages.rows, tasks: tasks.rows, notes: notes.rows,
        contactId, contactHasMultipleOpps, opportunityName
      };
    });

    if (!result) return res.status(404).json({ error: 'Deal not found' });

    const rows = result.messages.map((m) => {
      // channelOfRow, not normaliseChannel(m.message_channel): the stored
      // column is whatever the writer knew when the row landed, and a GHL
      // internal comment landed as a raw or empty type — so it drew as a
      // grey "Event" line. The payload's own type is consulted first.
      const channel = channelOfRow(m);
      const isCall = m.is_call || channel === 'CALL' || channel === 'VOICEMAIL';
      const hasTranscript = m.transcript_status === 'ok' && !!m.transcript_text;

      // Direction is stored as 'inbound' / 'outbound' by messageWriter and
      // messageEnrichment. Compare against those exactly — an 'in' / 'out'
      // test silently never matches, which nulls out senderId and toIds and
      // breaks the people filter.
      const isInbound = m.message_direction === 'inbound';
      const isOutbound = m.message_direction === 'outbound';

      // For inbound we resolve the sender via contacts. For outbound the
      // stored sender_name (rep) is authoritative; fall back to something
      // sensible if it's missing.
      // Who sent it. A contact created from an inbound SMS has no name, and
      // the literal string "Contact" told a rep nothing — every inbound row on
      // the deal read identically. Fall back through the identifiers we hold.
      const senderName = isInbound
        ? (
            [m.first_name, m.last_name].filter(Boolean).join(' ')
            || m.company_name
            || m.email
            || m.phone
            || 'Unknown contact'
          )
        // The stored name first (it is what the webhook resolved), then the
        // live join, then the user's email. Below that there is no rep
        // identity left to fall back to for a genuinely unattributed send —
        // GHL's own webhook/API payload simply omits userId on some outbound
        // events (confirmed: not a gap in our ingestion, nothing else in the
        // payload can recover it, no backfill possible). "Us" was a
        // dishonest generic label there. labelForSenderType distinguishes
        // WHY there's no rep name — a workflow/campaign/bulk/AI send has no
        // human sender at all; a connected integration (m.provider_name,
        // via conversation_providers) at least names the tool; only a true
        // 'unknown' falls to the generic "Team member".
        : (
            m.sender_name || m.sender_user_name || m.sender_user_email ||
            labelForSenderType(m.sender_type, m.provider_name)
          );
      const senderId = isInbound ? m.msg_contact_id : null;

      return {
        id: m.id,                          // primary key — used for jump anchors
        messageId: m.message_id,           // GHL id, for reference
        // Whether a human put this message on this deal. Drives the pill's
        // wording — an automatic link reads differently from one a manager
        // chose, and conflating them hides that a decision was made.
        mappingStatus: m.mapping_status || null,
        mappedManually: m.mapping_status === 'manually_resolved',
        // WHO filed it there. Selected in the query but never returned, so
        // the UI could say a message was moved by hand but not by whom —
        // which is the part a manager actually wants when a message looks
        // wrongly filed. 'system' for the engine's own decisions.
        mappedBy: m.mapped_by || null,
        // Resolved where we hold the user; falls back to nothing rather than
        // the raw id, which would read as noise on the row.
        mappedByName: m.mapped_by_name || null,
        subjectId: m.message_id,
        subjectType: 'message',
        channel,
        channelAccent: CHANNEL_ACCENT[channel] || 'gray',
        channelIcon: CHANNEL_ICON[channel] || 'chat',
        direction: m.message_direction || null,
        // ── Email-only fields ────────────────────────────────────────────
        //
        // An email is not a chat message and the timeline was rendering it as
        // one: no subject, no addresses, and the full body inline — so a
        // 400-word update swamped the surrounding SMS and call rows.
        //
        // subject has its own column and is reliable — messageWriter reads
        // event.subject, and migration 031 added the column precisely for
        // this. The timeline simply never SELECTed it, which is why emails
        // showed a body and no subject line.
        subject: m.subject || null,
        threadId: m.thread_id || null,
        // The ADDRESSES are best-effort, and deliberately so.
        //
        // `messages` has no from/to columns: migration 031 promoted
        // thread_id, subject and reply_to_message_id off the email payload
        // and pointedly did NOT promote addresses. So these are dug out of
        // raw_message, where the field names are not something this codebase
        // records anywhere — hence trying several shapes rather than
        // asserting one. If GHL names them differently again, this yields
        // null and the UI omits the From/To block entirely; it must never
        // become a reason an email fails to render.
        emailFrom: channel === 'EMAIL' ? emailAddr(m.raw_message, 'from') : null,
        emailTo: channel === 'EMAIL' ? emailAddr(m.raw_message, 'to') : null,
        senderId,
        senderName,
        senderAccent: senderId ? accentFor(senderId) : 'gray',
        // Recipients: not modelled yet in messages, so we default to
        // primary contact for outbound. Frontend uses this to render "to X"
        // and the group-message note.
        // Recipient of an outbound message. `messages` has no recipient
        // column, so we attribute it to the message's own contact_id —
        // truer than the deal's primary contact on a multi-contact deal,
        // where a rep may have emailed the architect rather than the buyer.
        toIds: isOutbound ? [m.msg_contact_id || result.contactId].filter(Boolean) : [],
        toNames: [],                       // filled by DealHub from /deals/:id people
        ts: m.message_timestamp,
        body: isCall && !hasTranscript ? null : (m.message_body || m.transcript_text),
        // Private GHL storage links are signed through our media proxy so
        // an <img> can load them — see services/attachmentProxy.js.
        attachments: proxyAttachments(locationId, extractAttachments(m.raw_message)),
        readable: isCall ? hasTranscript : true,
        // Whether the AI reads this message. Persisted in
        // ai_exclusions (migrations 051, 057) — absence of a row means
        // included, so a newly-synced message defaults in.
        included: !m.ai_excluded,
        imported: !!m.from_backfill,
        manual: false,                     // TODO: distinguish add-a-source inserts
        ambiguous: result.contactHasMultipleOpps,
        excludedBy: null,
        // Which deal this message is filed under. The timeline is scoped to
        // one opportunity via message_opportunity_map, so every row belongs
        // to the deal being viewed — but the row still shows it, because the
        // pill doubles as the reassignment control ("move this message to
        // another deal") and needs to state the current assignment.
        dealId: opportunityId,
        dealTag: result.opportunityName,
        callDurationMin: isCall && m.call_duration_seconds
          ? Math.round(m.call_duration_seconds / 60) : null,
        // Event rows render compact — no full card, just a thin line with
        // the icon + label. Activity events (opp created, task completed,
        // invoice paid, appointment booked, etc) get this treatment.
        event: channel === 'TASK' || channel === 'SYSTEM' || channel === 'ACTIVITY',
        // Human label derived from the raw GHL messageType. The normalised
        // channel (ACTIVITY) drops the specificity — this preserves it so
        // the UI can render "Opportunity · created" instead of "ACTIVITY".
        eventLabel: (channel === 'TASK' || channel === 'SYSTEM' || channel === 'ACTIVITY')
          ? eventLabelFromRaw(m.raw_message?.messageType || m.message_channel)
          : null,
        // Provider resolution — Twilio / Mailgun / WhatsApp / etc.
        providerId: m.conversation_provider_id,
        providerName: m.provider_name,
        providerType: m.provider_type,
        providerIsNative: m.provider_is_native,
        providerIcon: m.provider_icon || null
      };
    });

    // Tasks and notes as timeline rows.
    //
    // They share the message row shape so the client renders one merged list
    // rather than branching per kind. `kind` is what the UI keys the badges
    // off ("Added manually", "AI note — internal").
    const taskRows = result.tasks.map((t) => ({
      id: `task-${t.task_id}`,
      taskId: t.task_id,
      // What the selection checkbox binds to. subjectType tells the endpoint
      // which kind of exclusion row to write.
      subjectId: t.task_id,
      subjectType: 'task',
      included: !t.ai_excluded,
      kind: 'task',
      channel: 'TASK',
      // clay, not gray. The timeline tints each row's icon square and kind
      // label from this, and 'gray' meant a task was the one kind with no
      // colour at all — beside a gold note and a blue email. Clay is the
      // Tasks tab's own header colour, so the row and the tab agree.
      channelAccent: 'clay',
      channelIcon: 'check_circle',
      ts: t.created_at_ghl,
      // A task has an ASSIGNEE, not an author. Rendered in the same slot as a
      // note's author it read as "Task by Unassigned", which is wrong twice —
      // it names the wrong role and reports a blank as a person.
      senderName: null,
      assignee: t.assigned_to_name || null,
      // The contact the task concerns — distinct from the assignee, who is
      // the internal user it is allocated to. Both matter: "call back,
      // assigned to James, about Sarah Blake".
      contact: t.contact_id ? {
        id: t.contact_id,
        name: contactLabel(t)
      } : null,
      senderAccent: 'gray',
      // The mockup's "Task — <title>. Due <when>." single line. Built here so
      // the due date stays in the sentence rather than needing its own slot.
      title: taskTitle(t),
      // Only the body — the title and the due date are their own fields now.
      body: t.title && t.body && t.body !== t.title ? t.body : null,
      status: t.status,
      dueAt: t.due_at,
      duePhrase: duePhrase(t.due_at),
      // Same rule the tasks route uses: open, has a due date, and it's past.
      overdue: t.status === 'open' && !!t.due_at && new Date(t.due_at).getTime() < Date.now(),
      attachments: [],
      readable: true,
      imported: !!t.from_backfill,
      // Tasks arrive from GHL, where a human created them. Nothing in the
      // payload marks AI authorship, so this is always the manual badge —
      // when the agent starts writing tasks it will need a real flag rather
      // than an inference from the author name.
      manual: true,
      isAi: false,
      dealId: opportunityId,
      dealTag: result.opportunityName,
      event: false
    }));

    const noteRows = result.notes.map((n) => ({
      id: `note-${n.note_id}`,
      noteId: n.note_id,
      subjectId: n.note_id,
      subjectType: 'note',
      included: !n.ai_excluded,
      kind: 'note',
      attachmentCount: Number(n.attachment_count || 0),
      channel: 'NOTE',
      channelAccent: 'gold',
      channelIcon: 'sticky_note_2',
      ts: n.created_at_ghl,
      senderName: n.author_name || 'Unknown',
      senderAccent: 'gold',
      // The contact the note is filed against. contactLabel rather than a
      // raw name join: a GHL contact with no first/last name yielded null and
      // rendered an invisible chip.
      contact: n.contact_id ? {
        id: n.contact_id,
        name: contactLabel(n)
      } : null,
      // Prefer the note's OWN title. Migration 058 promoted title/color/pinned
      // out of raw_note, but this query and this mapper were written before that
      // and still derived a heading by splitting the body — so a title set in
      // GHL was invisible here, and the note's first line was shown as its
      // heading instead.
      //
      // splitNoteBody stays as the fallback for notes whose author gave no
      // title, which is most of them.
      ...(n.title
        ? { title: n.title, body: n.body }
        : splitNoteBody(n.body)),
      // Was never sent, so a colour picked in GHL had nothing to render from.
      color: n.color || null,
      pinned: n.pinned === true,
      attachments: [],
      readable: true,
      imported: !!n.from_backfill,
      manual: true,
      // The agent writes notes under this author name (noteWriter), so it's
      // the only signal available for the internal badge. A dedicated column
      // would be better — see the note in the UI component.
      isAi: isAgentAuthor(n.author_name),
      dealId: opportunityId,
      dealTag: result.opportunityName,
      event: false,
      // An internal comment written from OUR composer. GHL's public API
      // cannot create its own internal comments (neither send-message nor
      // add-inbound-message accepts the type — checked against the published
      // OpenAPI spec), so the composer saves one as a contact note titled
      // "Internal comment" (MessageComposer.jsx). Here it is given back its
      // real shape — the eye, the gold bubble, no title — so on this page it
      // reads the same as a comment written in GHL's inbox.
      ...(/^internal comment$/i.test(String(n.title || '').trim()) ? {
        isInternalComment: true,
        title: null,
        channel: 'INTERNAL',
        channelAccent: 'gold',
        channelIcon: 'visibility'
      } : {})
    }));

    // One stream, newest first. Rows with no timestamp sort last rather than
    // being dropped — a note with a missing date is still worth reading.
    const merged = [...rows, ...taskRows, ...noteRows].sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : -Infinity;
      const tb = b.ts ? new Date(b.ts).getTime() : -Infinity;
      return tb - ta;
    });

    // One page when paging (see the top of this handler); everything otherwise.
    const { page, hasMore, nextBefore } = pageTimeline(merged, pageSize);
    const inPage = new Set(page);

    res.json({
      messages: page,
      totalCount: page.length,
      // The header counts messages only — "20 messages" shouldn't silently
      // include tasks and notes.
      messageCount: rows.filter((r) => inPage.has(r)).length,
      taskCount: taskRows.filter((r) => inPage.has(r)).length,
      noteCount: noteRows.filter((r) => inPage.has(r)).length,
      // Infinite scroll: pass nextBefore back as `before` for older rows.
      hasMore,
      nextBefore
    });
  } catch (err) {
    logger.error({ err, opportunityId, locationId }, 'GET /api/deals/:id/timeline failed');
    next(err);
  }
});

// "Task — Send revised quote (rev 3). Due tomorrow." — the mockup's single
// line. The due date is folded into the sentence rather than given its own
// field, because that's how it reads on the timeline.
// Task bodies are HTML from GHL's rich-text editor and the UI renders them as
// such, so a title/body/due-date sentence spliced into one string breaks across
// the body's own block elements — it rendered as three ragged lines with a
// stray leading full stop. Send the parts separately and let the UI lay them
// out.
function taskTitle(t) {
  return t.title || stripTags(t.body) || 'Task';
}

// A note's first block becomes its heading, the remainder its body.
//
// Bodies are markup, so "first block" means the first block ELEMENT — splitting
// on "\n" finds nothing in "<p>a</p><p>b</p>" and would make the whole markup
// string the heading. Mirrors splitNote() in the dashboard's ListChrome, which
// does the same job for the list pages.
function splitNoteBody(raw) {
  const body = (raw || '').trim();
  if (!body) return { title: null, body: null };

  const blocks = [...body.matchAll(/<(p|div|h[1-6]|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  if (blocks.length > 1) {
    const heading = stripTags(blocks[0][2]);
    if (heading) {
      const rest = body.slice(blocks[0].index + blocks[0][0].length).trim();
      return { title: heading, body: rest || null };
    }
  }

  // One block, or plain text. Short enough to be a heading on its own; long
  // enough that a truncated first sentence in bold would read worse than none.
  const text = stripTags(body);
  if (text && text.length <= 120) return { title: text, body: null };

  const firstLine = (text || '').split(/(?<=[.!?])\s/)[0];
  return firstLine && firstLine.length <= 120
    ? { title: firstLine, body }
    : { title: null, body };
}

function stripTags(v) {
  if (!v) return null;
  const text = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

// Relative where it's useful ("tomorrow" reads faster than a date), absolute
// beyond a few days. Computed against the server clock, which is what the
// rest of the task UI already does.
function duePhrase(dueAt) {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  const startOfDay = (x) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days <= 7) return `in ${days} days`;
  return d.toISOString().slice(0, 10);
}

// Whether a note was written by the agent rather than a person.
//
// There is no flag for this yet: noteWriter resolves author_name from the
// `users` table exactly like a human-authored note, so nothing in the schema
// distinguishes the two. Matching on the author name is the only signal
// available, and it is deliberately narrow — a person legitimately named in a
// way that matched would get an "internal" badge they never earned.
//
// The real fix is a column (notes.authored_by = 'agent' | 'user') set at write
// time. Until then this returns false for everything a human wrote, which is
// the safe direction: a missing badge is a cosmetic gap, a wrong one is a lie
// about who said something.
const AGENT_AUTHOR_NAMES = new Set(['deal hub ai', 'pipelinepulse ai']);
function isAgentAuthor(authorName) {
  if (!authorName) return false;
  return AGENT_AUTHOR_NAMES.has(String(authorName).trim().toLowerCase());
}

// ── GET /api/deals/:id/stages ──────────────────────────────────────────
// Every stage in the deal's pipeline, in order, with the current one
// flagged. Powers the chevron stage stepper in the opportunity header.
//
// Pipeline-aware on purpose — GHL doesn't enforce a global stage order,
// so a marketing-pipeline deal has different stages than a sales-pipeline
// deal. Reading pipeline_stages for the deal's pipeline_id keeps the UI
// truthful across every pipeline the client has configured.

dealsRouter.get('/:id/stages', async (req, res, next) => {
  const opportunityId = req.params.id;
  const locationId = req.locationId;

  try {
    const result = await withTenant(locationId, async (client) => {
      const opp = await client.query(
        `SELECT pipeline_id, current_stage_name, status
           FROM opportunities
          WHERE location_id = $1
            AND opportunity_id = $2
            AND is_deleted = false
            AND deleted_at IS NULL`,
        [locationId, opportunityId]
      );
      if (!opp.rowCount) return null;
      const { pipeline_id, current_stage_name, status } = opp.rows[0];

      // Include inactive stages so a deal parked on a since-retired stage
      // still shows its position. We flag is_active on the response so the
      // UI can dim retired stages visually if needed.
      const stages = await client.query(
        // stage_id is what GHL's update endpoint takes — the UI cannot send a
        // stage it was never given. Before this the picker's values were stage
        // NAMES, which no write endpoint accepts.
        `SELECT stage_id, name, position, is_active
           FROM pipeline_stages
          WHERE location_id = $1
            AND pipeline_id = $2
          ORDER BY position ASC`,
        [locationId, pipeline_id]
      );
      return { stages: stages.rows, current: current_stage_name, status };
    });

    if (!result) return res.status(404).json({ error: 'Deal not found' });

    // Find the current stage's position; every stage before that is "past".
    let stagesArr = result.stages;
    let currentIdx = stagesArr.findIndex((s) => s.name === result.current);

    // Fallback: the deal points at a stage we don't know about (out-of-sync
    // pipeline_stages, or a stage renamed after this opp was last synced).
    // Rather than render a stepper with no highlight, insert the current
    // stage as a virtual entry so the user at least sees where the deal is.
    if (currentIdx === -1 && result.current) {
      stagesArr = [
        ...stagesArr,
        // stage_id null: this stage isn't in pipeline_stages, so we have no id
        // for it. The UI renders it (so the deal's position is visible) but
        // cannot move the deal TO it — see `id` in the response below.
        { stage_id: null, name: result.current, position: null, is_active: true }
      ];
      currentIdx = stagesArr.length - 1;
    }

    const stages = stagesArr.map((s, i) => ({
      // GHL's stage id. Null only for the virtual entry above — a stage we can
      // display but not move a deal to, because we don't know its id.
      id: s.stage_id || null,
      name: s.name,
      position: s.position,
      isActive: s.is_active,
      isCurrent: i === currentIdx,
      isPast: currentIdx >= 0 && i < currentIdx
    }));

    res.json({ stages, current: result.current, status: result.status });
  } catch (err) {
    logger.error({ err, opportunityId, locationId }, 'GET /api/deals/:id/stages failed');
    next(err);
  }
});

// ── GET /api/deals/:id/reassignment-targets ────────────────────────────
// The "Move this message to" popover options. Every open opp on the same
// contact, plus the always-present "Unassigned" fallback.

dealsRouter.get('/:id/reassignment-targets', async (req, res, next) => {
  const opportunityId = req.params.id;
  const locationId = req.locationId;

  try {
    const targets = await withTenant(locationId, async (client) => {
      const opp = await client.query(
        `SELECT contact_id FROM opportunities
          WHERE location_id = $1 AND opportunity_id = $2
            AND is_deleted = false AND deleted_at IS NULL`,
        [locationId, opportunityId]
      );
      if (!opp.rowCount) return null;
      const contactId = opp.rows[0].contact_id;

      const others = await client.query(
        `SELECT o.opportunity_id, o.name AS opportunity_name, o.current_stage_name,
                o.monetary_value, o.currency, o.pipeline_name,
                -- Selected so the pill can mark a won or lost deal. A
                -- manager may deliberately file a message against one, and
                -- the choice should be informed.
                o.status
           FROM opportunities o
          WHERE o.location_id = $1
            AND o.is_deleted  = false
            AND o.deleted_at IS NULL
            AND o.is_ghost    = false
            -- PRIMARY or additional contact, matching the write guard and
            -- the contact page. Filtering on contact_id alone offered only
            -- the primary's deals, so a message on a deal the contact was
            -- merely added to had nowhere to move.
            AND (
                  o.contact_id = $2
                  OR EXISTS (
                       SELECT 1 FROM opportunity_contacts oc
                        WHERE oc.location_id    = o.location_id
                          AND oc.opportunity_id = o.opportunity_id
                          AND oc.contact_id     = $2
                          AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
                     )
                )
          ORDER BY o.created_at_ghl DESC`,
        [locationId, contactId]
      );
      return others.rows.map((o) => ({
        id: o.opportunity_id,
        label: o.opportunity_name,
        // `name` as well as `label`: this endpoint predates the message
        // pill, which reads `name` like every other deal list in the app.
        // Returning only `label` rendered a nameless row — a dot and
        // nothing else. Both are sent rather than renaming, because the
        // people-chips reader still expects `label`.
        name: o.opportunity_name,
        // Status was never returned, so the pill could not mark a won or
        // lost deal — and James was explicit that a manager may file
        // against one deliberately, which means seeing which it is.
        status: o.status,
        stage: o.current_stage_name,
        pipeline: o.pipeline_name,
        value: o.monetary_value != null
          ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: o.currency || 'GBP', maximumFractionDigits: 0 }).format(o.monetary_value)
          : null,
        current: o.opportunity_id === opportunityId
      }));
    });

    if (!targets) return res.status(404).json({ error: 'Deal not found' });

    res.json({
      targets: [
        ...targets,
        { id: null, label: 'Unassigned — contact record only', current: false }
      ]
    });
  } catch (err) {
    logger.error({ err, opportunityId, locationId }, 'GET /api/deals/:id/reassignment-targets failed');
    next(err);
  }
});

// ── Writes ─────────────────────────────────────────────────────────────
//
// Scope is opportunities.write — separate from the opportunities.readonly the
// sync uses. The install needs reauthorising.
//
// NOTHING HERE WRITES POSTGRES. Opportunities have full webhook coverage, and
// stageHistoryWriter does far more on each event than update a row: it opens
// and closes stage_history (the basis of every "days in stage" figure),
// records field changes, reconciles tags and refreshes associations. Writing
// the row here as well would leave stage_history disagreeing with it — and
// stage_history is the one table that cannot be rebuilt from current state.
//
// See ghlOpportunityWrite.js. Pipelines are deliberately not writable: they
// need their own scopes and their update REPLACES the stage array, silently
// moving every deal in a removed stage.

async function resolveDealForWrite(locationId, opportunityId) {
  const row = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT opportunity_id, name, pipeline_id, status
         FROM opportunities
        WHERE location_id = $1 AND opportunity_id = $2
          -- Both flags, matching every read in this file. is_deleted is GHL's
          -- own marker; deleted_at is ours.
          AND is_deleted = false AND deleted_at IS NULL
        LIMIT 1`,
      [locationId, opportunityId]
    );
    return rows[0] || null;
  });

  if (!row) {
    throw new OpportunityWriteError('That deal no longer exists', { status: 404 });
  }
  const install = await getActiveInstall(locationId);
  if (!install) {
    // reauth_required and uninstalled need different fixes (clear a flag vs
    // reinstall the app) and shared one message. See explainInactiveInstall.
    const { message, reason } = await explainInactiveInstall(locationId);
    throw new OpportunityWriteError(message, { status: 409, reason });
  }
  return { install, deal: row };
}

// A stage id must belong to the deal's OWN pipeline. GHL rejects a mismatch
// with a message that doesn't say why, and it's an easy mistake for a client
// holding stages from a previously-viewed deal.
async function assertStageInPipeline(locationId, pipelineId, stageId) {
  if (!stageId) return;
  const ok = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM pipeline_stages
        WHERE location_id = $1 AND pipeline_id = $2 AND stage_id = $3
        LIMIT 1`,
      [locationId, pipelineId, stageId]
    );
    return rows.length > 0;
  });
  if (!ok) {
    throw new OpportunityWriteError(
      "That stage belongs to a different pipeline than this deal",
      { status: 422, field: 'pipelineStageId' }
    );
  }
}

function sendDealError(res, err, next, ctx) {
  // Both carry a status and a field. Without the AssociationError branch, a
  // validation failure on a deal↔contact link became a 500 with no field, so
  // the UI could not mark the control that caused it.
  if (err instanceof OpportunityWriteError || err instanceof AssociationError) {
    return res.status(err.status).json({ error: err.message, field: err.field || null, ...(err.reason ? { reason: err.reason } : {}) });
  }
  logger.error({ err, ...ctx }, 'deal write failed');
  return next(err);
}

// PATCH /api/deals/:id — edit name, value, stage, owner, expected close.
//
// Send only what changed.
//
// STATUS IS REFUSED HERE. It has its own endpoint below, because a lost reason
// can only be attached there — marking a deal lost through this route would
// drop the reason silently. Returning an error naming the right route beats
// accepting a request that half-works.
// ── PUT /api/deals/:id/messages/:messageId/mapping ─────────────────────
//
// Move one message to a different deal, by hand. The dropdown in the deal
// timeline and on the contact record both post here.
//
// LOCAL ONLY — deliberately. GHL has no concept of "which deal does this
// message belong to"; the attribution is ours. So there is nothing to write
// upstream and no scope that would allow it.
//
// The decision is recorded as `manually_resolved`, which outranks the engine
// permanently: attributeMessage() checks for it and skips, so a re-sync,
// backfill or the retrospective pass will not revert it.
//
// Body: { opportunityId }  — null/'' unlinks the message from every deal.
// `:id` is the deal the message is currently on, used to authorise the move.
dealsRouter.put('/:id/messages/:messageId/mapping', async (req, res, next) => {
  const locationId = req.locationId;
  const messageId = req.params.messageId;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object with opportunityId' });
  }
  // '' and null both mean "unlink". undefined means the caller forgot.
  if (!('opportunityId' in body)) {
    return res.status(400).json({
      error: 'Name the deal to move this message to, or null to unlink it',
      field: 'opportunityId'
    });
  }
  const targetOppId = body.opportunityId || null;

  try {
    const ok = await withTenant(locationId, async (client) => {
      // The message must be ours. RLS scopes the read, so a message in
      // another location 404s before anything is written.
      const msg = await client.query(
        `SELECT contact_id FROM messages
          WHERE location_id = $1 AND message_id = $2 AND deleted_at IS NULL`,
        [locationId, messageId]
      );
      if (!msg.rowCount) return { error: 'That message no longer exists', status: 404 };

      if (targetOppId) {
        // The target must exist and belong to the same contact. Without this
        // a mistyped id would file the message against an unrelated deal —
        // and unlike a bad write to GHL, nothing upstream would reject it.
        //
        // Status is NOT checked: James was explicit that a manager may file a
        // message against a Won, Lost or Abandoned deal. The Open-only rule
        // governs the automatic path, not this one.
        const target = await client.query(
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
          [locationId, targetOppId, msg.rows[0].contact_id]
        );
        if (!target.rowCount) {
          return {
            error: 'That deal is not on this contact, so the message cannot be moved to it',
            status: 400, field: 'opportunityId'
          };
        }
      }
      return { contactId: msg.rows[0].contact_id };
    });

    if (ok.error) {
      return res.status(ok.status).json({ error: ok.error, field: ok.field || null });
    }

    await manualResolve({
      locationId,
      messageId,
      opportunityId: targetOppId,
      // Who moved it. `req.session` is the verified JWT claims — the auth
      // middleware sets req.session and req.locationId, NOT req.userId, so
      // reading req.userId would have recorded every move as 'unknown' and
      // quietly lost the audit trail.
      reviewedBy: req.session?.userId || 'unknown',
      reviewNote: targetOppId ? 'moved via deal hub' : 'unlinked via deal hub'
    });

    logger.info(
      { locationId, messageId, opportunityId: targetOppId, reviewedBy: req.session?.userId || 'unknown' },
      'message mapping changed by hand'
    );
    res.json({ ok: true, messageId, opportunityId: targetOppId, mappingStatus: 'manually_resolved' });
  } catch (err) {
    logger.error({ err, locationId, messageId }, 'PUT message mapping failed');
    next(err);
  }
});

// ── POST /api/deals/:id/messages ───────────────────────────────────────
//
// Send a message from the Deal Hub composer — the GHL-style box under the
// timeline. Same write path as a Co-Pilot send (sendGhlMessage), without the
// propose/confirm step: the rep typed it, so the rep has already confirmed it.
//
// Body:
//   { type: 'Email'|'SMS'|'WhatsApp', contactId, conversationProviderId?,
//     message?, subject?, html?, emailCc?, emailBcc?, replyToMessageId? }
//
// `type` is the CHANNEL. A custom provider ("WhatsApp QR", "SMS Android",
// "iMessage") is sent as its channel plus its provider id, and
// buildMessageSend turns that into GHL's type 'Custom'.
//
// Nothing is written to messages here: the OutboundMessage webhook owns that,
// exactly as for every other send. What IS recorded is the deal, so the
// webhook files the message on THIS deal rather than whichever the
// attribution rule would pick for a contact with two open deals.
const DND_COLUMN = { Email: 'dnd_email', SMS: 'dnd_sms', WhatsApp: 'dnd_whatsapp' };

// On THIS deal, primary or additional — the same test the message-move guard
// above uses. Shared by the send and the attachment upload. The composer only
// offers the deal's people, so a miss is a stale page or a hand-made request.
const CONTACT_ON_DEAL_SQL =
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
          )`;

// The paperclip. Memory storage like the custom-field upload; the per-file
// and per-message limits are GHL's, enforced in messageAttachmentUpload.
const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_ATTACHMENTS, fileSize: MAX_ATTACHMENT_BYTES }
});

// ── POST /api/deals/:id/messages/attachments ──────────────────────────
//
// Upload files the rep picked in the composer, BEFORE the send — GHL wants
// the files first and takes their URLs on the message. Multipart:
// `contactId` plus one or more `files`. Returns { files: [{ name, url,
// size, type }] }; the composer sends the urls as `attachments`.
//
// Nothing is sent to the customer here. An upload the rep then abandons is
// an orphan file in GHL's storage, which is what GHL's own composer leaves too.
dealsRouter.post(
  '/:id/messages/attachments',
  (req, res, next) => uploadAttachments.array('files', MAX_ATTACHMENTS)(req, res, (err) => {
    // multer's own limit errors carry no rep-facing wording.
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'A file is over 25 MB' });
    if (err?.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `At most ${MAX_ATTACHMENTS} files per message` });
    return err ? next(err) : next();
  }),
  async (req, res, next) => {
    const locationId = req.locationId;
    const opportunityId = req.params.id;
    const contactId = String(req.body?.contactId || '').trim();
    if (!contactId) return res.status(400).json({ error: 'Pick who to send this to', field: 'contactId' });

    try {
      const onDeal = await withTenant(locationId, (client) =>
        client.query(CONTACT_ON_DEAL_SQL, [locationId, opportunityId, contactId]));
      if (!onDeal.rowCount) {
        return res.status(400).json({ error: 'That person is not on this deal', field: 'contactId' });
      }
      const install = await getActiveInstall(locationId);
      if (!install) {
        const inactive = await explainInactiveInstall(locationId);
        return res.status(409).json({ error: inactive.message, reason: inactive.reason });
      }
      const files = await uploadMessageAttachments(install, { contactId, files: req.files || [] });
      res.json({ files });
    } catch (err) {
      if (err instanceof AttachmentError) return res.status(err.status).json({ error: err.message });
      logger.error({ err, locationId, opportunityId }, 'POST deal message attachments failed');
      next(err);
    }
  }
);

dealsRouter.post('/:id/messages', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object describing the message' });
  }
  const type = String(body.type || '').trim();
  const contactId = String(body.contactId || '').trim();
  if (!DND_COLUMN[type]) {
    return res.status(400).json({ error: 'Pick a channel to send on', field: 'type' });
  }
  if (!contactId) {
    return res.status(400).json({ error: 'Pick who to send this to', field: 'contactId' });
  }

  try {
    const checked = await withTenant(locationId, async (client) => {
      const onDeal = await client.query(CONTACT_ON_DEAL_SQL, [locationId, opportunityId, contactId]);
      if (!onDeal.rowCount) {
        return { error: 'That person is not on this deal', status: 400, field: 'contactId' };
      }

      // DND BEFORE the send. GHL does refuse it, but only after the round
      // trip, and its wording varies by channel — checking our own copy of
      // the flags gives the rep the reason up front.
      const c = await client.query(
        `SELECT dnd, ${DND_COLUMN[type]} AS dnd_channel
           FROM contacts
          WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL`,
        [locationId, contactId]
      );
      if (!c.rowCount) return { error: 'That contact no longer exists', status: 404, field: 'contactId' };
      if (c.rows[0].dnd === true || c.rows[0].dnd_channel === true) {
        return {
          error: `This contact has do-not-disturb on for ${type} — nothing was sent`,
          status: 422, field: 'type'
        };
      }

      // A REPLY: the thread and subject come from our own copy of the email,
      // never from the request — so a stale or hand-edited id cannot send
      // into another contact's thread.
      let reply = null;
      if (type === 'Email' && body.replyToMessageId) {
        const r = await client.query(
          `SELECT message_id, thread_id, subject
             FROM messages
            WHERE location_id = $1 AND message_id = $2
              AND message_channel = 'EMAIL' AND deleted_at IS NULL
            LIMIT 1`,
          [locationId, String(body.replyToMessageId)]
        );
        if (!r.rowCount) {
          return { error: 'The email you are replying to no longer exists', status: 404, field: 'replyToMessageId' };
        }
        reply = r.rows[0];
      }
      return { reply };
    });

    if (checked.error) {
      return res.status(checked.status).json({ error: checked.error, field: checked.field || null });
    }

    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }

    const { reply } = checked;
    // "Re: " once. A subject the rep left as-is on a reply is the thread's
    // own, and GHL threads on replyMessageId/threadId, not on the text.
    const subject = body.subject
      ?? (reply?.subject ? `Re: ${String(reply.subject).replace(/^\s*re:\s*/i, '')}` : undefined);

    const sent = await sendGhlMessage(install, {
      type,
      contactId,
      userId: req.session?.userId || null,
      conversationProviderId: body.conversationProviderId || null,
      message: body.message,
      subject,
      html: body.html,
      // The To address, when the rep addressed a different one of the
      // contact's addresses; GHL requires it to belong to that contact.
      emailTo: body.emailTo,
      emailCc: body.emailCc,
      emailBcc: body.emailBcc,
      attachments: body.attachments,
      replyMessageId: reply?.message_id || null,
      threadId: reply?.thread_id || null,
      emailReplyMode: body.emailReplyMode
    });

    // Park the deal for the webhook. Both ids: an email's webhook can carry
    // either, depending on which GHL fills in (see messageWriter's
    // `messageId || emailMessageId`). The unused one expires in an hour.
    const ids = [...new Set([sent.messageId, sent.emailMessageId].filter(Boolean))];
    for (const id of ids) {
      await recordPendingDealLink(
        locationId, ENTITY_MESSAGE, id, opportunityId, req.session?.userId || null, 'composer'
      );
    }

    // The webhook can beat this response. If the row is already in, its
    // attribution has run without the pick — so run it again now, which
    // consumes the pick and files it here.
    if (ids.length) {
      const landed = await withTenant(locationId, async (client) => {
        const { rows } = await client.query(
          `SELECT message_id, message_timestamp FROM messages
            WHERE location_id = $1 AND message_id = ANY($2::text[])`,
          [locationId, ids]
        );
        return rows;
      });
      for (const m of landed) {
        await attributeMessage({
          locationId, messageId: m.message_id, contactId,
          messageTimestamp: m.message_timestamp, detectedVia: 'composer'
        });
      }
    }

    logger.info(
      { locationId, opportunityId, contactId, type, messageId: sent.messageId, reply: !!reply },
      'composer: message sent'
    );
    res.status(201).json({
      ok: true,
      messageId: sent.messageId,
      emailMessageId: sent.emailMessageId,
      conversationId: sent.conversationId
    });
  } catch (err) {
    if (err instanceof MessageWriteError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err, locationId, opportunityId }, 'POST deal message failed');
    next(err);
  }
});

dealsRouter.patch('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of fields to change' });
  }
  if ('status' in req.body) {
    return res.status(400).json({
      error: 'Use PUT /api/deals/:id/status to change a deal’s status — it is the only route that records a lost reason',
      field: 'status'
    });
  }

  try {
    const { install, deal } = await resolveDealForWrite(locationId, opportunityId);
    if (req.body.pipelineStageId) {
      // Validate against the INCOMING pipeline when one is being set, not the
      // stored one. Moving a deal to another pipeline necessarily moves it to a
      // stage of that pipeline, and checking the old pipeline rejected every
      // such save with "that stage belongs to a different pipeline than this
      // deal" — correct about the stored pipeline, wrong about the request.
      await assertStageInPipeline(
        locationId,
        req.body.pipelineId || deal.pipeline_id,
        req.body.pipelineStageId
      );
    }
    const opportunity = await updateGhlOpportunity(install, opportunityId, req.body);
    await applyClearedCustomFields(locationId, opportunityId, req.body.customFields);
    res.json({ opportunity, source: 'ghl' });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId });
  }
});

// applyClearedCustomFields — see services/opportunityFields.js for why a clear
// has to be written to our own columns by whoever received the request.

// PUT /api/deals/:id/status   body: { status, lostReasonId? }
//
// The only route that can record a lost reason.
// PUT /api/deals/:id/status — change a deal's status, with the reason.
//
// Body: { status, reason?, lostReasonId? }
//
// TWO GHL CALLS, AND THEY CANNOT BE MERGED. Status lives on
// PUT /opportunities/:id/status, which accepts lostReasonId but NOT custom
// fields; the reason is a custom field and has to go through
// PUT /opportunities/:id. So the reason is a second request, after the first.
//
// That ordering is deliberate: status first means a failure on the reason
// leaves a deal correctly marked closed but missing its reason — recoverable
// by editing the deal. The other order would record a reason on a deal whose
// status never changed, which reads as data corruption to a manager.
//
// The response says which parts landed rather than a bare ok, so the UI can
// tell the rep "marked lost, but the reason didn't save" instead of implying
// the whole thing failed.
dealsRouter.put('/:id/status', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const { status, lostReasonId, reason } = req.body || {};

  const normalised = String(status || '').trim().toLowerCase();
  const needsReason = CLOSED_STATUSES.includes(normalised);
  const reasonText = typeof reason === 'string' ? reason.trim() : '';

  // A closing status without a reason is refused BEFORE anything is written —
  // a manager who half-completes the dialog should not leave a deal closed
  // with no explanation.
  if (needsReason && !reasonText) {
    return res.status(400).json({
      error: 'Say why this deal is being closed — the reason is recorded against it',
      field: 'reason'
    });
  }

  try {
    const { install } = await resolveDealForWrite(locationId, opportunityId);

    // 1. Status. Throws on failure, so nothing below runs.
    await setGhlOpportunityStatus(install, opportunityId, { status, lostReasonId });

    // 2. The reason, into the field matching the outcome.
    let reasonSaved = false;
    let reasonError = null;

    if (needsReason) {
      const fieldKey = outcomeReasonKey(normalised);
      try {
        // Resolve key -> THIS location's field id. Each sub-account has its
        // own id for the same key, so the id can never be hardcoded.
        const fieldId = await withTenant(locationId, async (client) => {
          const { rows } = await client.query(
            `SELECT field_id
               FROM ghl_custom_field_definitions
              WHERE location_id = $1
                AND object_type = 'opportunity'
                AND field_key   = $2
                AND is_active
              LIMIT 1`,
            [locationId, fieldKey]
          );
          return rows[0]?.field_id || null;
        });

        if (!fieldId) {
          // The field is not defined in this sub-account. Known to happen:
          // "11. Abandoned Reason" was created in one location of four. Not
          // an error the manager can act on, so it is reported as an
          // unsaved reason and logged loudly for us.
          logger.warn(
            { locationId, opportunityId, status: normalised, fieldKey },
            'deal status: outcome reason field is not defined in this location'
          );
          reasonError = 'The reason could not be saved — that field is not set up in this sub-account';
        } else {
          await updateGhlOpportunity(install, opportunityId, {
            customFields: [{ id: fieldId, field_value: reasonText }]
          });
          reasonSaved = true;
        }
      } catch (err) {
        // Status HAS changed. Report the partial result rather than an error
        // that implies nothing happened.
        logger.warn(
          { err, locationId, opportunityId, status: normalised, fieldKey },
          'deal status: changed, but the reason could not be saved'
        );
        reasonError = 'The reason could not be saved — you can add it by editing the deal';
      }
    }

    res.json({
      ok: true,
      id: opportunityId,
      status: normalised,
      reasonSaved,
      reasonError,
      reasonField: needsReason ? OUTCOME_REASON_FIELD[normalised] : null,
      source: 'ghl'
    });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId });
  }
});

// POST /api/deals — create a deal on a contact.
//
// Body: { contactId, name, pipelineId, pipelineStageId?, monetaryValue?, ... }
//
// locationId comes from the session. contactId is checked against our own
// contacts under RLS, so a contact from another location fails as "not found"
// rather than reaching GHL.
dealsRouter.post('/', async (req, res, next) => {
  const locationId = req.locationId;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of deal fields' });
  }
  const { contactId } = body;
  if (!contactId) {
    return res.status(400).json({
      error: 'A deal needs a contact', field: 'contactId'
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
    if (body.pipelineId && body.pipelineStageId) {
      await assertStageInPipeline(locationId, body.pipelineId, body.pipelineStageId);
    }

    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }
    const opportunity = await createGhlOpportunity(install, body);
    res.status(201).json({ opportunity, source: 'ghl' });
  } catch (err) {
    sendDealError(res, err, next, { locationId, contactId });
  }
});

// DELETE /api/deals/:id
//
// Hard delete in GHL. Our row is left to the OpportunityDelete webhook, which
// also closes the open stage_history row — doing it here would leave that row
// open forever and inflate every "days in stage" figure the deal feeds.
dealsRouter.delete('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;

  try {
    const { install } = await resolveDealForWrite(locationId, opportunityId);
    await deleteGhlOpportunity(install, opportunityId);
    res.json({ ok: true, id: opportunityId });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId });
  }
});

// Same memory storage and limits as the contact upload — see the note there.
const uploadFiles = multer({
  storage: multer.memoryStorage(),
  limits: { files: 15, fileSize: 25 * 1024 * 1024 }
});

// POST /api/deals/:id/custom-fields/:fieldKey/files
//
// Upload one or more files to an opportunity's FILE_UPLOAD custom field.
//
// The contact version of this lives in routes/contacts.js and the two share
// customFieldUpload — GHL's endpoint takes either a contact id or an
// opportunity id under the same `id` field. What differs is the OWNERSHIP
// check: a deal is proved through resolveDealForWrite, which also hands back
// the install.
dealsRouter.post(
  '/:id/custom-fields/:fieldKey/files',
  uploadFiles.array('files', 15),
  async (req, res, next) => {
    const locationId = req.locationId;
    const opportunityId = req.params.id;
    const fieldKey = req.params.fieldKey;

    try {
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No file was sent', field: 'file' });
      }

      // Proves the deal is ours AND gives us the install.
      const { install } = await resolveDealForWrite(locationId, opportunityId);

      // The field must exist and take files — uploading to a text field
      // would be accepted by GHL and then be unreadable.
      const def = await withTenant(locationId, async (client) => {
        const { rows } = await client.query(
          `SELECT field_type, raw_definition
             FROM ghl_custom_field_definitions
            WHERE location_id = $1
              AND object_type = 'opportunity'
              AND field_key   = $2
              AND is_active
            LIMIT 1`,
          [locationId, fieldKey]
        );
        return rows[0] || null;
      });

      if (!def) {
        return res.status(404).json({ error: 'That field was not found', field: 'fieldKey' });
      }
      if (String(def.field_type || '').toUpperCase() !== 'FILE_UPLOAD') {
        return res.status(400).json({
          error: 'That field does not take files', field: 'fieldKey'
        });
      }

      const uploaded = await uploadToCustomField(install, {
        recordId: opportunityId,
        fieldKey,
        files,
        maxFiles: def.raw_definition?.maxFileLimit
      });

      // Nothing written locally: the OpportunityUpdate webhook carries the
      // new value, as with every other deal edit.
      return res.json({ files: uploaded });
    } catch (err) {
      if (err instanceof UploadError) {
        return res.status(err.status || 400).json({ error: err.message, field: err.field, ...(err.reason ? { reason: err.reason } : {}) });
      }
      if (err instanceof OpportunityWriteError) {
        return res.status(err.status || 400).json({ error: err.message, field: err.field, ...(err.reason ? { reason: err.reason } : {}) });
      }
      logger.error({ err, locationId, opportunityId, fieldKey }, 'deal file upload failed');
      return next(err);
    }
  }
);

// PUT /api/deals/:id/primary-contact   body: { contactId }
//
// Change which contact a deal belongs to.
//
// WHY A DEDICATED ROUTE rather than a field on the ordinary deal PATCH.
// contactId is @HideApiProperty on GHL's PUT /opportunities/:id — absent from
// the marketplace docs, but the service still applies it:
//
//     if (body.contactId) opportunity.contactId = body.contactId
//
// It validates the contact exists and is not deleted, then updates. Two
// consequences shape this endpoint:
//
//   1. It is UNDOCUMENTED on this verb, so it can be withdrawn without
//      notice. Isolating it means a failure here breaks reassignment alone,
//      not every deal edit.
//   2. It changes which contact GHL files future notes and tasks against —
//      not a field you want swept in from a whole-record PATCH by accident.
//      buildOpportunityPatch drops contactId unless the caller opts in.
dealsRouter.put('/:id/primary-contact', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const contactId = (req.body?.contactId || '').toString().trim();

  if (!contactId) {
    return res.status(400).json({ error: 'Name a contact', field: 'contactId' });
  }

  try {
    const { install } = await resolveDealForWrite(locationId, opportunityId);

    // Checked against OUR table under RLS first, so a contact from another
    // sub-account fails as "not found" rather than reaching GHL. Same guard
    // the add-contact route uses.
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
      return res.status(404).json({ error: 'That contact was not found', field: 'contactId' });
    }

    const updated = await updateGhlOpportunity(
      install, opportunityId, { contactId },
      // The opt-in. Without it the patch builder drops the field.
      { allowPrimaryContact: true }
    );

    // MIRRORED LOCALLY, not left to the webhook alone.
    //
    // This used to write nothing and wait for OpportunityUpdate to carry the
    // new contactId back. When that webhook does not arrive — and for a
    // contactId-only change it is not guaranteed to — the row kept the old
    // primary, the UI repainted from it, and "Make primary" looked like it
    // had silently done nothing. The same failure the business link had.
    //
    // Writing both halves here makes the change true immediately. The webhook
    // is still the authority when it does arrive; this only stops the gap.
    await withTenant(locationId, async (client) => {
      await client.query(
        `UPDATE opportunities
            SET contact_id = $3
          WHERE location_id = $1 AND opportunity_id = $2`,
        [locationId, opportunityId, contactId]
      );
      // The link row's flag, kept in step — the people list ORs this with a
      // match on opportunities.contact_id, so leaving it stale badges two
      // people PRIMARY at once.
      await client.query(
        `UPDATE opportunity_contacts
            SET is_primary = (contact_id = $3)
          WHERE location_id = $1 AND opportunity_id = $2`,
        [locationId, opportunityId, contactId]
      );
    });

    logger.info(
      { locationId, opportunityId, contactId },
      'deal primary contact changed'
    );
    return res.json({ ok: true, opportunity: updated || null });
  } catch (err) {
    if (err instanceof OpportunityWriteError) {
      return res.status(err.status || 400).json({ error: err.message, field: err.field, ...(err.reason ? { reason: err.reason } : {}) });
    }
    logger.error({ err, locationId, opportunityId, contactId }, 'PUT /primary-contact failed');
    return next(err);
  }
});

// POST /api/deals/:id/contacts   body: { contactId }
// DELETE /api/deals/:id/contacts/:relationId
//
// Add or remove a person on a deal. The People rail had an input for this that
// searched nothing and saved nothing.
//
// Nothing is written locally. opportunity_contacts is keyed on GHL's own
// relation_id and populated by the RelationCreate webhook, so writing a row
// here would either duplicate what the webhook is about to insert or invent a
// relation_id GHL never issued.
dealsRouter.post('/:id/contacts', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const contactId = req.body?.contactId;

  if (!contactId) {
    return res.status(400).json({ error: 'Name a contact to add', field: 'contactId' });
  }

  try {
    // Proves the deal is ours AND gives us the install. `deal` carries the
    // pipeline id, which GHL requires on an opportunity↔contact association.
    const { install, deal } = await resolveDealForWrite(locationId, opportunityId);

    // The contact is checked against OUR table under RLS, so a contact from
    // another sub-account fails as "not found" rather than reaching GHL.
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

    // opportunities.pipeline_id is nullable, and GHL will not accept this
    // association without one. Caught here so the rep gets a sentence that
    // names the problem on THIS deal, rather than GHL's
    // "Pipeline ID is required for opportunity contact association" — which
    // is accurate and tells them nothing they can act on.
    if (!deal.pipeline_id) {
      return res.status(409).json({
        error: 'This deal has no pipeline, and your CRM needs one before a '
             + 'contact can be linked. Open the deal in your CRM and set its pipeline.',
        field: 'opportunityId'
      });
    }

    const relation = await addDealContact(
      install, opportunityId, contactId, deal.pipeline_id
    );
    res.status(201).json({ relation, source: 'ghl' });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId, contactId });
  }
});

// relationId, not contactId: an opportunity↔contact relation is a real row
// with its own id (which is why opportunity_contacts is keyed on it). The
// composite `${first}-${second}` form only works for task and note relations.
dealsRouter.delete('/:id/contacts/:relationId', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  const relationId = req.params.relationId;

  try {
    const { install } = await resolveDealForWrite(locationId, opportunityId);

    // The relation must belong to THIS deal in THIS location. Without this a
    // caller could pass any relation id and unlink a contact from a deal they
    // cannot see — resolveDealForWrite only proves they own the deal in the
    // path, not that the relation is part of it.
    const owned = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT is_primary FROM opportunity_contacts
          WHERE location_id = $1 AND relation_id = $2 AND opportunity_id = $3
          LIMIT 1`,
        [locationId, relationId, opportunityId]
      );
      return rows[0] || null;
    });
    if (!owned) {
      return res.status(404).json({ error: 'That link is not on this deal' });
    }
    // GHL names an opportunity after its primary contact and the timeline
    // attributes messages through it, so removing it would leave a deal whose
    // own name refers to someone no longer on it.
    if (owned.is_primary) {
      return res.status(422).json({
        error: 'This is the deal\u2019s primary contact — make someone else primary first',
        field: 'relationId'
      });
    }

    await removeDealContact(install, relationId);
    res.json({ ok: true, source: 'ghl' });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId, relationId });
  }
});

// POST /api/deals/:id/followers   body: { followers: ["userId"] }
// DELETE /api/deals/:id/followers — same body.
//
// Additive both ways, like contact tags. isRemoveAllFollowers is deliberately
// not exposed — see ghlOpportunityWrite.js.
dealsRouter.post('/:id/followers', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  try {
    const { install } = await resolveDealForWrite(locationId, opportunityId);
    const result = await addGhlOpportunityFollowers(install, opportunityId, req.body);
    res.json({ ...result, source: 'ghl' });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId });
  }
});

dealsRouter.delete('/:id/followers', async (req, res, next) => {
  const locationId = req.locationId;
  const opportunityId = req.params.id;
  try {
    const { install } = await resolveDealForWrite(locationId, opportunityId);
    const result = await removeGhlOpportunityFollowers(install, opportunityId, req.body);
    res.json({ ...result, source: 'ghl' });
  } catch (err) {
    sendDealError(res, err, next, { locationId, opportunityId });
  }
});
