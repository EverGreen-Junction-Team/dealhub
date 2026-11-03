// backfill.js — one-shot historical backfill for a single location.
//
// Usage:
//   DATABASE_URL=postgresql://... node src/scripts/backfill.js --location <locationId>
//
// Reads the existing OAuth install row for the location, pulls every
// opportunity from GHL (paginated, all pipelines, all statuses), reconstructs
// each opportunity's stage history from conversation activity messages
// (TYPE_ACTIVITY_OPPORTUNITY rows — the same source convoVault uses, since
// GHL has no /opportunityHistory endpoint), buckets channel messages into
// each stage window, and writes everything into the same tables the live
// webhook flow writes to.
//
// Idempotent:
//   - contacts / opportunities → UPSERT
//   - stage_history → ON CONFLICT DO NOTHING via the (loc, opp, stage_id,
//     entered_at) unique index from migration 010
//   - messages → ON CONFLICT DO NOTHING via the existing (loc, message_id)
//     unique index
//
// Safe to re-run; safe to interrupt and resume (the script picks up where
// the DB already has data). Live webhooks may continue to flow during the
// backfill — last-write-wins on contacts/opportunities, dedup guards
// elsewhere.

import 'dotenv/config';
import { pool, withTenant } from '../db.js';
import { logger } from '../utils/logger.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import {
  getPipelineLookup,
  getCustomFieldNameMaps,
  getOpportunityFull,
  getContactFull,
  getUserName
} from '../services/ghlEnrichment.js';
import { fetchContactMessagesViaExport } from '../services/messageEnrichment.js';
import { cleanMessageBody } from '../services/dataCleaner.js';
import { jsonbParam } from '../services/customFieldResolve.js';

// ─── CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--location') out.locationId = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) {
      // ignore unknown for forward-compat
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.locationId) {
  console.error('Usage: node src/scripts/backfill.js --location <locationId> [--limit N] [--dry-run]');
  process.exit(2);
}

// ─── helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GHL rate limit: 100 req per 10s. Pace conservatively at ~8 req/sec
// (125ms between calls) so we don't exhaust the bucket during a long run.
const PACE_MS = 125;
async function paced(fn) {
  const r = await fn();
  await sleep(PACE_MS);
  return r;
}

// MEDDIC + product/postcode/etc. — same list the live writer promotes.
// Kept in sync with stageHistoryWriter.js pickOpportunity().
const MEDDIC_KEYS = [
  'meddic_1','meddic_2','meddic_3','meddic_4','meddic_5',
  'meddic_6','meddic_7','meddic_8','meddic_9','meddic_10','meddic_11'
];

function promotedFromCf(cf) {
  cf = cf || {};
  return {
    meddic: Object.fromEntries(MEDDIC_KEYS.map((k) => [k, cf[k] ?? null])),
    client_type: cf.client_type || null,
    product_system: cf.product_system || null,
    product_type: cf.product_type || null,
    postcode: cf.postcode || null,
    first_contact_method: cf.first_contact__method || cf.first_contact_method || null,
    lead_source_opportunity: cf.lead_source_opportunity || null,
    inquiry: cf.inquiry || null
  };
}

function promotedFromContactCf(cf) {
  cf = cf || {};
  return {
    gclid: cf.google_click_id || cf.gclid || null,
    gbraid: cf.gbraid || null,
    wbraid: cf.wbraid || null,
    gad_source: cf.gad_source || null,
    utm_source: cf.utm_source || null,
    utm_medium: cf.utm_medium || null,
    utm_campaign: cf.utm_campaign || null,
    utm_content: cf.utm_content || null,
    utm_term: cf.utm_term || null,
    marketing_consent: cf.marketing_consent_crittall ?? cf.marketing_consent ?? null
  };
}

// ─── GHL fetchers ────────────────────────────────────────────────────────

// Paginates /opportunities/search across every pipeline + status. GHL caps
// each page at 100 and exposes `meta.startAfter` + `meta.startAfterId` for
// pagination. We loop until a page comes back empty.
async function* iterateOpportunities(install) {
  let startAfter = null;
  let startAfterId = null;
  let safety = 0;
  while (safety++ < 10_000) {
    const params = new URLSearchParams({
      location_id: install.location_id,
      limit: '100'
    });
    if (startAfter) params.set('startAfter', String(startAfter));
    if (startAfterId) params.set('startAfterId', startAfterId);

    const { data } = await paced(() => ghlRequest(install, {
      method: 'GET',
      url: `/opportunities/search?${params.toString()}`
    }));
    const batch = data?.opportunities || [];
    if (batch.length === 0) return;

    for (const opp of batch) yield opp;

    const meta = data?.meta || {};
    if (!meta.startAfter && !meta.startAfterId) return;
    startAfter = meta.startAfter || null;
    startAfterId = meta.startAfterId || null;
  }
}

