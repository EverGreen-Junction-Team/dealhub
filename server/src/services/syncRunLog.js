// syncRunLog.js — best-effort persistent audit log for cron/sync jobs.
//
// Column names match James's CSV blueprint (migration 032):
//   run_type      (was job_name)
//   counts        (was stats)
//   window_start  (new — for windowed reconciliation sweeps)
//   window_end    (new)
//   run_uuid      (external audit ID — messages.sync_run_id references this)
//
// Returns the run_uuid on success so callers can stamp it on rows they write
// during this run (e.g. messages.sync_run_id).
//
// Never throws — the audit write must not break the sync itself.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

export async function recordSyncRun({
  jobName,               // 'tagsSync' | 'customFieldsSync' | 'messagesSync' | ...
  objectType,            // 'tags' | 'messages' | 'contacts' | ...
  locationId = null,
  scope,                 // 'all' | 'location'
  status,                // 'success' | 'failed' | 'partial'
  startedAt,
  finishedAt = new Date(),
  windowStart = null,    // for cursor-based sweeps
  windowEnd = null,
  stats = null,          // JSONB — arbitrary counts per run
  error = null
}) {
  try {
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const { rows } = await rawQuery(
      `INSERT INTO sync_runs
         (run_type, object_type, location_id, scope, status,
          started_at, finished_at, duration_ms,
          window_start, window_end,
          counts, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING run_uuid`,
      [
        jobName, objectType, locationId, scope, status,
        startedAt, finishedAt, durationMs,
        windowStart, windowEnd,
        stats ? stats : null,
        error ? String(error).slice(0, 2000) : null
      ]
    );
    return rows[0]?.run_uuid || null;
  } catch (err) {
    logger.warn(
      { err, jobName, objectType, locationId },
      'syncRunLog: failed to record run'
    );
    return null;
  }
}

// Housekeeping — purge sync_runs older than 30 days.
export async function purgeOldSyncRuns() {
  const { rowCount } = await rawQuery(
    `DELETE FROM sync_runs WHERE created_at < now() - interval '30 days'`
  );
  return { deleted: rowCount };
}
