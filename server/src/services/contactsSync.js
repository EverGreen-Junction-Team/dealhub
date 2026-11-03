// contactsSync.js — daily reconciliation sweep for contacts.
//
// Catches dropped ContactCreate / ContactUpdate / ContactDelete webhooks.
// Uses sweep_cursors.object_type = 'contacts' to remember the last safely
// reconciled point. Runs from the same daily cron as messagesSync.
//
// Approach: paginate GET /contacts/ ordered by dateUpdated ASC. Dispatch
// each contact through handleContactUpsert (same code path as live webhooks
// — populates every promoted column via ghl_custom_field_definitions).

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { handleContactUpsert } from './contactWriter.js';
import { getCursor, computeWindow, advanceCursor } from './sweepCursors.js';
import { recordSyncRun } from './syncRunLog.js';
import { logger } from '../utils/logger.js';

const OBJECT_TYPE = 'contacts';
const PAGE_SIZE = 100;
const MAX_PAGES = 500;   // 50 000 contacts per sweep — well above realistic delta

export async function syncContactsForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();

  const cursor = await getCursor(locationId, OBJECT_TYPE);
  const { windowStart, windowEnd } = computeWindow(cursor, startedAt);

  let upserted = 0;
  let startAfterId = null;
  let startAfter = null;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        locationId,
        limit: String(PAGE_SIZE)
      });
      if (startAfterId) params.set('startAfterId', startAfterId);
      if (startAfter)   params.set('startAfter', String(startAfter));

      let data;
      try {
        const resp = await ghlRequest(install, {
          method: 'GET',
          url: `/contacts/?${params.toString()}`
        });
        data = resp.data;
      } catch (err) {
        logger.warn(
          { locationId, page, err, status: err.response?.status },
          'contactsSync: page fetch failed — stopping'
        );
        break;
      }

      const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
      if (contacts.length === 0) break;

      let hitCursor = false;
      for (const raw of contacts) {
        const updated = raw.dateUpdated || raw.dateAdded;
        const ts = updated ? new Date(updated) : null;
        // Skip anything OLDER than the window (already covered by previous
        // sweeps). We rely on GHL ordering by dateAdded ASC.
        if (ts && ts < windowStart) continue;
        try {
          await handleContactUpsert(install, { contact: raw }, { fromBackfill: false });
          upserted++;
        } catch (err) {
          logger.warn(
            { locationId, contactId: raw?.id, err },
            'contactsSync: contact upsert failed — skipped'
          );
        }
      }

      const last = contacts[contacts.length - 1];
      startAfterId = last?.id || null;
      startAfter   = last?.dateAdded ? new Date(last.dateAdded).getTime() : null;
      if (contacts.length < PAGE_SIZE) break;
      if (hitCursor) break;
    }

    await advanceCursor(locationId, OBJECT_TYPE, windowEnd);

    logger.info({ locationId, upserted, windowStart, windowEnd }, 'contactsSync: location synced');
    await recordSyncRun({
      jobName: 'contactsSync', objectType: OBJECT_TYPE,
      locationId, scope: 'location', status: 'success',
      startedAt, finishedAt: new Date(),
      windowStart, windowEnd,
      stats: { upserted }
    });
    return { upserted };
  } catch (err) {
    logger.error({ locationId, err }, 'contactsSync: location failed');
    await recordSyncRun({
      jobName: 'contactsSync', objectType: OBJECT_TYPE,
      locationId, scope: 'location', status: 'failed',
      startedAt, finishedAt: new Date(),
      windowStart, windowEnd,
      stats: { upserted }, error: err.message
    });
    return { upserted, error: err.message };
  }
}

export async function syncContactsForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('contactsSync: no active installs — skipping');
    return { locations: 0 };
  }

  let totalUpserted = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { upserted, error } = await syncContactsForLocation(install);
    totalUpserted += upserted || 0;
    if (error) locationsFailed++;
  }

  logger.info(
    { locations: rows.length, totalUpserted, locationsFailed },
    'contactsSync: complete'
  );
  await recordSyncRun({
    jobName: 'contactsSync', objectType: OBJECT_TYPE,
    scope: 'all',
    status: locationsFailed === 0 ? 'success' : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt, finishedAt: new Date(),
    stats: { locations: rows.length, totalUpserted, locationsFailed }
  });
  return { locations: rows.length, totalUpserted };
}
