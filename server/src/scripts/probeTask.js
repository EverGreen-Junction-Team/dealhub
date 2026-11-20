#!/usr/bin/env node
//
// Ask GHL what became of one task.
//
//   npm run probe:task -- <location_id> <task_id> [<task_id> ...]
//
// WHY THIS EXISTS. A task write came back `400 {"message":"The task id is
// invalid."}`, and nothing in our own data explained it: the id was a
// well-formed 20-character GHL id, not from a backfill, not created by this
// app. Our table says the task exists; GHL says the id is not one it can act
// on. Only GHL can settle which of us is wrong, and about what.
//
// Three questions, in the order that narrows it fastest:
//
//   1. Does the task exist under the contact we have it filed against?
//      This is the pair the write actually uses —
//      PUT /contacts/:contactId/tasks/:taskId — so a mismatch here IS the
//      failure, whatever either half looks like on its own.
//
//   2. Does it exist anywhere in the location?
//      If yes but not under that contact, the task was moved in GHL and our
//      contact_id is stale. If no, it was deleted in GHL and our row is the
//      thing that is stale.
//
//   3. What does GHL say when asked for it directly?
//      Its own words for this id, which is what the rep's error came from.
//
// Read-only. It writes nothing, to either side.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';

async function get(install, url, params) {
  try {
    const { data } = await ghlRequest(install, { method: 'GET', url, params, scopeOptional: true });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || null,
      body: err.response?.data || err.message || String(err)
    };
  }
}

async function main() {
  const [locationId, ...ids] = process.argv.slice(2);
  if (!locationId || !ids.length) {
    console.log('usage: npm run probe:task -- <location_id> <task_id> [...]');
    process.exit(1);
  }

  const install = await getActiveInstall(locationId, { allowDead: true });
  if (!install) {
    console.log(`No install for ${locationId}`);
    process.exit(1);
  }

  // The whole location's tasks, once — so a run over several ids costs one
  // sweep rather than one call each. Needs locations/tasks.readonly; if it is
  // missing we simply report less rather than failing the probe.
  const search = await (async () => {
    try {
      const { data } = await ghlRequest(install, {
        method: 'POST',
        url: `/locations/${encodeURIComponent(locationId)}/tasks/search`,
        data: { limit: 100, skip: 0 },
        scopeOptional: true
      });
      const rows = data?.tasks || data?.data || [];
      return Array.isArray(rows) ? new Set(rows.map((t) => t.id || t._id)) : null;
    } catch {
      return null;
    }
  })();

  for (const taskId of ids) {
    console.log(`\n──────── ${taskId} ────────`);

    const { rows } = await rawQuery(
      `SELECT task_id, contact_id, status, title, due_at,
              created_at_ghl, updated_at_ghl, deleted_at, from_backfill
         FROM tasks
        WHERE location_id = $1 AND task_id = $2`,
      [locationId, taskId]
    );
    const ours = rows[0];
    if (!ours) {
      console.log('OURS:  no row at all');
      continue;
    }
    console.log('OURS: ', JSON.stringify({
      contact_id: ours.contact_id,
      status: ours.status,
      title: ours.title,
      deleted_at: ours.deleted_at,
      updated_at_ghl: ours.updated_at_ghl
    }));

    // 1. Under the contact we have — the pair every write uses.
    if (ours.contact_id) {
      const res = await get(install, `/contacts/${encodeURIComponent(ours.contact_id)}/tasks`);
      if (!res.ok) {
        console.log(`CONTACT: fetch failed (${res.status})`, JSON.stringify(res.body));
      } else {
        const list = Array.isArray(res.data?.tasks) ? res.data.tasks : [];
        const hit = list.find((t) => (t.id || t._id) === taskId);
        console.log(
          `CONTACT: ${list.length} task(s) on this contact; this id is ${hit ? 'PRESENT' : 'ABSENT'}`
        );
        if (!hit && list.length) {
          console.log('         ids here:', list.map((t) => t.id || t._id).join(', '));
        }
      }
    } else {
      console.log('CONTACT: our row has no contact — writes use the location path');
    }

    // 2. Anywhere in the location.
    if (search) {
      console.log(`LOCATION: this id is ${search.has(taskId) ? 'PRESENT' : 'ABSENT'} in the first 100 tasks`);
    } else {
      console.log('LOCATION: search unavailable (needs locations/tasks.readonly)');
    }

    // 3. GHL's own words for this id.
    if (ours.contact_id) {
      const direct = await get(
        install,
        `/contacts/${encodeURIComponent(ours.contact_id)}/tasks/${encodeURIComponent(taskId)}`
      );
      console.log('DIRECT:', direct.ok
        ? 'found'
        : `${direct.status} ${JSON.stringify(direct.body)}`);
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