// Per-contact: list all conversations, then for each conversation pull the
// activity messages (TYPE_ACTIVITY_OPPORTUNITY, GHL message type 28/29).
// Returns the raw activity rows; we group + walk them in the caller.
async function fetchActivityEvents(install, contactId) {
  // Reuse the conversation list endpoint (same as messageEnrichment).
  const conversations = [];
  let startAfter = null;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({
      locationId: install.location_id,
      contactId,
      limit: '100'
    });
    if (startAfter) params.set('startAfter', startAfter);
    const { data } = await paced(() => ghlRequest(install, {
      method: 'GET',
      url: `/conversations/search?${params.toString()}`
    }));
    const batch = data?.conversations || [];
    conversations.push(...batch);
    if (batch.length < 100) break;
    startAfter = batch[batch.length - 1]?.id;
    if (!startAfter) break;
  }

  // For each conversation pull activity messages.
  const activity = [];
  for (const conv of conversations) {
    let lastMessageId = null;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ limit: '100' });
      // Server-side filter: only the activity rows that represent stage
      // transitions. GHL's /conversations/{id}/messages expects the STRING
      // type name (e.g. "TYPE_ACTIVITY_OPPORTUNITY"), not the numeric code —
      // sending the number returns 400 with the full list of valid names.
      params.set('type', 'TYPE_ACTIVITY_OPPORTUNITY');
      if (lastMessageId) params.set('lastMessageId', lastMessageId);
      const { data } = await paced(() => ghlRequest(install, {
        method: 'GET',
        url: `/conversations/${conv.id}/messages?${params.toString()}`
      }));
      const msgs = data?.messages?.messages || data?.messages || [];
      if (!msgs.length) break;
      for (const m of msgs) {
        activity.push({ ...m, conversationId: conv.id });
      }
      lastMessageId = msgs[msgs.length - 1]?.id;
      if (!lastMessageId || msgs.length < 100) break;
    }
  }
  return activity;
}

// ─── stage walk ──────────────────────────────────────────────────────────

// Pull the (oppId, oldStageName, newStageName, eventType, dateAdded) tuple
// out of an activity message. Tracks the same shape variations convoVault
// learned to handle.
function extractStageEvent(m) {
  const act = m.activity || {};
  const data = act.data || {};
  const oppId = data.opportunityId || data.opportunity?.id || m.opportunityId || null;
  const eventType = act.type || m.activityType || null;
  const oldStageName = data.oldStageName || data.previousStageName || null;
  const newStageName = data.newStageName || data.stageName || null;
  const pipelineName = data.pipeline || data.pipelineName || null;
  return {
    oppId,
    eventType,
    oldStageName,
    newStageName,
    pipelineName,
    dateAdded: m.dateAdded || m.timestamp || null
  };
}

// Resolve stageName → stageId within a pipeline (best-effort).
function makeStageResolver(pipelineLookup) {
  // Build pipelineId → { stageName → stageId } from the cached lookup.
  const byPipeline = {};
  for (const [stageId, meta] of Object.entries(pipelineLookup.stageById || {})) {
    const pid = meta.pipelineId;
    if (!pid) continue;
    (byPipeline[pid] ||= {})[meta.stageName] = stageId;
  }
  return (pipelineId, stageName) => byPipeline[pipelineId]?.[stageName] || null;
}

