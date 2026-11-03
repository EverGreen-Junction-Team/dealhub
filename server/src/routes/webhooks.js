import express from 'express';
import { verifyGhlWebhook } from '../utils/verifySignature.js';
import { getActiveInstall, markUninstalled } from '../services/ghlClient.js';
import { getAgencyInstall, mintLocationInstall, markAgencyUninstalled, noteAgencyInstallEvent } from '../services/agencyInstall.js';
import { handleOpportunityEvent } from '../services/stageHistoryWriter.js';
import { enqueue, dequeue } from '../services/orphanQueue.js';
import { handleUserUpsert, handleUserDelete } from '../services/userWriter.js';
import { handleTaskCreate, handleTaskComplete, handleTaskDelete } from '../services/taskWriter.js';
import { handleNoteCreate, handleNoteUpdate, handleNoteDelete } from '../services/noteWriter.js';
import { handleContactUpsert, handleContactDelete, handleContactDndUpdate } from '../services/contactWriter.js';
import { handleInboundMessage, handleOutboundMessage } from '../services/messageWriter.js';
import { handleRelationCreate, handleRelationDelete } from '../services/opportunityContactWriter.js';
import {
  handleBusinessContactRelationCreate, handleBusinessContactRelationDelete
} from '../services/businessContactRelationWriter.js';
import {
  handleTaskNoteRelationCreate, handleTaskNoteRelationDelete, HANDLED_ASSOCIATIONS
} from '../services/taskNoteRelationWriter.js';
import { reconcileTags } from '../services/tagHistoryWriter.js';
import { fanoutFromContact } from '../services/tagFanout.js';
import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

// Best-effort status update on processed_events. The dedup INSERT already
// captured the row upstream — this just stamps the outcome so we can query
// "which webhooks failed?" later. Errors here NEVER propagate: if the
// status update fails we log warn and let the actual webhook response
// stand. Match to ghl_raw via event_id (already on both tables).
async function markProcessed(eventId, status, error) {
  if (!eventId) return;
  try {
    await rawQuery(
      `UPDATE processed_events
          SET status = $2,
              error  = $3
        WHERE event_id = $1`,
      [eventId, status, error ? String(error).slice(0, 2000) : null]
    );
  } catch (err) {
    logger.warn({ err, eventId, status }, 'webhook: markProcessed failed (non-fatal)');
  }
}

export const webhooksRouter = express.Router();

// Event types we recognise. GHL routes EVERYTHING (app lifecycle + per-record
// events) through the same webhook URL — we have to dispatch by `type`.
const APP_LIFECYCLE_TYPES = new Set(['INSTALL', 'UNINSTALL']);
const OPPORTUNITY_TYPES = new Set([
  // Stage-affecting events → write stage_history rows
  'OpportunityCreate', 'opportunity.created', 'opportunity_created',
  'OpportunityStageUpdate', 'opportunity.stage_updated', 'opportunity_stage_updated',
  'OpportunityDelete', 'opportunity.deleted', 'opportunity_deleted',
  // Metadata-only events → just refresh the opportunities row via enrichment.
  // No stage_history change (the opp hasn't moved between stages).
  'OpportunityUpdate', 'opportunity.updated', 'opportunity_updated',
  'OpportunityStatusUpdate', 'opportunity.status_updated', 'opportunity_status_updated',
  'OpportunityAssignedToUpdate', 'opportunity.assigned_to_updated', 'opportunity_assigned_to_updated',
  'OpportunityMonetaryValueUpdate', 'opportunity.monetary_value_updated', 'opportunity_monetary_value_updated'
]);

// Task events (migration 015, taskWriter.js). No TaskUpdate exists in GHL.
const TASK_TYPES = new Set(['TaskCreate', 'TaskComplete', 'TaskDelete']);

// Note events (migration 017, noteWriter.js). NoteUpdate DOES exist.
const NOTE_TYPES = new Set(['NoteCreate', 'NoteUpdate', 'NoteDelete']);

// User events (migration 014, userWriter.js). Soft delete on UserDelete.
const USER_TYPES = new Set(['UserCreate', 'UserUpdate', 'UserDelete']);

// Contact tag events (migrations 018/019/020, tagHistoryWriter.js).
// GHL sends the FULL new tag list; the writer diffs against open rows.
const CONTACT_TAG_TYPES = new Set(['ContactTagUpdate']);

