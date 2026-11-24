#!/usr/bin/env node
//
// What would tasksSync delete, and why has it not?
//
//   npm run probe:tasksweep -- <location_id>
//
// READ-ONLY. It writes nothing to either side — not a task, not a sync_run,
// not a soft delete. It runs the same two fetch paths tasksSync runs, then
// reports what the delete pass WOULD have done.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────
//
// tasksSync recorded `deleted: 0` for ten nights running while the tasks
// table held rows GHL refuses to act on — "The task id is invalid" when a
// rep tries to edit or delete one. Those two facts cannot both be innocent:
// either the sweep is not seeing GHL's real list, or GHL's list still
// contains tasks its own write endpoints reject.
//
// Those have completely different fixes, and the recorded run could not tell
// them apart, because `deleted: 0` was the answer to both "we agree with
// GHL" and "the sweep never ran". This asks the question directly instead of
// waiting for 3am and inferring.
//
// ── THE FOUR ANSWERS IT CAN GIVE ─────────────────────────────────────
//
//   1. The search path works and returns our phantom ids.
//      → GHL's search and its by-id endpoints disagree with each other.
//        Reconciliation can never clear these; they have to be checked
//        individually (npm run probe:task) and forgotten on refusal, which
//        is what ghlTaskWrite now does on a failed write.
//
//   2. The search path works and does NOT return them.
//      → The sweep would delete them. Something was stopping the pass; the
//        reach numbers below say what.
//
//   3. The search path 401s and the fallback runs.
//      → Before the fix in tasksSync, one failed contact out of up to 1500
//        abandoned the whole location's delete pass. Check `failed` below.
//
//   4. The search path returns nothing at all.
//      → shouldReconcileDeletes refuses an empty list, correctly, and
//        nothing will ever be deleted until the fetch is fixed.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 500;
// Far below tasksSync's 1500. This is a diagnostic a person is waiting on,
// and the shape of the answer is clear long before the thousandth contact.
const PROBE_CONTACT_LIMIT = 60;
const THROTTLE_MS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(label, value) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

/** The location-wide search path, exactly as tasksSync calls it. */
async function trySearch(install, locationId) {
  const ids = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await ghlRequest(install, {
        method: 'POST',
        url: `/locations/${encodeURIComponent(locationId)}/tasks/search`,
        data: { limit: PAGE_SIZE, skip: page * PAGE_SIZE },
        scopeOptional: true
      });
      const rows = data?.tasks || data?.data || [];
      const list = Array.isArray(rows) ? rows : [];
      if (list.length === 0) {
        // An empty FIRST page is the interesting case — it means the call
        // succeeded and told us this location has no tasks at all, which is
        // the thing that silently disables the delete pass.
        if (page === 0) {
          return { ok: true, ids, emptyFirstPage: true, shape: Object.keys(data || {}) };
        }
        break;
      }
      for (const t of list) {
        const id = t.id || t._id;
        if (id) ids.push(id);
      }
      if (list.length < PAGE_SIZE) break;
    }
    return { ok: true, ids, emptyFirstPage: false };
  } catch (err) {
    return {
      ok: false,
      code: err.code || null,
      status: err.response?.status || null,
      body: err.response?.data || err.message || String(err)
    };
  }
}

/** The per-contact fallback, capped so the probe stays quick. */
async function tryPerContact(install, locationId) {
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
    [locationId, PROBE_CONTACT_LIMIT]
  );

  const ids = [];
  const covered = [];
  let failed = 0;
  let notFound = 0;

  for (const { contact_id: contactId } of rows) {
    try {
      const { data } = await ghlRequest(install, {
        method: 'GET',
        url: `/contacts/${encodeURIComponent(contactId)}/tasks`
      });
      const list = Array.isArray(data?.tasks) ? data.tasks : [];
      for (const t of list) {
        const id = t.id || t._id;
        if (id) ids.push(id);
      }
      covered.push(contactId);
    } catch (err) {
      if (err.response?.status === 404) notFound++;
      else failed++;
    }
    await sleep(THROTTLE_MS);
  }

  return { attempted: rows.length, covered, ids, failed, notFound };
}

