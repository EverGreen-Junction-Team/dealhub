// tasksSync.js — daily reconciliation for the `tasks` table.
//
// WHY THIS EXISTS. GHL fires TaskCreate, TaskComplete and TaskDelete — but
// there is NO TaskUpdate event. So editing a task's title, body, due date or
// assignee in GHL reached us through nothing at all: the row kept whatever it
// had when it was created, forever. That is the bug this closes.
//
// SOURCE. Two paths, tried in order:
//
//   1. POST /locations/{id}/tasks/search — one paged sweep for the whole
//      sub-account. Needs `locations/tasks.readonly`.
//
//      This comment used to say the app does not hold that scope, because
//      every location 401'd on it in production. Probing the live token
//      disproved it: `locations/tasks.readonly` IS granted, and the search
//      call works. Whatever caused those 401s, it was not this scope.
//
//      Worth knowing: the search response does NOT include a task's
//      `relations`, so it cannot tell us which deals a task is linked to.
//      Only GET /locations/{id}/tasks/{taskId} returns those — see
//      scripts/backfillTaskRelations.js.
//
//   2. GET /contacts/{id}/tasks per contact — covered by `contacts.readonly`,
//      which we already hold. One call per contact that has tasks, so it is
//      slower, but it works today with no scope change and no reauthorisation.
//
// The search path is tried first and falls back automatically, so adding the
// scope later needs no code change — the next run simply uses the fast path.
//
// The fallback only asks about contacts we ALREADY have a task for, read from
// our own table. What that catches and misses:
//
//   ✓ every edit to a task we have seen                     (the reported bug)
//   ✓ tasks added in GHL to a contact that already has one  (same call)
//   ✗ a task on a contact with no tasks in our table at all
//
// That last gap is covered by TaskCreate, which does fire. Only a dropped
// create webhook can hide a task entirely — and the search path, once scoped,
// closes even that.
//
// Deletes are reconciled: a task that no longer comes back from GHL is
// soft-deleted, matching what the TaskDelete webhook does. Guarded so a failed
// or truncated sweep can never be read as "GHL has no tasks" — see
// shouldReconcileDeletes, shared with businessesSync for exactly this reason.
//
// Idempotent: re-running changes nothing on the second pass, and the UPDATE
// carries a WHERE so unchanged rows are not rewritten.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { ensureContactExists } from './contactStub.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';
import { shouldReconcileDeletes } from './businessesReconcile.js';

const PAGE_SIZE = 100;

// Fallback-path limits. A ceiling on calls per run so a location with a large
// contact base cannot turn the nightly job into an hours-long crawl, and a
// small pause between calls because GHL rate-limits per location.
const MAX_CONTACTS_PER_RUN = 1500;
const THROTTLE_MS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guard against an unbounded loop if the endpoint ever ignores paging and keeps
// returning a full page. 500 pages is 50k tasks, far beyond any real
// sub-account.
const MAX_PAGES = 500;

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One page of the location's tasks.
 *
 * Their search endpoints vary in what they call the collection and how they
 * page, so both common shapes are accepted rather than assuming one.
 */
async function fetchTaskPage(install, locationId, skip) {
  const { data } = await ghlRequest(install, {
    method: 'POST',
    url: `/locations/${encodeURIComponent(locationId)}/tasks/search`,
    data: { limit: PAGE_SIZE, skip },
    // Needs locations/tasks.readonly. Without it a 401 here must NOT mark the
    // install reauth_required — doing so halted callRecordingSync and
    // conversationProvidersSync across every location the first time this ran.
    scopeOptional: true
  });
  const rows = data?.tasks || data?.data || [];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Contacts we already hold at least one live task for.
 *
 * Ordered by most recent task activity, so if the cap truncates the list what
 * gets dropped is the least likely to have changed.
 */
async function contactsWithTasks(locationId) {
  const { rows } = await rawQuery(
    `SELECT contact_id,
            max(COALESCE(updated_at_ghl, created_at_ghl, imported_at)) AS last_seen
       FROM tasks
      WHERE location_id = $1
        AND contact_id IS NOT NULL
        AND deleted_at IS NULL
      GROUP BY contact_id
      ORDER BY last_seen DESC NULLS LAST
      LIMIT $2`,
    [locationId, MAX_CONTACTS_PER_RUN]
  );
  return rows.map((r) => r.contact_id);
}

/**
 * The fallback sweep. Returns the same shape as the search path so the caller
 * treats them identically — including `truncated`, which gates delete
 * reconciliation.
 */
async function fetchTasksPerContact(install, locationId) {
  const contactIds = await contactsWithTasks(locationId);
  const tasks = [];
  const failedContacts = new Set();
  let failed = 0;

  for (const contactId of contactIds) {
    try {
      const { data } = await ghlRequest(install, {
        method: 'GET',
        url: `/contacts/${encodeURIComponent(contactId)}/tasks`
      });
      const rows = Array.isArray(data?.tasks) ? data.tasks : [];
      // The per-contact endpoint omits contactId on the task body; the caller
      // needs it, and we know it from the request.
      for (const t of rows) tasks.push({ contactId, ...t });
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        // Contact gone in GHL. contactsSync owns that; leave its tasks alone —
        // and exclude it from the covered set so they are not deleted here.
        failedContacts.add(contactId);
        continue;
      }
      failed++;
      failedContacts.add(contactId);
      logger.warn(
        { locationId, contactId, status, err },
        'tasksSync: contact task fetch failed'
      );
    }
    await sleep(THROTTLE_MS);
  }

  // A partial sweep must never reconcile deletes — a contact we failed to reach
  // would look like "GHL has no tasks for them".
  return {
    tasks,
    // Only the contacts we actually reached — a failed fetch must not put a
    // contact in the "covered" set, or its tasks would be deleted.
    contactIds: contactIds.filter((id) => !failedContacts.has(id)),
    truncated: failed > 0 || contactIds.length >= MAX_CONTACTS_PER_RUN
  };
}