// Contact core events (migration 026, contactWriter.js). ContactTagUpdate
// stays separate (above) — tag_history + tags[] machinery already exists.
// ContactDndUpdate IS subscribed as of migration 052. DND is now promoted to
// columns and gates AI draft channels (spec rule 7) — and this event is the
// only signal when a rep toggles DND without otherwise editing the contact.
// Without it, the gate would enforce whatever DND state happened to be true
// at the last unrelated ContactUpdate.
//
// Requires the ContactDndUpdate webhook to be enabled in the GHL Marketplace
// app config; without that subscription this handler simply never fires.
const CONTACT_TYPES = new Set([
  'ContactCreate', 'ContactUpdate', 'ContactDelete', 'ContactDndUpdate'
]);

// Message events (migration 031, messageWriter.js). Layer 1 of the 3-layer
// capture strategy — real-time writes. Layer 2 (stage-transition fetch in
// stageHistoryWriter) retro-fills opp/stage linkage. Layer 3 (messagesSync
// daily cron) catches dropped webhooks.
const MESSAGE_TYPES = new Set(['InboundMessage', 'OutboundMessage']);

// Opp ↔ contact association events (migration 048). We only care about the
// OPPORTUNITIES_CONTACTS_ASSOCIATION rows — the writer filters others out.
const RELATION_TYPES = new Set(['RelationCreate', 'RelationDelete']);

