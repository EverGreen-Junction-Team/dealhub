// usersSync.js — the daily users refresh.
//
// WHY THIS EXISTS.
// Users reached the database by exactly two routes, and neither keeps
// `user_type` current on its own:
//
//   * UserCreate/Update webhooks. These do not carry `roles`, so userWriter
//     fetches the full record to learn whether someone is agency or account.
//     That covers users who CHANGE, not users who were already there.
//   * backfillUsers, a one-off script someone has to remember to run.
//
// Migration 133 backfilled user_type from the raw payloads already stored,
// but a payload captured before the writer read `roles` holds nothing to
// read. Those rows stay NULL — and NULL shows in the owner dropdown, which
// is where an agency user would quietly reappear.
//
// A nightly pass closes that: it re-reads every user from GHL, where `roles`
// is always present, and upserts through the same path the webhook uses.
//
// WHY NOT JUST RE-RUN THE BACKFILL SCRIPT. Same work, but a script is a thing
// someone remembers; the cron is a thing that happens. Everything else the
// daily job touches — tags, pipelines, contacts, opportunities — is here for
// the same reason.

import { rawQuery } from '../db.js';
import { getActiveInstall } from './ghlClient.js';
import { backfillUsersForLocation } from './userWriter.js';
import { recordSyncRun } from './syncRunLog.js';
import { logger } from '../utils/logger.js';

export async function syncUsersForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );

  if (rows.length === 0) {
    logger.info('usersSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'usersSync', objectType: 'users',
      scope: 'all', status: 'success', startedAt,
      stats: { locations: 0, totalUsers: 0 }
    });
    return { locations: 0, totalUsers: 0 };
  }

  let totalUsers = 0;
  let locationsFailed = 0;

  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    try {
      const { count } = await backfillUsersForLocation(install);
      totalUsers += count || 0;
    } catch (err) {
      // One location's failure must not stop the rest. A sub-account whose
      // token has expired would otherwise block every account after it in
      // the loop — and the ones after it are usually fine.
      locationsFailed++;
      logger.warn({ err, locationId }, 'usersSync: location failed');
    }
  }

  logger.info(
    {
      locations: rows.length,
      totalUsers,
      locationsFailed,
      durationMs: Date.now() - startedAt.getTime()
    },
    'usersSync: complete'
  );

  await recordSyncRun({
    jobName: 'usersSync', objectType: 'users',
    scope: 'all',
    status: locationsFailed === rows.length ? 'failed' : 'success',
    startedAt,
    stats: { locations: rows.length, totalUsers, locationsFailed }
  });

  return { locations: rows.length, totalUsers, locationsFailed };
}
