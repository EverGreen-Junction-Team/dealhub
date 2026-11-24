#!/usr/bin/env node
//
// Are the appointment webhooks arriving, and is blocked time getting in?
//
//   npm run probe:appointments                     every active location
//   npm run probe:appointments -- <location_id>    one, in full
//
// READ-ONLY. It reads our own table and asks GHL for a count to compare
// against. It writes nothing on either side.
//
// ── HOW IT CAN TELL A WEBHOOK FROM A SYNC ────────────────────────────
//
// `from_backfill` is set false by appointmentWriter (the webhook path) and
// true by appointmentsSync (the nightly sweep), and NEITHER updates it on
// conflict. So it records how a row FIRST arrived and keeps that answer for
// good, which is exactly the question here.
//
//   from_backfill = false   a webhook brought this one in
//   from_backfill = true    the nightly sweep found it; no webhook came,
//                           or came and was not handled
//
// A location whose appointments are ALL backfilled is a location whose
// webhooks are not arriving — the data looks fine, because the sweep covers
// it, and the calendar is simply up to a day stale all the time.
//
// ── AND WHY BLOCKED TIME GETS ITS OWN LINE ───────────────────────────
//
// HighLevel documents 78 webhook events and not one of them fires for
// blocked time (docs/category/webhook, checked 24 Nov 2026). So blocked
// time can only ever arrive by the nightly sweep. If the blocked count is
// zero, either nobody has blocked any time out, or that sweep has never
// successfully read the blocked-slots endpoint — and those look identical
// from the calendar, which just shows a day as free when it is not.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';

function line(label, value) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

function ago(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// The same window appointmentsSync sweeps. Asking over a different window
// would produce a count that cannot be compared with what we hold.
const WINDOW_DAYS_BACK = 30;
const WINDOW_DAYS_FORWARD = 180;
// Calendars to sample when counting GHL's side. The point is "is there
// anything there at all", and a sub-account's work is rarely spread thinly
// across dozens of diaries.
const MAX_CALENDARS_SAMPLED = 8;

/**
 * How many events GHL has in the window, across a sample of calendars.
 *
 * ── WHY THIS IS THE QUESTION THAT MATTERS ────────────────────────────
 *
 * Without it, a location holding nothing reads as "nothing has arrived at
 * all" — and that sentence covers two completely different situations: a
 * sub-account that has genuinely booked nothing, and a sweep that is not
 * working. They look identical from our table, and only one of them is a
 * problem. So we ask GHL.
 *
 * Returns null when a calendar could not be read, the same distinction
 * appointmentsSync makes: "empty" and "we could not look" are not the same
 * answer and must not be printed as the same number.
 */
async function countAtGhl(install, locationId, calendars) {
  const now = Date.now();
  const startMs = now - WINDOW_DAYS_BACK * 86400000;
  const endMs = now + WINDOW_DAYS_FORWARD * 86400000;

  let events = 0;
  let blocked = 0;
  let unreadable = 0;

  for (const cal of calendars.slice(0, MAX_CALENDARS_SAMPLED)) {
    const id = cal.id || cal._id;
    if (!id) continue;
    for (const path of ['/calendars/events', '/calendars/blocked-slots']) {
      try {
        const { data } = await ghlRequest(install, {
          method: 'GET',
          url: path,
          params: {
            locationId, calendarId: id,
            startTime: String(startMs), endTime: String(endMs)
          },
          scopeOptional: true
        });
        const rows = data?.events || data?.blockedSlots || data?.data || [];
        const n = Array.isArray(rows) ? rows.length : 0;
        if (path === '/calendars/events') events += n; else blocked += n;
      } catch {
        unreadable++;
      }
    }
  }
  return { events, blocked, unreadable, sampled: Math.min(calendars.length, MAX_CALENDARS_SAMPLED) };
}

/**
 * Can we read this location's calendars at all?
 *
 * The first thing to check, because every other number is meaningless
 * without it: with the scopes ungranted the table is empty and the sweep is
 * reading nothing, which looks exactly like "no appointments booked yet".
 */
async function checkScopes(install, locationId) {
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: '/calendars/',
      params: { locationId },
      scopeOptional: true
    });
    const list = data?.calendars || data?.data || [];
    const calendarList = Array.isArray(list) ? list.filter((c) => c.isActive !== false) : [];
    return { ok: true, calendars: calendarList.length, calendarList };
  } catch (err) {
    return {
      ok: false,
      code: err.code || null,
      status: err.response?.status || null,
      body: err.response?.data || err.message || String(err)
    };
  }
}

