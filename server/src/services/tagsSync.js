// tagsSync.js — daily catalogue sync for the `tags` reference table.
//
// Fires once a day from the same cron that runs the orphan sweep. For every
// active install, calls GET /locations/{locationId}/tags and UPSERTs each
// tag into the `tags` table. Keeps the catalogue in sync with GHL even for
// tags that haven't been applied to any record yet.
//
// Idempotent: re-running is safe. Renames in GHL are propagated by the
// UPSERT (name column overwritten). tag_history rows keep their own snapshot
// of the name at application time, so historical interpretation stays sound
// after a rename.

import { rawQuery } from '../db.js';
import { getActiveInstall } from './ghlClient.js';
import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';

// Namespace is the text before the first ':' in the tag name. Used for
// analytics grouping (e.g. all 'quote:*' tags share namespace='quote').
function extractNamespace(name) {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf(':');
  if (idx <= 0) return null; // 'foo' → no namespace; ':foo' → no namespace
  return name.slice(0, idx);
}

async function upsertTag(locationId, tag) {
  const name = tag?.name || null;
  const tagId = tag?.id || tag?.tagId;
  if (!tagId || !name) return false;
  const namespace = extractNamespace(name);
  await rawQuery(
    `INSERT INTO tags (location_id, tag_id, name, namespace, last_synced_at, imported_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now(), now())
     ON CONFLICT (location_id, tag_id) DO UPDATE SET
       name           = EXCLUDED.name,
       namespace      = EXCLUDED.namespace,
       last_synced_at = now(),
       updated_at     = now()`,
    [locationId, tagId, name, namespace]
  );
  return true;
}

// Sync one location. GHL's Get Location Tags endpoint returns the full list
// in a single response (no pagination surface documented for it as of Jul 26).
export async function syncTagsForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/locations/${encodeURIComponent(locationId)}/tags`
    });
    const tags = Array.isArray(data?.tags) ? data.tags : (Array.isArray(data) ? data : []);
    let synced = 0;
    for (const t of tags) {
      const wrote = await upsertTag(locationId, t);
      if (wrote) synced++;
    }
    logger.info({ locationId, synced, totalReturned: tags.length }, 'tagsSync: location synced');
    await recordSyncRun({
      jobName: 'tagsSync', objectType: 'tags',
      locationId, scope: 'location', status: 'success',
      startedAt, stats: { synced, totalReturned: tags.length }
    });
    return { synced };
  } catch (err) {
    logger.warn({ err, locationId, status: err.response?.status }, 'tagsSync: location failed');
    await recordSyncRun({
      jobName: 'tagsSync', objectType: 'tags',
      locationId, scope: 'location', status: 'failed',
      startedAt, error: err.message
    });
    return { synced: 0, error: err.message };
  }
}

// Sync every active install. Called from the daily cron. Failures on one
// location don't stop the others.
export async function syncTagsForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('tagsSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'tagsSync', objectType: 'tags',
      scope: 'all', status: 'success', startedAt,
      stats: { locations: 0, tagsSynced: 0 }
    });
    return { locations: 0, tagsSynced: 0 };
  }

  let totalTags = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { synced, error } = await syncTagsForLocation(install);
    totalTags += synced;
    if (error) locationsFailed++;
  }
  logger.info(
    { locations: rows.length, tagsSynced: totalTags, locationsFailed, durationMs: Date.now() - startedAt.getTime() },
    'tagsSync: complete'
  );
  await recordSyncRun({
    jobName: 'tagsSync', objectType: 'tags',
    scope: 'all',
    status: locationsFailed === 0 ? 'success' : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt,
    stats: { locations: rows.length, tagsSynced: totalTags, locationsFailed }
  });
  return { locations: rows.length, tagsSynced: totalTags };
}