// Walk an opportunity's activity events to produce stage sessions:
//   [ { stage_id, stage_name, entered_at, left_at|null, deleted, current_stage } ]
//
// Mirrors convoVault/billing.js:1049+ — same algorithm, slimmer output.
function buildStageSessions(opp, events, stageResolver, pipelineLookup) {
  const sorted = [...events].sort(
    (a, b) => new Date(a.dateAdded) - new Date(b.dateAdded)
  );

  // No events → one open session at opp.createdAt with opp's current stage.
  if (sorted.length === 0) {
    const stageId = opp.pipelineStageId || opp.stageId || null;
    const stageInfo = stageId ? pipelineLookup.stageById[stageId] : null;
    return [{
      stageId,
      stageName: stageInfo?.stageName || null,
      pipelineId: opp.pipelineId || stageInfo?.pipelineId || null,
      pipelineName: stageInfo?.pipelineName || null,
      enteredAt: opp.createdAt || opp.dateAdded || null,
      leftAt: null,
      deleted: false,
      currentStage: true,
      triggeredBy: 'backfill'
    }];
  }

  const sessions = [];
  // Initial stage + entry timestamp.
  const first = sorted[0];
  let currentStageName;
  let entryTs;
  if (first.eventType === 'opportunity_created') {
    currentStageName = first.newStageName || null;
    entryTs = first.dateAdded;
  } else {
    currentStageName = first.oldStageName
      || (opp.pipelineStageId && pipelineLookup.stageById[opp.pipelineStageId]?.stageName)
      || null;
    entryTs = opp.createdAt || opp.dateAdded || first.dateAdded;
  }

  let terminated = false;
  for (const ev of sorted) {
    if (ev.eventType === 'opportunity_created') continue; // consumed above

    const isTransition = ev.eventType === 'opportunity_stage_updated';
    const isDelete = ev.eventType === 'opportunity_deleted';
    if (!isTransition && !isDelete) continue;

    const leftTs = ev.dateAdded;
    const stageId = stageResolver(opp.pipelineId, currentStageName);
    const stageInfo = stageId ? pipelineLookup.stageById[stageId] : null;
    sessions.push({
      stageId,
      stageName: currentStageName,
      pipelineId: opp.pipelineId || stageInfo?.pipelineId || null,
      pipelineName: stageInfo?.pipelineName || ev.pipelineName || null,
      enteredAt: entryTs,
      leftAt: leftTs,
      deleted: isDelete,
      currentStage: false,
      triggeredBy: 'backfill'
    });
    if (isDelete) { terminated = true; break; }
    entryTs = leftTs;
    currentStageName = ev.newStageName || null;
  }

  if (!terminated) {
    const stageId = stageResolver(opp.pipelineId, currentStageName);
    const stageInfo = stageId ? pipelineLookup.stageById[stageId] : null;
    sessions.push({
      stageId,
      stageName: currentStageName,
      pipelineId: opp.pipelineId || stageInfo?.pipelineId || null,
      pipelineName: stageInfo?.pipelineName || null,
      enteredAt: entryTs,
      leftAt: null,
      deleted: false,
      currentStage: true,
      triggeredBy: 'backfill'
    });
  }

  return sessions;
}

// ─── DB writers ──────────────────────────────────────────────────────────

async function upsertContactRow(client, locationId, contactId, contact) {
  const cf = contact?.customFieldsResolved || {};
  const p = promotedFromContactCf(cf);
  // from_backfill: stays true if the row is brand-new (this script inserted
  // it). If the row already existed (live webhook wrote it first), the
  // ON CONFLICT path does NOT touch the flag — preserves provenance.
  await client.query(
    `INSERT INTO contacts (location_id, contact_id, gclid, gbraid, wbraid, gad_source,
                           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                           marketing_consent, custom_fields, from_backfill, imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, true, now(), now())
     ON CONFLICT (location_id, contact_id) DO UPDATE SET
       gclid              = COALESCE(EXCLUDED.gclid, contacts.gclid),
       gbraid             = COALESCE(EXCLUDED.gbraid, contacts.gbraid),
       wbraid             = COALESCE(EXCLUDED.wbraid, contacts.wbraid),
       gad_source         = COALESCE(EXCLUDED.gad_source, contacts.gad_source),
       utm_source         = COALESCE(EXCLUDED.utm_source, contacts.utm_source),
       utm_medium         = COALESCE(EXCLUDED.utm_medium, contacts.utm_medium),
       utm_campaign       = COALESCE(EXCLUDED.utm_campaign, contacts.utm_campaign),
       utm_content        = COALESCE(EXCLUDED.utm_content, contacts.utm_content),
       utm_term           = COALESCE(EXCLUDED.utm_term, contacts.utm_term),
       marketing_consent  = COALESCE(EXCLUDED.marketing_consent, contacts.marketing_consent),
       custom_fields      = EXCLUDED.custom_fields,
       updated_at         = now()`,
    [
      locationId, contactId,
      p.gclid, p.gbraid, p.wbraid, p.gad_source,
      p.utm_source, p.utm_medium, p.utm_campaign, p.utm_content, p.utm_term,
      p.marketing_consent, cf
    ]
  );
}