async function probeLocation(locationId) {
  const install = await getActiveInstall(locationId);
  if (!install) return { locationId, noInstall: true };

  const { rows: [counts] } = await rawQuery(
    `SELECT
       count(*) FILTER (WHERE deleted_at IS NULL)::int                    AS live,
       count(*) FILTER (WHERE deleted_at IS NOT NULL)::int                AS deleted,
       count(*) FILTER (WHERE deleted_at IS NULL
                          AND event_kind = 'blocked')::int                AS blocked,
       count(*) FILTER (WHERE deleted_at IS NULL
                          AND NOT from_backfill)::int                     AS by_webhook,
       count(*) FILTER (WHERE deleted_at IS NULL
                          AND from_backfill)::int                         AS by_sync,
       max(imported_at) FILTER (WHERE NOT from_backfill)                  AS last_webhook,
       max(imported_at) FILTER (WHERE from_backfill)                      AS last_sync
     FROM appointments
    WHERE location_id = $1`,
    [locationId]
  );

  const scopes = await checkScopes(install, locationId);

  // Has the sweep ever run at all? A location holding nothing because the
  // nightly job has never fired is a different problem from one holding
  // nothing because there is nothing to hold, and the table cannot say
  // which. sync_runs can.
  const { rows: [lastRun] } = await rawQuery(
    `SELECT status, finished_at, counts
       FROM sync_runs
      WHERE run_type = 'appointmentsSync'
      ORDER BY started_at DESC
      LIMIT 1`
  );

  const ghl = scopes.ok && scopes.calendarList.length > 0
    ? await countAtGhl(install, locationId, scopes.calendarList)
    : null;

  return { locationId, counts, scopes, ghl, lastRun };
}

// The one-line reading of a location. Ordered by how badly it wants
// attention, so the first matching sentence is the one worth acting on.
function verdict(r) {
  if (!r.scopes.ok) return 'CANNOT READ CALENDARS — scopes not granted';
  if (r.scopes.calendars === 0) return 'no calendars in this sub-account';

  const atGhl = r.ghl ? r.ghl.events + r.ghl.blocked : null;

  // An empty table is only a problem if GHL has something to give us. This
  // is the distinction the first version of this probe could not make, and
  // it reported three healthy sub-accounts as "nothing has arrived at all".
  if (r.counts.live === 0) {
    if (atGhl === 0) return 'nothing booked in GHL either — nothing to sync';
    if (atGhl === null) return 'we hold nothing; could not count GHL\'s side';
    return `SWEEP NOT WORKING — GHL has ${atGhl} in this window, we have 0`;
  }

  if (atGhl !== null && atGhl > r.counts.live) {
    return `MISSING ${atGhl - r.counts.live} — GHL has ${atGhl}, we have ${r.counts.live}`;
  }
  if (r.counts.by_webhook === 0) return 'all from the sweep — no webhook has landed yet';
  if (r.ghl && r.ghl.blocked > 0 && r.counts.blocked === 0) {
    return 'BLOCKED TIME NOT ARRIVING — GHL has some, we have none';
  }
  if (r.counts.blocked === 0) return 'webhooks landing; no blocked time exists in GHL';
  return 'webhooks and sweep both landing, blocked time included';
}

function report(r) {
  console.log(`\nLocation ${r.locationId}`);
  if (r.noInstall) {
    console.log('  no active install');
    return;
  }

  console.log('\nCan we read the calendars?');
  if (r.scopes.ok) {
    line('GET /calendars/', `OK — ${r.scopes.calendars} calendar(s)`);
  } else {
    line('GET /calendars/', `FAILED  ${r.scopes.code || ''} ${r.scopes.status || ''}`.trim());
    line('body', JSON.stringify(r.scopes.body).slice(0, 240));
    console.log(
      '\n  → Nothing below means anything until this works. The four scopes\n'
      + '    are calendars.readonly, calendars/events.readonly,\n'
      + '    calendars/events.write and locations.readonly, and they can only\n'
      + '    be changed while the marketplace app is in DRAFT.'
    );
  }

  if (r.ghl) {
    console.log(`\nWhat GHL has  (30 days back, 180 forward, ${r.ghl.sampled} calendar(s))`);
    line('appointments', r.ghl.events);
    line('blocked time', r.ghl.blocked);
    if (r.ghl.unreadable > 0) {
      line('endpoints unreadable', r.ghl.unreadable);
      console.log(
        '\n  → Some calendar reads failed, so GHL\'s numbers above are a\n'
        + '    floor, not a total. The sweep skips those calendars too.'
      );
    }
  }

  console.log('\nWhat we hold');
  line('live', r.counts.live);
  line('soft-deleted', r.counts.deleted);
  line('blocked time', r.counts.blocked);

  console.log('\nHow it got here');
  line('by webhook', `${r.counts.by_webhook}   last ${ago(r.counts.last_webhook)}`);
  line('by nightly sweep', `${r.counts.by_sync}   last ${ago(r.counts.last_sync)}`);

  if (r.counts.live > 0 && r.counts.by_webhook === 0) {
    console.log(
      '\n  → The webhooks are NOT arriving. Everything here was found by the\n'
      + '    nightly sweep, so the data looks healthy while the calendar is\n'
      + '    up to a day out of date, all the time. Check that the three\n'
      + '    Appointment events are subscribed on the marketplace app.'
    );
  }

  console.log('\nThe nightly sweep');
  if (r.lastRun) {
    line('last run', `${r.lastRun.status}, ${ago(r.lastRun.finished_at)}`);
    line('counts', JSON.stringify(r.lastRun.counts || {}));
  } else {
    line('last run', 'NEVER — nothing has swept yet');
  }

  if (r.ghl && r.ghl.blocked > 0 && r.counts.blocked === 0) {
    console.log(
      '\n  → GHL HAS blocked time and we hold none. There is no webhook for it —\n'
      + '    HighLevel documents none — so the nightly sweep is its only route\n'
      + '    in, and it is not bringing it. Run npm run sync:appointments and\n'
      + "    look again: a calendar that hides a rep's unavailability will\n"
      + '    offer a slot they are already driving across.'
    );
  } else if (r.ghl && r.ghl.blocked === 0 && r.counts.blocked === 0) {
    console.log(
      '\n  → No blocked time here, and none in GHL either, so there is\n'
      + '    nothing to conclude from the zero. Block an hour in GHL, run\n'
      + '    npm run sync:appointments, and check this line again — that is\n'
      + '    the only way to prove the one route it has actually works.'
    );
  }
  console.log('');
}

