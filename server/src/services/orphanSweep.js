import cron from 'node-cron';
import { rawQuery } from '../db.js';
import { getActiveInstall } from './ghlClient.js';
import { sweepExpiredDealLinks } from './pendingDealLink.js';
import { emitOrphanRow } from './stageHistoryWriter.js';
import { syncTagsForAllInstalls } from './tagsSync.js';
import { syncCustomFieldsForAllInstalls } from './customFieldsSync.js';
import { syncBusinessesForAllInstalls } from './businessesSync.js';
import { syncPipelinesForAllInstalls } from './pipelinesSync.js';
import { syncUsersForAllInstalls } from './usersSync.js';
import { syncMessagesForAllInstalls } from './messagesSync.js';
import { syncContactsForAllInstalls } from './contactsSync.js';
import { syncOpportunitiesForAllInstalls } from './opportunitiesSync.js';
import { syncConversationProvidersAllInstalls } from './conversationProvidersSync.js';
import { syncCallMediaForAllInstalls } from './callRecordingSync.js';
import { syncAllTasks } from './tasksSync.js';
import { recordSyncRun, purgeOldSyncRuns } from './syncRunLog.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Housekeeping — purge processed_events older than 14 days. The
// processed_events table is our webhook idempotency log; rows past that age
// have no chance of being relevant to in-flight retries. Without this the
// table grows unbounded.
export async function purgeOldProcessedEvents() {
  const startedAt = new Date();
  try {
    const { rowCount } = await rawQuery(
      `DELETE FROM processed_events WHERE processed_at < now() - interval '14 days'`
    );
    if (rowCount > 0) {
      logger.info({ deleted: rowCount }, 'cleanup.processedEvents: rows purged');
    } else {
      logger.debug('cleanup.processedEvents: nothing to purge');
    }
    await recordSyncRun({
      jobName: 'purgeProcessedEvents', objectType: 'processed_events',
      scope: 'all', status: 'success', startedAt,
      stats: { deleted: rowCount }
    });
    return { deleted: rowCount };
  } catch (err) {
    await recordSyncRun({
      jobName: 'purgeProcessedEvents', objectType: 'processed_events',
      scope: 'all', status: 'failed', startedAt, error: err.message
    });
    throw err;
  }
}

// Housekeeping — purge ghl_raw older than 30 days. This is the forensic
// webhook archive; useful for debugging new event types and audit trails,
// but not needed for business logic. Retention is intentionally short —
// a rolling 30-day window is enough context for any incident review.
export async function purgeOldGhlRaw() {
  const startedAt = new Date();
  try {
    const { rowCount } = await rawQuery(
      `DELETE FROM ghl_raw WHERE received_at < now() - interval '30 days'`
    );
    if (rowCount > 0) {
      logger.info({ deleted: rowCount }, 'cleanup.ghlRaw: rows purged');
    } else {
      logger.debug('cleanup.ghlRaw: nothing to purge');
    }
    await recordSyncRun({
      jobName: 'purgeGhlRaw', objectType: 'ghl_raw',
      scope: 'all', status: 'success', startedAt,
      stats: { deleted: rowCount }
    });
    return { deleted: rowCount };
  } catch (err) {
    await recordSyncRun({
      jobName: 'purgeGhlRaw', objectType: 'ghl_raw',
      scope: 'all', status: 'failed', startedAt, error: err.message
    });
    throw err;
  }
}

// Housekeeping — purge sync_runs older than 30 days.
export async function purgeOldSyncRunsWithLog() {
  const startedAt = new Date();
  try {
    const { deleted } = await purgeOldSyncRuns();
    if (deleted > 0) {
      logger.info({ deleted }, 'cleanup.syncRuns: rows purged');
    }
    await recordSyncRun({
      jobName: 'purgeSyncRuns', objectType: 'sync_runs',
      scope: 'all', status: 'success', startedAt,
      stats: { deleted }
    });
    return { deleted };
  } catch (err) {
    await recordSyncRun({
      jobName: 'purgeSyncRuns', objectType: 'sync_runs',
      scope: 'all', status: 'failed', startedAt, error: err.message
    });
    throw err;
  }
}

// Daily sweep per STAGE_HISTORY_WEBHOOK_PLAN Section 2.2.
//
// Anything still sitting in pending_opportunities means: GHL fired
// opportunity_created for it, but no subsequent stage_updated has ever
// come. The opportunity has been "stuck at creation" for more than the
// sweep interval (default: 24 hours).
//
// We emit ONE synthetic stage_history row for it (so it shows up in
// reports), then remove from the queue. Each orphan is therefore notified
// at most once.