async function upsertOpportunityRow(client, locationId, opp, oppFull, assignedToName) {
  const cf = oppFull?.customFieldsResolved || {};
  const p = promotedFromCf(cf);
  const m = p.meddic;
  // from_backfill is set true on INSERT only; the ON CONFLICT branch below
  // leaves it untouched so live-webhook-inserted rows keep from_backfill=false
  // even if the backfill later sees them again.
  await client.query(
    `INSERT INTO opportunities (location_id, opportunity_id, contact_id, name,
        pipeline_id, pipeline_name, current_stage_id, current_stage_name,
        first_stage_id, first_stage_name, status,
        monetary_value, assigned_to, assigned_to_name,
        meddic_1, meddic_2, meddic_3, meddic_4, meddic_5,
        meddic_6, meddic_7, meddic_8, meddic_9, meddic_10,
        client_type, product_system, product_type, postcode,
        first_contact_method, lead_source_opportunity, inquiry,
        custom_fields, is_deleted, created_at_ghl, from_backfill, imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             $25,$26,$27,$28,$29,$30,$31,$32,$33,$34, true, now(), now())
     ON CONFLICT (location_id, opportunity_id) DO UPDATE SET
       contact_id              = EXCLUDED.contact_id,
       name                    = EXCLUDED.name,
       pipeline_id             = EXCLUDED.pipeline_id,
       pipeline_name           = COALESCE(EXCLUDED.pipeline_name, opportunities.pipeline_name),
       current_stage_id        = EXCLUDED.current_stage_id,
       current_stage_name      = COALESCE(EXCLUDED.current_stage_name, opportunities.current_stage_name),
       status                  = EXCLUDED.status,
       monetary_value          = COALESCE(EXCLUDED.monetary_value, opportunities.monetary_value),
       assigned_to             = EXCLUDED.assigned_to,
       assigned_to_name        = COALESCE(EXCLUDED.assigned_to_name, opportunities.assigned_to_name),
       meddic_1                = COALESCE(EXCLUDED.meddic_1, opportunities.meddic_1),
       meddic_2                = COALESCE(EXCLUDED.meddic_2, opportunities.meddic_2),
       meddic_3                = COALESCE(EXCLUDED.meddic_3, opportunities.meddic_3),
       meddic_4                = COALESCE(EXCLUDED.meddic_4, opportunities.meddic_4),
       meddic_5                = COALESCE(EXCLUDED.meddic_5, opportunities.meddic_5),
       meddic_6                = COALESCE(EXCLUDED.meddic_6, opportunities.meddic_6),
       meddic_7                = COALESCE(EXCLUDED.meddic_7, opportunities.meddic_7),
       meddic_8                = COALESCE(EXCLUDED.meddic_8, opportunities.meddic_8),
       meddic_9                = COALESCE(EXCLUDED.meddic_9, opportunities.meddic_9),
       meddic_10               = COALESCE(EXCLUDED.meddic_10, opportunities.meddic_10),
       client_type             = COALESCE(EXCLUDED.client_type, opportunities.client_type),
       product_system          = COALESCE(EXCLUDED.product_system, opportunities.product_system),
       product_type            = COALESCE(EXCLUDED.product_type, opportunities.product_type),
       postcode                = COALESCE(EXCLUDED.postcode, opportunities.postcode),
       first_contact_method    = COALESCE(EXCLUDED.first_contact_method, opportunities.first_contact_method),
       lead_source_opportunity = COALESCE(EXCLUDED.lead_source_opportunity, opportunities.lead_source_opportunity),
       inquiry                 = COALESCE(EXCLUDED.inquiry, opportunities.inquiry),
       custom_fields           = EXCLUDED.custom_fields,
       is_deleted              = $33,
       updated_at              = now()`,
    [
      locationId, opp.id, opp.contactId, opp.name,
      opp.pipelineId, oppFull?.pipelineName || null, opp.pipelineStageId, oppFull?.stageName || oppFull?.pipelineStageName || null,
      opp.pipelineStageId, oppFull?.stageName || oppFull?.pipelineStageName || null,
      opp.status, opp.monetaryValue ?? null,
      opp.assignedTo || null, assignedToName,
      m.meddic_1, m.meddic_2, m.meddic_3, m.meddic_4, m.meddic_5,
      m.meddic_6, m.meddic_7, m.meddic_8, m.meddic_9, m.meddic_10,
      // The four JSONB columns need JSON, not a Postgres array literal —
      // node-postgres produces the latter from a JS array and JSONB rejects it
      // (22P02). postcode/inquiry/lead_source_opportunity are TEXT.
      jsonbParam(p.client_type), jsonbParam(p.product_system),
      jsonbParam(p.product_type), p.postcode,
      jsonbParam(p.first_contact_method), p.lead_source_opportunity, p.inquiry,
      cf, false,
      opp.createdAt || opp.dateAdded || null
    ]
  );
}

