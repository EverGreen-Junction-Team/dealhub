#!/usr/bin/env node
//
// What would tasksSync delete, and why has it not?
//
//   npm run probe:tasksweep                     every active location
//   npm run probe:tasksweep -- <location_id>    one, in full
//
// With no argument it prints a line per sub-account saying which fetch path
// that location is on, how many tasks each side holds, and how many rows the
// delete pass would remove — because the estate rarely has one cause, and
// "is this everywhere or is it one client" is the first thing worth knowing.
// Naming a location then gets the full report, including the rows.
//
// READ-ONLY in both forms. It writes nothing to either side — not a task,
// not a sync_run, not a soft delete. It runs the same two fetch paths
// tasksSync runs, then reports what the delete pass WOULD have done.
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
// And shallower again when sweeping the whole estate, because the fallback
// costs one call per contact and that now multiplies by the number of
// sub-accounts. Across the estate the question is "which locations are
// affected, and how", not "exactly which rows" — and that shape is visible
// from a handful of contacts. Name one location to get the full cap.
const ALL_LOCATIONS_CONTACT_LIMIT = 12;
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
async function tryPerContact(install, locationId, limit = PROBE_CONTACT_LIMIT) {
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
    [locationId, limit]
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

/**
 * Run both paths for one location and work out what the delete pass would do.
 *
 * Returns the finding; prints nothing. The two callers want very different
 * output — one location in full, or one line each across the estate — and
 * mixing the printing in here is what would make them drift apart.
 */
async function probeLocation(locationId, { contactLimit }) {
  const install = await getActiveInstall(locationId);
  if (!install) return { locationId, path: 'no install' };

  const { rows: [ours] } = await rawQuery(
    `SELECT count(*)::int AS live,
            count(*) FILTER (WHERE from_backfill)::int AS backfilled
       FROM tasks
      WHERE location_id = $1 AND deleted_at IS NULL`,
    [locationId]
  );

  const search = await trySearch(install, locationId);
  let ghlIds = null;
  let scope = null;
  let path = null;
  let fallback = null;

  if (search.ok && !search.emptyFirstPage) {
    path = 'search';
    ghlIds = new Set(search.ids);
    scope = 'location';
  } else if (search.ok && search.emptyFirstPage) {
    path = 'search (empty)';
    ghlIds = new Set();
    scope = 'location';
  } else {
    path = 'per-contact';
    fallback = await tryPerContact(install, locationId, contactLimit);
    ghlIds = new Set(fallback.ids);
    scope = fallback.covered;
  }

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

  // Which of the four explanations this location has. Worked out here, once,
  // so the summary table and the detailed report cannot disagree about it.
  let answer;
  if (ghlIds.size === 0) answer = 4;
  else if (stale.length === 0) answer = 1;
  else if (path === 'per-contact') answer = 3;
  else answer = 2;

  return {
    locationId, path, answer, search, fallback,
    ours, inScope: candidates.length, ghlCount: ghlIds.size, stale
  };
}

const ANSWERS = {
  1: 'GHL returns every task we hold — reconciliation can never clear these',
  2: 'the sweep would delete these; something was stopping the pass',
  3: 'running the fallback path — check the failed-contact count',
  4: 'nothing came back, so the empty-list guard refuses to act'
};

/** One location, in full. */
function report(r) {
  console.log(`\nLocation ${r.locationId}`);
  if (r.path === 'no install') {
    console.log('  no active install');
    return;
  }

  console.log('\nOur table');
  line('live tasks', r.ours.live);
  line('of those, backfilled', r.ours.backfilled);

  console.log('\nSearch path  POST /locations/:id/tasks/search');
  if (!r.search.ok) {
    line('result', `FAILED  ${r.search.code || ''} ${r.search.status || ''}`.trim());
    line('body', JSON.stringify(r.search.body).slice(0, 300));
  } else if (r.search.emptyFirstPage) {
    line('result', 'succeeded but returned NO tasks');
    line('response keys', JSON.stringify(r.search.shape));
    console.log(
      '\n  → Answer 4. The call works and says the location has no tasks, so\n'
      + '    the empty-list guard refuses to reconcile — correctly, since an\n'
      + '    empty list would otherwise delete everything. If the response\n'
      + '    keys above are not what the reader expects, the list is being\n'
      + '    read from the wrong field.'
    );
  } else {
    line('result', `OK — ${r.search.ids.length} tasks`);
  }

  if (r.fallback) {
    console.log('\nFallback path  GET /contacts/:id/tasks');
    line('contacts attempted', r.fallback.attempted);
    line('contacts reached', r.fallback.covered.length);
    line('contacts 404 (gone)', r.fallback.notFound);
    line('contacts failed', r.fallback.failed);
    line('tasks returned', r.fallback.ids.length);
    if (r.fallback.failed > 0) {
      console.log(
        '\n  → Answer 3. Before the fix, ANY non-404 failure here set\n'
        + '    truncated and abandoned the delete pass for the entire\n'
        + '    location, however many contacts answered.'
      );
    }
  }

  console.log('\nWhat the delete pass would do');
  line('rows in delete scope', r.inScope);
  line('GHL returned', r.ghlCount);
  line('would soft-delete', r.stale.length);

  if (r.answer === 1) {
    console.log(
      '\n  → Answer 1. GHL returned every task we hold, so the sweep is\n'
      + '    working and has correctly deleted nothing. The phantoms are in\n'
      + "    GHL's list AND rejected by its write endpoints, so no amount of\n"
      + '    reconciliation will clear them — only probing them one by one\n'
      + '    (npm run probe:task) will.'
    );
  } else if (r.stale.length > 0) {
    console.log('\n  → These rows are not in GHL and the sweep would remove them:');
    for (const t of r.stale.slice(0, 25)) {
      console.log(
        `     ${t.task_id}  ${String(t.title || '').slice(0, 40).padEnd(40)}  ${t.status || ''}`
      );
    }
    if (r.stale.length > 25) console.log(`     … and ${r.stale.length - 25} more`);
  }
  console.log('');
}

async function main() {
  const [locationId] = process.argv.slice(2);

  // ── One location, in full ───────────────────────────────────────────
  if (locationId) {
    report(await probeLocation(locationId, { contactLimit: PROBE_CONTACT_LIMIT }));
    return;
  }

  // ── Every location, one line each ───────────────────────────────────
  //
  // WHY THE SHALLOWER CONTACT CAP. The fallback path costs one HTTP call per
  // contact, and across an estate that multiplies by the number of
  // sub-accounts. The question here is "which locations are affected and
  // how", not "exactly which rows" — and the shape of the answer is clear
  // from a handful of contacts. Any location worth looking at properly gets
  // the single-location form, which uses the full cap.
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL ORDER BY location_id`
  );
  if (rows.length === 0) {
    console.log('No active installs.');
    return;
  }

  console.log(`\nProbing ${rows.length} location${rows.length === 1 ? '' : 's'}.`);
  console.log(
    `Sampling up to ${ALL_LOCATIONS_CONTACT_LIMIT} contacts each on the fallback path — `
    + 'run one location on its own for the full sweep.\n'
  );
  console.log(
    '  '
    + 'LOCATION'.padEnd(26) + 'PATH'.padEnd(16)
    + 'OURS'.padStart(7) + 'GHL'.padStart(7) + 'STALE'.padStart(7)
    + '  WHAT IT MEANS'
  );

  const findings = [];
  for (const { location_id: id } of rows) {
    let r;
    try {
      r = await probeLocation(id, { contactLimit: ALL_LOCATIONS_CONTACT_LIMIT });
    } catch (err) {
      console.log(`  ${id.padEnd(26)}${'ERROR'.padEnd(16)}  ${err.message || err}`);
      continue;
    }
    findings.push(r);
    if (r.path === 'no install') {
      console.log(`  ${id.padEnd(26)}${'no install'.padEnd(16)}`);
      continue;
    }
    console.log(
      '  '
      + id.padEnd(26)
      + r.path.padEnd(16)
      + String(r.ours.live).padStart(7)
      + String(r.ghlCount).padStart(7)
      + String(r.stale.length).padStart(7)
      + `  ${ANSWERS[r.answer]}`
    );
  }

  // ── What to do about it ─────────────────────────────────────────────
  const live = findings.filter((r) => r.path !== 'no install');
  const byAnswer = new Map();
  for (const r of live) byAnswer.set(r.answer, (byAnswer.get(r.answer) || 0) + 1);

  console.log('\nSummary');
  line('locations probed', live.length);
  line('stale rows in total', live.reduce((n, r) => n + r.stale.length, 0));
  for (const [answer, count] of [...byAnswer].sort()) {
    line(`answer ${answer}`, `${count} location${count === 1 ? '' : 's'} — ${ANSWERS[answer]}`);
  }

  // The estate rarely has one cause. Point at the worst location rather
  // than leaving the reader to scan the table for it.
  const worst = live.slice().sort((a, b) => b.stale.length - a.stale.length)[0];
  if (worst && worst.stale.length > 0) {
    console.log(
      `\nMost affected: ${worst.locationId} (${worst.stale.length} stale).\n`
      + `  npm run probe:tasksweep -- ${worst.locationId}`
    );
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('probe:tasksweep failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