// Single ingress for every opportunity-related event GHL sends us. The
// app-level webhook URL in the GHL developer dashboard points here:
//   POST ${PUBLIC_BASE_URL}/webhooks/ghl
//
// Flow:
//   1. Verify GHL's RSA signature against the raw body
//   2. Parse out event type + id + locationId
//   3. Confirm the location has an active install (drop otherwise)
//   4. Record event id for idempotency (duplicate delivery → no-op)
//   5. Maintain the orphan queue based on event type
//   6. Hand off to the stage history writer
//
// We always 200 unless the request is structurally invalid — writer errors
// are logged but not bubbled to GHL, otherwise retry storms would mask bugs.
webhooksRouter.post('/ghl', async (req, res) => {
  if (!verifyGhlWebhook(req)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const event = req.body || {};
  // Full raw payload — useful while onboarding new event types (tasks,
  // notes, messages, etc.) so we can see the exact shape GHL sends.
  // Trim later once the new event types are stable.
  logger.info({ payload: event }, 'webhook: raw payload received');

  const eventType = event.type || event.event || event.eventType;
  // Dedup key MUST be unique per delivery, not per record. GHL puts the
  // unique-per-delivery id in `webhookId` for ALL event types. The top-level
  // `event.id` on opportunity events is actually the OPPORTUNITY id (stable
  // across create + stage_update + delete) — using it would dedup unrelated
  // events for the same opp. Prefer webhookId; fall back to id/eventId only
  // when webhookId is absent (older event shapes).
  const eventId = event.webhookId || event.eventId || event.id;
  const locationId = event.locationId || event.location_id || event.location?.id;
  // For opportunity events the opp id is at top-level (flat webhook shape) or
  // under .opportunity.id (nested shape).
  const opportunityId = event.opportunity?.id || event.opportunityId || (
    // Only treat top-level `id` as opportunity id when this is an opportunity event
    eventType && eventType.toLowerCase().includes('opportunity') ? event.id : undefined
  );

  // Forensic archive — every payload goes to ghl_raw before ANY dispatch
  // logic. Unrecognised event types still get captured, so when we onboard
  // the next new event we already have real samples to work from.
  // Best-effort: never block the dispatch on this.
  rawQuery(
    `INSERT INTO ghl_raw (event_id, location_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [eventId || null, locationId || null, eventType || null, event]
  ).catch((err) => {
    logger.warn({ err, eventType, eventId }, 'webhook: ghl_raw archive write failed (non-fatal)');
  });

  // An AGENCY-level lifecycle event carries a companyId and no locationId.
  const companyOnly = APP_LIFECYCLE_TYPES.has(eventType) && !locationId && !!event.companyId;
  if (!eventType || !eventId || (!locationId && !companyOnly)) {
    logger.warn({ event }, 'webhook: rejecting malformed payload');
    return res.status(400).json({ error: 'malformed_event' });
  }

  // ── App-lifecycle events ────────────────────────────────────────────────
  // GHL routes INSTALL + UNINSTALL through the same webhook URL as data
  // events. INSTALL is largely redundant with the OAuth callback (which
  // already wrote the install row + tokens) — we just acknowledge it.
  // UNINSTALL is authoritative: we mark the install dead + clear tokens.
  if (APP_LIFECYCLE_TYPES.has(eventType)) {
    // Dedupe lifecycle events too — same webhook can be redelivered.
    try {
      await rawQuery(
        `INSERT INTO processed_events (event_id, location_id, event_type)
         VALUES ($1, $2, $3)`,
        // processed_events.location_id is NOT NULL. An agency-level event has
        // no location, so it is filed under its company instead of crashing
        // here before the uninstall is ever handled.
        [eventId, locationId || `company:${event.companyId}`, eventType]
      );
    } catch (err) {
      if (err?.code === '23505') {
        logger.debug({ eventId, eventType }, 'webhook: lifecycle duplicate — already processed');
        return res.json({ ok: true, dropped: 'duplicate' });
      }
      throw err;
    }

    if (eventType === 'INSTALL') {
      // Under an AGENCY install this is how a sub-account announces itself —
      // no OAuth callback runs for it — so mint its token from the agency's.
      // A direct sub-account install has its row already (the callback wrote
      // it) and is left alone.
      if (locationId && event.companyId) {
        try {
          const existing = await getActiveInstall(locationId);
          const agency = existing ? null : await getAgencyInstall(event.companyId);
          if (agency) {
            await mintLocationInstall(event.companyId, locationId);
            logger.info({ locationId, companyId: event.companyId, eventId }, 'webhook: INSTALL — sub-account token minted from agency');
            return res.json({ ok: true, type: 'install_minted' });
          }
        } catch (err) {
          logger.error({ err, locationId, companyId: event.companyId, eventId }, 'webhook: INSTALL mint failed');
        }
      }
      logger.info(
        { locationId, companyId: event.companyId, companyName: event.companyName, eventId },
        'webhook: INSTALL notification received (OAuth callback handles credentials)'
      );
      return res.json({ ok: true, type: 'install_notification' });
    }

    if (eventType === 'INSTALL' && companyOnly) {
      // The OAuth callback already recorded the agency; this just dates it,
      // so an older UNINSTALL redelivered later is known to be stale.
      await noteAgencyInstallEvent(event.companyId, event.timestamp).catch((err) =>
        logger.warn({ err, companyId: event.companyId }, 'webhook: could not note agency INSTALL'));
      logger.info({ companyId: event.companyId, eventId }, 'webhook: agency INSTALL noted');
      return res.json({ ok: true, type: 'agency_install_noted' });
    }

    if (eventType === 'UNINSTALL' && companyOnly) {
      try {
        const n = await markAgencyUninstalled(event.companyId, { eventTs: event.timestamp });
        if (n < 0) return res.json({ ok: true, type: 'agency_uninstall_stale' });
        logger.info({ companyId: event.companyId, locations: n, eventId }, 'webhook: agency UNINSTALL processed');
        return res.json({ ok: true, type: 'agency_uninstall_processed', locations: n });
      } catch (err) {
        logger.error({ err, companyId: event.companyId, eventId }, 'webhook: agency UNINSTALL failed');
        return res.json({ ok: false, error: 'agency_uninstall_failed' });
      }
    }

    if (eventType === 'UNINSTALL') {
      try {
        const wasMarked = await markUninstalled(locationId);
        logger.info(
          { locationId, companyId: event.companyId, eventId, wasMarked },
          'webhook: UNINSTALL processed — install marked inactive + tokens cleared'
        );
        return res.json({ ok: true, type: 'uninstall_processed', wasMarked });
      } catch (err) {
        logger.error({ err, locationId, eventId }, 'webhook: UNINSTALL handler failed');
        return res.json({ ok: false, error: 'uninstall_failed' });
      }
    }
  }

  // ── Per-record events ──────────────────────────────────────────────────
  const isOpportunityEvent = OPPORTUNITY_TYPES.has(eventType);
  const isTaskEvent = TASK_TYPES.has(eventType);
  const isNoteEvent = NOTE_TYPES.has(eventType);
  const isUserEvent = USER_TYPES.has(eventType);
  const isContactTagEvent = CONTACT_TAG_TYPES.has(eventType);
  const isContactEvent = CONTACT_TYPES.has(eventType);
  const isMessageEvent = MESSAGE_TYPES.has(eventType);
  const isRelationEvent = RELATION_TYPES.has(eventType);

  if (!isOpportunityEvent && !isTaskEvent && !isNoteEvent && !isUserEvent && !isContactTagEvent && !isContactEvent && !isMessageEvent && !isRelationEvent) {
    // Unrecognised type. Log + 200-and-drop so GHL doesn't retry forever.
    // The full payload was already archived to ghl_raw above, so we can
    // inspect what GHL sent and add a handler later if useful.
    logger.info({ eventType, eventId, locationId }, 'webhook: unrecognised event type — dropping');
    return res.json({ ok: true, dropped: 'unknown_event_type' });
  }

  // allowDead: TRUE here, deliberately.
  //
  // getActiveInstall treats a reauth_required install as inactive, which is
  // right for OUTBOUND calls — retrying against a dead token is three wasted
  // round trips per request. But a WEBHOOK is inbound: GHL has already told
  // us something changed, and dropping it loses that change permanently. The
  // webhook is not a request we can retry.
  //
  // That is what happened: one flagged location silently discarded every note,
  // task and opportunity event while the flag was set. The events are gone —
  // GHL does not redeliver on a 200.
  //
  // Writers that need the token (noteWriter's attachment fetch, enrichment)
  // fail individually and fall back to the webhook payload, which is the
  // behaviour they already have for a scope-missing 401. Losing enrichment on
  // some fields beats losing the event.
  const install = await getActiveInstall(locationId, { allowDead: true });
  if (!install) {
    logger.info({ locationId, eventType }, 'webhook: dropping — no install row for this location');
    return res.json({ ok: true, dropped: 'no_install' });
  }

  // Visible, not silent: this location's outbound calls are failing, so any
  // field that needs an API fetch (attachments, enrichment) will be missing
  // from what we write. The event itself is still processed.
  if (install.reauth_required_at) {
    logger.warn(
      { locationId, eventType, reauthRequiredAt: install.reauth_required_at },
      'webhook: processing against an install that needs reauth — enrichment will be incomplete'
    );
  }

  // Idempotency. INSERT first; on duplicate-key we've seen this event before.
  try {
    await rawQuery(
      `INSERT INTO processed_events (event_id, location_id, event_type)
       VALUES ($1, $2, $3)`,
      [eventId, locationId, eventType]
    );
  } catch (err) {
    if (err?.code === '23505') {
      logger.debug({ eventId }, 'webhook: duplicate delivery — already processed');
      return res.json({ ok: true, dropped: 'duplicate' });
    }
    throw err;
  }

  // ── Opportunity events ────────────────────────────────────────────────
  if (isOpportunityEvent) {
    // Orphan-queue maintenance. Any opp event other than `Create` means the
    // opp is no longer "stuck since creation" — pull it from the pending queue.
    try {
      const isCreated = ['OpportunityCreate','opportunity.created','opportunity_created'].includes(eventType);
      if (isCreated) {
        await enqueue(event);
      } else if (opportunityId) {
        // Status update, assignment change, monetary value change, stage move,
        // delete — all signal activity on the opp. Clear it from pending.
        await dequeue(locationId, opportunityId);
      }
    } catch (err) {
      // Orphan-queue is best-effort. If it fails the stage_history writer
      // will still produce the right downstream rows; the daily sweep will
      // pick up any leak next run.
      logger.warn({ err, eventId }, 'webhook: orphan queue update failed (non-fatal)');
    }

    try {
      await handleOpportunityEvent(install, eventType, event);
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId, opportunityId }, 'webhook: opportunity event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: opportunity writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── Task events ───────────────────────────────────────────────────────
  if (isTaskEvent) {
    try {
      if (eventType === 'TaskCreate') await handleTaskCreate(install, event);
      else if (eventType === 'TaskComplete') await handleTaskComplete(install, event);
      else if (eventType === 'TaskDelete') await handleTaskDelete(install, event);
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId }, 'webhook: task event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: task writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── Note events ───────────────────────────────────────────────────────
  if (isNoteEvent) {
    try {
      if (eventType === 'NoteCreate') await handleNoteCreate(install, event);
      else if (eventType === 'NoteUpdate') await handleNoteUpdate(install, event);
      else if (eventType === 'NoteDelete') await handleNoteDelete(install, event);
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId }, 'webhook: note event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: note writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── User events ───────────────────────────────────────────────────────
  if (isUserEvent) {
    try {
      if (eventType === 'UserCreate' || eventType === 'UserUpdate') {
        await handleUserUpsert(install, event);
      } else if (eventType === 'UserDelete') {
        await handleUserDelete(install, event);
      }
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId }, 'webhook: user event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: user writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── Contact tag events ────────────────────────────────────────────────
  // ContactTagUpdate carries the FULL new tag list. tagHistoryWriter diffs
  // against currently-open rows in tag_history and opens new sessions for
  // added tags, closes existing sessions for removed ones. Also refreshes
  // contacts.tags TEXT[] as a mirrored current-state projection.
  //
  // Payload shape observed:
  //   { type: 'ContactTagUpdate', locationId, id: <contactId>, tags: [...] }
  // GHL uses `id` for the contact ID here (not `contactId`) — same shape as
  // opportunity events. Prefer explicit .contactId when present.
  if (isContactTagEvent) {
    try {
      const contactId = event.contactId || event.contact?.id || event.id;
      const tagList = event.tags || event.contact?.tags || [];
      if (!contactId) {
        await markProcessed(eventId, 'failed', 'missing_contact_id');
        logger.warn({ eventType, eventId }, 'webhook: ContactTagUpdate missing contact id — dropping');
        return res.json({ ok: false, error: 'missing_contact_id' });
      }
      await reconcileTags({
        locationId,
        entityType: 'contact',
        entityId: contactId,
        currentTags: tagList,
        detectedVia: eventType
      });
      // Push the change onto every deal this contact is on. GHL has no
      // opportunity tags (migration 048), so a deal's tags ARE its
      // contacts' — and the deals list filter reads them from
      // tag_history. Without this the filter would answer with whatever
      // migration 134 seeded and never move again.
      //
      // AFTER the contact reconcile, so the union it recomputes already
      // includes this change. Best-effort inside: a tag is a filter facet
      // and must never cost us the contact write that carried it.
      await fanoutFromContact(locationId, contactId);
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId, contactId, tagCount: tagList.length }, 'webhook: contact tag event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: tag writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── Message events ────────────────────────────────────────────────────
  // Layer 1 of the 3-layer capture strategy. Writes the row with best-effort
  // opp/stage linkage. Layer 2 (stage transitions) retro-fills gaps. Layer 3
  // (daily messagesSync) catches dropped webhooks.
  if (isMessageEvent) {
    try {
      if (eventType === 'InboundMessage') {
        await handleInboundMessage(install, event);
      } else if (eventType === 'OutboundMessage') {
        await handleOutboundMessage(install, event);
      }
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId }, 'webhook: message event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: message writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── Contact core events ───────────────────────────────────────────────
  // ContactCreate/ContactUpdate → upsert with all promoted fields resolved
  // via ghl_custom_field_definitions. ContactDelete → soft delete.
  if (isContactEvent) {
    try {
      if (eventType === 'ContactCreate' || eventType === 'ContactUpdate') {
        await handleContactUpsert(install, event);
      } else if (eventType === 'ContactDelete') {
        await handleContactDelete(install, event);
      } else if (eventType === 'ContactDndUpdate') {
        await handleContactDndUpdate(install, event);
      }
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId }, 'webhook: contact event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: contact writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // ── Relation events (opp ↔ contact) ──────────────────────────────────
  // OPPORTUNITIES_CONTACTS_ASSOCIATION only; other association types are
  // silently ignored inside the writer.
  if (isRelationEvent) {
    try {
      // Two handlers, one event type.
      //
      // opportunityContactWriter owns OPPORTUNITIES_CONTACTS_ASSOCIATION and
      // returns early for anything else — which meant every
      // TASK_OPPORTUNITY / NOTE_OPPORTUNITY relation was silently dropped.
      // Both run: each ignores what is not its own association, so ordering
      // does not matter and neither can swallow the other's events.
      // THREE writers, each ignoring what is not its own pair. The
      // business one is new: GHL fires no ContactUpdate for a business-link
      // change, only these relation events — so without it an "Add
      // business" on a deal was accepted by GHL, never recorded locally, and
      // vanished on the next refetch. See businessContactRelationWriter.js.
      if (eventType === 'RelationCreate') {
        await handleRelationCreate(install, event);
        await handleBusinessContactRelationCreate(install, event);
        if (HANDLED_ASSOCIATIONS.has(event.associationId)) {
          await handleTaskNoteRelationCreate(install, event);
        }
      } else if (eventType === 'RelationDelete') {
        await handleRelationDelete(install, event);
        await handleBusinessContactRelationDelete(install, event);
        if (HANDLED_ASSOCIATIONS.has(event.associationId)) {
          await handleTaskNoteRelationDelete(install, event);
        }
      }
      await markProcessed(eventId, 'success', null);
      logger.info({ locationId, eventType, eventId }, 'webhook: relation event applied');
      return res.json({ ok: true });
    } catch (err) {
      await markProcessed(eventId, 'failed', err?.message);
      logger.error({ err, locationId, eventType, eventId }, 'webhook: relation writer failed');
      return res.json({ ok: false, error: 'writer_failed' });
    }
  }

  // Unreachable — the guard at the top of the per-record section catches
  // every unhandled type. Kept as a defensive log so any dispatcher regression
  // is visible instead of silently returning 200 with no work done.
  logger.warn({ eventType, eventId, locationId }, 'webhook: no dispatcher matched (unreachable)');
  return res.json({ ok: true, dropped: 'no_dispatcher' });
});