/**
 * Write one task from GHL's shape.
 *
 * Deliberately mirrors taskWriter's INSERT rather than sharing it: the webhook
 * path also runs opportunity attribution, which needs the event context.
 *
 * opportunity_id is NOT in the column list at all, so a nightly sweep can never
 * unlink a task from the deal the attribution engine assigned it.
 */
async function upsertTask(locationId, t) {
  const taskId = t.id || t._id;
  if (!taskId) return false;

  // FK safety, exactly as taskWriter does on the webhook path.
  //
  // tasks.contact_id references contacts, and the location-wide search returns
  // tasks for contacts we may not have synced yet — a lead created in GHL
  // moments ago, or one contactsSync hasn't reached. Without this the row is
  // rejected by the FK and the task is silently skipped, which is what the two
  // production failures were.
  //
  // Stubs the contact if needed; contactsSync fills in the real fields later.
  if (t.contactId) {
    await ensureContactExists(locationId, t.contactId);
  }

  const { rowCount } = await rawQuery(
    `INSERT INTO tasks (
       location_id, task_id, contact_id,
       assigned_to, title, body, status, due_at,
       completed_at, raw_task, from_backfill,
       created_at_ghl, updated_at_ghl, imported_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12, now(), now()
     )
     ON CONFLICT (location_id, task_id) DO UPDATE SET
       contact_id   = COALESCE(EXCLUDED.contact_id, tasks.contact_id),
       assigned_to  = EXCLUDED.assigned_to,
       -- Assigned outright, not COALESCEd: this is the whole point of the sync.
       -- An edit in GHL that CLEARED a body must clear it here, and COALESCE
       -- would make every field write-once.
       title        = EXCLUDED.title,
       body         = EXCLUDED.body,
       due_at       = EXCLUDED.due_at,
       status       = EXCLUDED.status,
       completed_at = EXCLUDED.completed_at,
       raw_task     = EXCLUDED.raw_task,
       updated_at_ghl = COALESCE(EXCLUDED.updated_at_ghl, tasks.updated_at_ghl),
       updated_at   = now(),
       -- A task that reappears in GHL after being soft-deleted comes back.
       deleted_at   = NULL
     WHERE
       -- Skip the write when nothing changed. Without this every run rewrites
       -- every row and bumps updated_at, which makes "what changed last night"
       -- unanswerable from the table.
       tasks.title       IS DISTINCT FROM EXCLUDED.title
       OR tasks.body     IS DISTINCT FROM EXCLUDED.body
       OR tasks.due_at   IS DISTINCT FROM EXCLUDED.due_at
       OR tasks.status   IS DISTINCT FROM EXCLUDED.status
       OR tasks.assigned_to IS DISTINCT FROM EXCLUDED.assigned_to
       OR tasks.deleted_at IS NOT NULL`,
    [
      locationId, taskId, t.contactId || null,
      t.assignedTo || null,
      t.title || null,
      t.body || null,
      t.completed === true ? 'completed' : 'open',
      toTimestamp(t.dueDate),
      t.completed === true ? (toTimestamp(t.dateUpdated) || new Date()) : null,
      t,
      toTimestamp(t.dateAdded),
      toTimestamp(t.dateUpdated)
    ]
  );
  // rowCount 0 means the WHERE skipped it — unchanged, not failed.
  return rowCount > 0;
}

/**
 * Soft-delete tasks GHL no longer has.
 *
 * NEVER runs on a failed or truncated sweep. `NOT (task_id = ANY('{}'))`
 * matches EVERY row, so one bad response would blank the whole task list while
 * reporting success — the same trap businessesSync hit, which is why that
 * guard is shared rather than reimplemented.
 */