export async function runOrphanSweep() {
  const startedAt = new Date();
  const started = startedAt.getTime();
  // Pull all pending rows whose sweep_after has passed — gives honest
  // "stage_updated arrived right after created" cases a grace window
  // (default 10 min, set at enqueue time) to drain naturally before we
  // synthesize a row.
  const { rows } = await rawQuery(
    `SELECT location_id, opportunity_id, contact_id, pipeline_id, observed_stage_id AS pipeline_stage_id, created_at_ghl
       FROM pending_opportunities
      WHERE sweep_after <= now()
      ORDER BY created_event_at ASC
      LIMIT 1000`
  );

  if (rows.length === 0) {
    logger.info('orphanSweep: nothing pending');
    await recordSyncRun({
      jobName: 'orphanSweep', objectType: 'pending_opportunities',
      scope: 'all', status: 'success', startedAt,
      stats: { processed: 0, pending: 0 }
    });
    return { processed: 0 };
  }

  // Group by location so we resolve the install + access token once per
  // tenant. Tens of thousands of orphans on one install share one fetch.
  const byLocation = new Map();
  for (const row of rows) {
    if (!byLocation.has(row.location_id)) byLocation.set(row.location_id, []);
    byLocation.get(row.location_id).push(row);
  }

  let processed = 0;
  let failed = 0;
  for (const [locationId, pendings] of byLocation) {
    const install = await getActiveInstall(locationId);
    if (!install) {
      // Install was removed — drop the orphans, no one to write for.
      await rawQuery(
        `DELETE FROM pending_opportunities WHERE location_id = $1`,
        [locationId]
      );
      logger.info({ locationId, count: pendings.length }, 'orphanSweep: install missing — orphans dropped');
      continue;
    }
    for (const pending of pendings) {
      try {
        await emitOrphanRow(install, pending);
        processed++;
      } catch (err) {
        failed++;
        // Log + leave the row in the queue — next sweep retries.
        logger.error({ err, locationId, opportunityId: pending.opportunity_id }, 'orphanSweep: row failed');
      }
    }
  }
  logger.info({ processed, failed, durationMs: Date.now() - started }, 'orphanSweep: complete');
  await recordSyncRun({
    jobName: 'orphanSweep', objectType: 'pending_opportunities',
    scope: 'all',
    status: failed === 0 ? 'success' : (processed === 0 ? 'failed' : 'partial'),
    startedAt,
    stats: { processed, failed, pending: rows.length }
  });
  return { processed };
}