async function main() {
  const [locationId] = process.argv.slice(2);

  if (locationId) {
    report(await probeLocation(locationId));
    return;
  }

  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL ORDER BY location_id`
  );
  if (rows.length === 0) {
    console.log('No active installs.');
    return;
  }

  console.log(`\nProbing ${rows.length} location${rows.length === 1 ? '' : 's'}.\n`);
  console.log(
    '  ' + 'LOCATION'.padEnd(26)
    + 'OURS'.padStart(6) + 'GHL'.padStart(6) + 'HOOK'.padStart(6)
    + 'SWEEP'.padStart(7) + 'BLOCK'.padStart(7)
    + '  READING'
  );

  const found = [];
  for (const { location_id: id } of rows) {
    let r;
    try {
      r = await probeLocation(id);
    } catch (err) {
      console.log(`  ${id.padEnd(26)}  ERROR  ${err.message || err}`);
      continue;
    }
    if (r.noInstall) {
      console.log(`  ${id.padEnd(26)}  no active install`);
      continue;
    }
    found.push(r);
    console.log(
      '  ' + id.padEnd(26)
      + String(r.counts.live).padStart(6)
      + String(r.ghl ? r.ghl.events + r.ghl.blocked : '?').padStart(6)
      + String(r.counts.by_webhook).padStart(6)
      + String(r.counts.by_sync).padStart(7)
      + String(r.counts.blocked).padStart(7)
      + `  ${verdict(r)}`
    );
  }

  const atGhl = (r) => (r.ghl ? r.ghl.events + r.ghl.blocked : null);
  const behind = found.filter((r) => atGhl(r) !== null && atGhl(r) > r.counts.live);
  const noHook = found.filter((r) => r.counts.live > 0 && r.counts.by_webhook === 0);

  console.log('\nSummary');
  line('locations probed', found.length);
  line('cannot read calendars', found.filter((r) => !r.scopes.ok).length);
  line('behind GHL', behind.length);
  line('no webhook has landed', noHook.length);
  line(
    'blocked time in GHL',
    found.reduce((n, r) => n + (r.ghl ? r.ghl.blocked : 0), 0)
  );

  // Whether the nightly job runs at all, which no per-location number can
  // say: a location with nothing to sync and a job that never fires look
  // the same from the appointments table.
  const run = found.find((r) => r.lastRun)?.lastRun;
  if (run) {
    line('last appointmentsSync', `${run.status}, ${ago(run.finished_at)}`);
    line('its counts', JSON.stringify(run.counts || {}));
  } else {
    line('last appointmentsSync', 'NEVER RUN — nothing has swept yet');
  }

  if (found.every((r) => r.counts.by_webhook === 0)) {
    console.log(
      '\nNo webhook has landed in ANY location. Two innocent explanations\n'
      + 'before suspecting the wiring: the three Appointment events may not be\n'
      + 'subscribed on the marketplace app, or nobody may have created an\n'
      + 'appointment since the server was last restarted — webhooks only fire\n'
      + 'on new activity, and the rows above came from the sweep backfilling\n'
      + 'history. Create one in GHL and run this again; it should appear\n'
      + 'within seconds under HOOK.'
    );
  }

  const worst = found.find((r) => !r.scopes.ok) || behind[0] || noHook[0];
  if (worst) {
    console.log(`\nStart here: npm run probe:appointments -- ${worst.locationId}`);
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('probe:appointments failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