async function main() {
  const [locationId] = process.argv.slice(2);
  if (!locationId) {
    console.log('usage: npm run probe:tasksweep -- <location_id>');
    process.exit(1);
  }

  const install = await getActiveInstall(locationId);
  if (!install) {
    console.log(`No active install for ${locationId}.`);
    process.exit(1);
  }

  const { rows: [ours] } = await rawQuery(
    `SELECT count(*)::int AS live,
            count(*) FILTER (WHERE from_backfill)::int AS backfilled
       FROM tasks
      WHERE location_id = $1 AND deleted_at IS NULL`,
    [locationId]
  );

  console.log(`\nLocation ${locationId}`);
  console.log('\nOur table');
  line('live tasks', ours.live);
  line('of those, backfilled', ours.backfilled);

  // ── Path 1 ──────────────────────────────────────────────────────────
  console.log('\nSearch path  POST /locations/:id/tasks/search');
  const search = await trySearch(install, locationId);
  let ghlIds = null;
  let scope = null;

  if (!search.ok) {
    line('result', `FAILED  ${search.code || ''} ${search.status || ''}`.trim());
    line('body', JSON.stringify(search.body).slice(0, 300));
  } else if (search.emptyFirstPage) {
    line('result', 'succeeded but returned NO tasks');
    line('response keys', JSON.stringify(search.shape));
    console.log(
      '\n  → This is answer 4. The call works and says the location has no\n'
      + '    tasks, so the empty-list guard refuses to reconcile — correctly,\n'
      + '    since an empty list would otherwise delete everything. If the\n'
      + '    response keys above are not what the reader expects, the list is\n'
      + '    being read from the wrong field.'
    );
  } else {
    line('result', `OK — ${search.ids.length} tasks`);
    ghlIds = new Set(search.ids);
    scope = 'location';
  }

  // ── Path 2 ──────────────────────────────────────────────────────────
  if (!ghlIds) {
    console.log(`\nFallback path  GET /contacts/:id/tasks  (first ${PROBE_CONTACT_LIMIT} contacts)`);
    const fb = await tryPerContact(install, locationId);
    line('contacts attempted', fb.attempted);
    line('contacts reached', fb.covered.length);
    line('contacts 404 (gone)', fb.notFound);
    line('contacts failed', fb.failed);
    line('tasks returned', fb.ids.length);
    if (fb.failed > 0) {
      console.log(
        '\n  → Before the fix, ANY non-404 failure here set truncated and\n'
        + '    abandoned the delete pass for the entire location, however many\n'
        + '    contacts answered. That is answer 3.'
      );
    }
    ghlIds = new Set(fb.ids);
    scope = fb.covered;
  }

  // ── What the delete pass would do ───────────────────────────────────
  const scoped = Array.isArray(scope);
  const { rows: candidates } = await rawQuery(
    scoped
      ? `SELECT task_id, contact_id, title, status, created_at_ghl
           FROM tasks
          WHERE location_id = $1 AND deleted_at IS NULL
            AND contact_id = ANY($2::text[])
          ORDER BY created_at_ghl DESC NULLS LAST`
      : `SELECT task_id, contact_id, title, status, created_at_ghl
           FROM tasks
          WHERE location_id = $1 AND deleted_at IS NULL
          ORDER BY created_at_ghl DESC NULLS LAST`,
    scoped ? [locationId, scope] : [locationId]
  );

  const stale = candidates.filter((r) => !ghlIds.has(r.task_id));

  console.log('\nWhat the delete pass would do');
  line('rows in delete scope', candidates.length);
  line('GHL returned', ghlIds.size);
  line('would soft-delete', stale.length);

  if (ghlIds.size === 0) {
    console.log(
      '\n  → Nothing came back, so the guard will refuse to reconcile and\n'
      + '    NOTHING would be deleted, whatever the number above says.'
    );
  } else if (stale.length === 0) {
    console.log(
      '\n  → This is answer 1. GHL returned every task we hold, so the sweep\n'
      + '    is working and has correctly deleted nothing. The phantoms are\n'
      + '    in GHL\'s list AND rejected by its write endpoints, so no amount\n'
      + '    of reconciliation will clear them — only probing them one by one\n'
      + '    (npm run probe:task) will.'
    );
  } else {
    console.log(
      '\n  → This is answer 2. These rows are not in GHL and the sweep would\n'
      + '    remove them on its next run:'
    );
    for (const r of stale.slice(0, 25)) {
      console.log(
        `     ${r.task_id}  ${String(r.title || '').slice(0, 40).padEnd(40)}`
        + `  ${r.status || ''}`
      );
    }
    if (stale.length > 25) console.log(`     … and ${stale.length - 25} more`);
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error('probe:tasksweep failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