async function reconcileDeletes(locationId, seenIds, { truncated, contactIds = null }) {
  // Returns { reconcile, reason } — NOT a boolean. Treating it as one would
  // make `if (!result)` always false and the guard would never fire, which is
  // the exact failure it exists to prevent.
  const verdict = shouldReconcileDeletes({ seenCount: seenIds.length, truncated });
  if (!verdict.reconcile) {
    logger.warn(
      { locationId, seenCount: seenIds.length, truncated, reason: verdict.reason },
      'tasksSync: skipping delete reconciliation'
    );
    return 0;
  }
  // SCOPE MATTERS. The search path sees the whole location, so "not in the
  // list" means deleted. The per-contact path only ever asked about contacts we
  // already held a task for — a location-wide delete against ITS list would
  // soft-delete every task on every contact we never queried.
  //
  // So the fallback passes the contacts it actually covered, and the delete is
  // confined to those.
  const scoped = Array.isArray(contactIds);
  if (scoped && contactIds.length === 0) return 0;

  const { rowCount } = await rawQuery(
    scoped
      ? `UPDATE tasks
            SET status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE location_id = $1
            AND deleted_at IS NULL
            AND contact_id = ANY($3::text[])
            AND NOT (task_id = ANY($2::text[]))`
      : `UPDATE tasks
            SET status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE location_id = $1
            AND deleted_at IS NULL
            AND NOT (task_id = ANY($2::text[]))`,
    scoped ? [locationId, seenIds, contactIds] : [locationId, seenIds]
  );
  return rowCount || 0;
}

/**
 * Sync one location.
 */
export async function syncTasksForLocation(locationId) {
  const install = await getActiveInstall(locationId);
  if (!install) {
    logger.warn({ locationId }, 'tasksSync: no active install — skipping');
    return { seen: 0, changed: 0, deleted: 0, truncated: false };
  }

  const seenIds = [];
  let changed = 0;
  let truncated = false;
  let source = 'search';
  // null = the whole location was swept (search path). An array = only these
  // contacts were covered, and deletes must be confined to them.
  let coveredContacts = null;

  // Collect first, write second — so a fetch failure partway through cannot
  // leave `truncated` unset while seenIds looks complete.
  let all = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const tasks = await fetchTaskPage(install, locationId, page * PAGE_SIZE);
      if (tasks.length === 0) break;
      all.push(...tasks);
      if (tasks.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  } catch (err) {
    if (err.code !== 'GHL_SCOPE_MISSING') throw err;
    // The search endpoint needs a scope we don't hold. Fall back to the
    // per-contact sweep, which contacts.readonly already covers.
    logger.info(
      { locationId },
      'tasksSync: search endpoint unavailable — falling back to per-contact fetch '
      + '(add the locations/tasks.readonly scope to use the faster path)'
    );
    source = 'per-contact';
    const fallback = await fetchTasksPerContact(install, locationId);
    all = fallback.tasks;
    truncated = fallback.truncated;
    coveredContacts = fallback.contactIds;
  }

  for (const t of all) {
    const id = t.id || t._id;
    if (!id) continue;
    seenIds.push(id);
    try {
      if (await upsertTask(locationId, t)) changed++;
    } catch (err) {
      // Postgres errors carry nothing useful on .message — the diagnosis is in
      // code/detail/constraint. Logging only .message produced `{"type":"Error"}`
      // in production, which said a task failed but not why.
      logger.warn(
        {
          locationId, taskId: id, contactId: t.contactId || null,
          err,
          pgCode: err.code || null,
          detail: err.detail || null,
          constraint: err.constraint || null,
          column: err.column || null
        },
        'tasksSync: upsert failed'
      );
    }
  }

  const deleted = await reconcileDeletes(locationId, seenIds, {
    truncated, contactIds: coveredContacts
  });

  const stats = { source, seen: seenIds.length, changed, deleted, truncated };
  logger.info({ locationId, ...stats }, 'tasksSync: location synced');
  return stats;
}

/**
 * Every active install. Entry point for the nightly cron.
 */
export async function syncAllTasks() {
  const startedAt = new Date();
  // uninstalled_at IS NULL, matching businessesSync — there is no `status`
  // column on installs.
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );

  if (rows.length === 0) {
    logger.info('tasksSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'tasksSync', objectType: 'tasks', scope: 'all',
      status: 'success', startedAt, stats: { locations: 0 }
    });
    return;
  }

  let locations = 0;
  let changed = 0;
  let deleted = 0;
  let failed = 0;

  for (const { location_id: locationId } of rows) {
    try {
      const s = await syncTasksForLocation(locationId);
      locations++;
      changed += s.changed;
      deleted += s.deleted;
    } catch (err) {
      failed++;
      logger.error(
        { err, status: err.response?.status, locationId },
        'tasksSync: location failed'
      );
    }
  }

  await recordSyncRun({
    jobName: 'tasksSync', objectType: 'tasks', scope: 'all',
    status: failed > 0 ? 'partial' : 'success',
    startedAt,
    stats: { locations, changed, deleted, failed }
  });
}