// Insert a stage session row. Returns the row id (new or existing) so we
// can link messages to it. ON CONFLICT relies on migration 010.
async function upsertStageRow(client, locationId, opp, oppFull, session) {
  const cf = oppFull?.customFieldsResolved || {};
  const p = promotedFromCf(cf);
  const inserted = await client.query(
    `INSERT INTO stage_history (location_id, opportunity_id, contact_id,
        stage_id, stage_name, pipeline_id, pipeline_name,
        entered_at, left_at, in_stage_duration_seconds, current_stage, deleted,
        product_system, product_type, custom_fields_snapshot, triggered_by, from_backfill)
     VALUES ($1,$2,$3,$4,COALESCE($5,'Unknown'),$6,$7,
             $8,$9,
             CASE WHEN $9::timestamptz IS NULL THEN NULL
                  ELSE GREATEST(0, EXTRACT(EPOCH FROM ($9::timestamptz - $8::timestamptz))::INTEGER) END,
             $10, $11,
             $12, $13, $14, $15, true)
     ON CONFLICT (location_id, opportunity_id, COALESCE(stage_id, ''), entered_at)
     DO NOTHING
     RETURNING id`,
    [
      locationId, opp.id, opp.contactId,
      session.stageId, session.stageName, session.pipelineId, session.pipelineName,
      session.enteredAt, session.leftAt,
      session.currentStage, session.deleted,
      jsonbParam(p.product_system), jsonbParam(p.product_type), jsonbParam(cf), session.triggeredBy
    ]
  );
  if (inserted.rows[0]?.id) return inserted.rows[0].id;

  // Already existed → look it up so we can still link messages to it.
  const existing = await client.query(
    `SELECT id FROM stage_history
      WHERE location_id=$1 AND opportunity_id=$2
        AND COALESCE(stage_id, '') = COALESCE($3, '')
        AND entered_at = $4
      LIMIT 1`,
    [locationId, opp.id, session.stageId, session.enteredAt]
  );
  return existing.rows[0]?.id || null;
}