// Start the cron. Schedule defaults to "0 3 * * *" — 03:00 server time daily.
// We use a wide jitter inside the handler (process pending_opportunities in
// FIFO order) rather than splaying across multiple ticks; load is tiny.
export function startOrphanSweepCron() {
  if (!cron.validate(config.orphanSweepCron)) {
    logger.error({ cron: config.orphanSweepCron }, 'orphanSweep: invalid cron expression — sweep disabled');
    return;
  }
  cron.schedule(config.orphanSweepCron, async () => {
    // Orphan-stage emit + processed_events purge share the same daily slot.
    // Either failing logs loud; neither stops the other.
    try { await runOrphanSweep(); }
    catch (err) { logger.error({ err }, 'orphanSweep: scheduled run failed'); }
    try { await purgeOldProcessedEvents(); }
    catch (err) { logger.error({ err }, 'cleanup.processedEvents: scheduled run failed'); }
    try { await purgeOldGhlRaw(); }
    catch (err) { logger.error({ err }, 'cleanup.ghlRaw: scheduled run failed'); }
    try { await syncTagsForAllInstalls(); }
    catch (err) { logger.error({ err }, 'tagsSync: scheduled run failed'); }
    try { await syncCustomFieldsForAllInstalls(); }
    catch (err) { logger.error({ err }, 'customFieldsSync: scheduled run failed'); }
    try { await syncPipelinesForAllInstalls(); }
    catch (err) { logger.error({ err }, 'pipelinesSync: scheduled run failed'); }
    // Before the object syncs: opportunities, tasks and notes all resolve an
    // owner name against `users`, and user_type decides who counts as a rep.
    // Refreshing users first means a rep added today is named on the same run
    // rather than the next one.
    try { await syncUsersForAllInstalls(); }
    catch (err) { logger.error({ err }, 'usersSync: scheduled run failed'); }
    // Before contactsSync: contacts carry business_id, so pulling businesses
    // first means the join resolves on the same run rather than the next one.
    try { await syncBusinessesForAllInstalls(); }
    catch (err) { logger.error({ err }, 'businessesSync: scheduled run failed'); }
    try { await syncContactsForAllInstalls(); }
    catch (err) { logger.error({ err }, 'contactsSync: scheduled run failed'); }
    try { await syncOpportunitiesForAllInstalls(); }
    catch (err) { logger.error({ err }, 'opportunitiesSync: scheduled run failed'); }
    // After opportunitiesSync: a task is attributed to a deal, so the deals
    // have to be current or the attribution falls back to "no open deal".
    //
    // This was MISSING from the daily cron entirely — every other sync was
    // here, tasksSync never was, so it only ever ran when someone invoked it
    // by hand (5 times, last on 2026-09-02). Task webhooks kept the data
    // current, so nothing was visibly broken; what was missing is the
    // reconciliation sweep that catches anything the webhooks dropped.
    try { await syncAllTasks(); }
    catch (err) { logger.error({ err }, 'tasksSync: scheduled run failed'); }

    // Create-time deal picks whose webhook never arrived (migration 069).
    // Normally consumed within a second; anything still here an hour later
    // belongs to a create whose webhook was dropped, and must not linger to
    // attach itself to a later record that reuses the id.
    try { await sweepExpiredDealLinks(); }
    catch (err) { logger.error({ err }, 'pendingDealLink: scheduled sweep failed'); }
    // messagesSync DISABLED — removed from the daily cron at the client's
    // request (2026-09-11). Messages now arrive by webhook only, and message
    // attribution is a write-once decision made when the message lands.
    //
    // WHAT THIS GIVES UP. This sweep was Layer 3 of the message capture
    // strategy: the reconciliation pass that caught messages GHL's webhooks
    // never delivered. That is not hypothetical — docs/MESSAGE-SYNC-REDESIGN.md
    // records two confirmed cases (Danilo Bardella 16 Jul, Yusuf Lala 10 Jul)
    // where real customer emails existed in GHL and never reached us. With
    // this off, a dropped webhook is a permanently missing message and
    // nothing will report it.
    //
    // Re-enable by uncommenting the two lines below and running
    // `pm2 restart app`. The service, its cursors and its sync_runs logging
    // are all left intact so it resumes where it left off.
    // try { await syncMessagesForAllInstalls(); }
    // catch (err) { logger.error({ err }, 'messagesSync: scheduled run failed'); }
    // conversationProvidersSync DISABLED — client asked to stop it (2026-09-26).
    //
    // The endpoint it can reach only returns SMS and Email senders, so the
    // sync could never see the ones this account actually uses — WhatsApp QR,
    // iMessage, SMS Android and the Call-type senders all live behind
    // /conversations/providers/search, which a marketplace app cannot call
    // (401, no scope in GHL's public map). What it DID write was rows like
    // twilio_provider that nobody wanted, and each run re-added them after
    // they were cleared.
    //
    // conversation_providers is now maintained by hand:
    //   node src/scripts/seedConversationProviders.js <location> <payload.json>
    // Those rows are stamped last_seen_via='manual' and the sync's prune
    // already skips them, so re-enabling this later will not wipe them.
    //
    // Re-enable by uncommenting the two lines below and running
    // `pm2 restart app` — worth doing if GHL ever exposes that endpoint.
    // try { await syncConversationProvidersAllInstalls(); }
    // catch (err) { logger.error({ err }, 'conversationProvidersSync: scheduled run failed'); }
    // callRecordingSync DISABLED — client asked to pause call recording /
    // transcription sync (2026-08-15). Tables call_recordings and
    // call_transcriptions remain in place from migration 047 so nothing
    // breaks if we resume. Re-enable by uncommenting the two lines below
    // and running `pm2 restart app`.
    // try { await syncCallMediaForAllInstalls(); }
    // catch (err) { logger.error({ err }, 'callRecordingSync: scheduled run failed'); }
    try { await purgeOldSyncRunsWithLog(); }
    catch (err) { logger.error({ err }, 'cleanup.syncRuns: scheduled run failed'); }
  });
  logger.info({ cron: config.orphanSweepCron }, 'daily cron scheduled (orphanSweep + processed_events purge + ghl_raw purge + tags + custom fields + pipelines + users + businesses + contacts + opportunities + tasks + conversation providers + sync_runs purge; callRecordingSync + messagesSync paused per client request)');
}