async function insertMessages(client, locationId, opp, stageHistoryId, messages) {
  let inserted = 0;
  for (const m of messages) {
    const cleaned = cleanMessageBody(m.body, m.channel);
    const r = await client.query(
      `INSERT INTO messages (location_id, contact_id, opportunity_id, stage_history_id,
          message_id, conversation_id, message_timestamp,
          message_body, message_body_raw, message_direction, message_channel,
          message_status, is_call, from_backfill)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, true)
       ON CONFLICT (location_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        locationId, opp.contactId, opp.id, stageHistoryId,
        m.messageId, m.conversationId, m.timestamp,
        cleaned, m.body, m.direction, m.channel,
        m.status || null, m.isCall
      ]
    );
    if (r.rowCount > 0) inserted++;
  }
  return inserted;
}

// Pick which stage session a message belongs to (enteredAt ≤ ts < leftAt).
// If a session is open (leftAt = null) it absorbs everything from entered_at
// onwards. Returns null if no session matches (shouldn't happen — the open
// final session always exists).
function pickSessionForMessage(sessions, ts) {
  for (const s of sessions) {
    const start = new Date(s.enteredAt).getTime();
    const end = s.leftAt ? new Date(s.leftAt).getTime() : Infinity;
    if (ts >= start && ts < end) return s;
  }
  return null;
}

// ─── per-opportunity pipeline ────────────────────────────────────────────

async function processOpportunity(install, opp, ctx) {
  const { locationId, pipelineLookup, stageResolver } = ctx;

  // 1. Enrich opp + contact (custom fields, names, etc). Best-effort —
  //    fall back to bare opp if either fetch fails.
  const [oppFull, contactFull, assignedToName] = await Promise.all([
    getOpportunityFull(install, opp.id),
    opp.contactId ? getContactFull(install, opp.contactId) : Promise.resolve(null),
    opp.assignedTo ? getUserName(install, opp.assignedTo) : Promise.resolve(null)
  ]);

  // 2. Pull activity events for this contact, filter to this opp.
  const activity = opp.contactId ? await fetchActivityEvents(install, opp.contactId) : [];
  const events = activity
    .map(extractStageEvent)
    .filter((e) => e.oppId === opp.id && e.dateAdded);

  // 3. Build the stage sessions timeline.
  const sessions = buildStageSessions(opp, events, stageResolver, pipelineLookup);

  // 4. Determine the overall window we need messages for: from earliest
  //    stage entry to now (open) or last leftAt (closed).
  const firstEntry = sessions[0]?.enteredAt
    ? new Date(sessions[0].enteredAt)
    : new Date(opp.createdAt || opp.dateAdded || 0);
  const lastSession = sessions[sessions.length - 1];
  const lastEdge = lastSession?.leftAt
    ? new Date(lastSession.leftAt)
    : new Date(); // open session → up to now

  // 5. Fetch every channel message in that window for the contact. Reuses
  //    the same two-pass export (default + Email) as the live writer.
  const allMessages = opp.contactId
    ? await fetchContactMessagesViaExport(install, opp.contactId, firstEntry, lastEdge)
    : [];

  if (ctx.dryRun) {
    logger.info({
      opportunityId: opp.id, contactId: opp.contactId,
      sessions: sessions.length, messages: allMessages.length
    }, 'backfill[dry-run]: would write');
    return { sessions: 0, messages: 0 };
  }

  // 6. Write everything in one tenant-scoped transaction.
  let sessionsWritten = 0;
  let messagesWritten = 0;
  await withTenant(locationId, async (client) => {
    if (opp.contactId) {
      await upsertContactRow(client, locationId, opp.contactId, contactFull);
    }
    await upsertOpportunityRow(client, locationId, opp, oppFull, assignedToName);

    // Pre-bucket messages per session, in-process — avoids re-querying for
    // each session window.
    const buckets = new Map(); // sessionIdx → message[]
    for (const m of allMessages) {
      const ts = m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp).getTime();
      const session = pickSessionForMessage(sessions, ts);
      if (!session) continue;
      const idx = sessions.indexOf(session);
      if (!buckets.has(idx)) buckets.set(idx, []);
      buckets.get(idx).push(m);
    }

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const stageHistoryId = await upsertStageRow(client, locationId, opp, oppFull, session);
      if (stageHistoryId !== null) sessionsWritten++;
      const bucket = buckets.get(i) || [];
      if (stageHistoryId && bucket.length) {
        messagesWritten += await insertMessages(client, locationId, opp, stageHistoryId, bucket);
      }
    }
  });

  return { sessions: sessionsWritten, messages: messagesWritten };
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  const locationId = args.locationId;
  logger.info({ locationId, dryRun: !!args.dryRun, limit: args.limit || null }, 'backfill: starting');

  const install = await getActiveInstall(locationId);
  if (!install) {
    throw new Error(`No active install for location ${locationId}. Reinstall the GHL marketplace app first.`);
  }

  // Prime caches (pipelines + cf maps) once — every per-opp fetch reads
  // through the same cached results.
  const pipelineLookup = await getPipelineLookup(install);
  await getCustomFieldNameMaps(install);
  const stageResolver = makeStageResolver(pipelineLookup);
  logger.info({
    locationId,
    pipelines: Object.keys(pipelineLookup.pipelineById).length,
    stages: Object.keys(pipelineLookup.stageById).length
  }, 'backfill: caches primed');

  const ctx = { locationId, pipelineLookup, stageResolver, dryRun: !!args.dryRun };

  let processed = 0;
  let totalSessions = 0;
  let totalMessages = 0;
  const startedAt = Date.now();

  for await (const opp of iterateOpportunities(install)) {
    if (args.limit && processed >= args.limit) break;
    processed++;
    try {
      const { sessions, messages } = await processOpportunity(install, opp, ctx);
      totalSessions += sessions;
      totalMessages += messages;
      if (processed % 10 === 0 || processed === 1) {
        logger.info({
          processed, totalSessions, totalMessages,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          opportunityId: opp.id, contactId: opp.contactId
        }, 'backfill: progress');
      }
    } catch (err) {
      logger.error({ err, opportunityId: opp.id }, 'backfill: opportunity failed (continuing)');
    }
  }

  logger.info({
    locationId,
    opportunitiesProcessed: processed,
    stageSessionsWritten: totalSessions,
    messagesWritten: totalMessages,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000)
  }, 'backfill: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfill: failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
