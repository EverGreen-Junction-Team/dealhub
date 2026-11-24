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
    return { ok: true, calendars: Array.isArray(list) ? list.length : 0 };
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
  return { locationId, counts, scopes };
}

// The one-line reading of a location. Ordered by how badly it wants
// attention, so the first matching sentence is the one worth acting on.
function verdict(r) {
  if (!r.scopes.ok) return 'CANNOT READ CALENDARS — scopes not granted';
  if (r.scopes.calendars === 0) return 'no calendars in this sub-account';
  if (r.counts.live === 0) return 'nothing has arrived at all';
  if (r.counts.by_webhook === 0) return 'ALL from the sweep — no webhook has ever landed';
  if (r.counts.by_sync === 0 && r.counts.blocked === 0) {
    return 'webhooks landing; the sweep has added nothing (incl. blocked time)';
  }
  if (r.counts.blocked === 0) return 'webhooks landing; no blocked time has ever arrived';
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

  if (r.scopes.ok && r.counts.blocked === 0) {
    console.log(
      '\n  → No blocked time has ever arrived. There is no webhook for it —\n'
      + '    HighLevel documents none — so the nightly sweep is its only\n'
      + '    route in. Either nobody has blocked any time out, or that sweep\n'
      + '    has never read the blocked-slots endpoint successfully. Block an\n'
      + '    hour in GHL, run npm run sync:appointments, and look again: a\n'
      + "    calendar that hides a rep's unavailability will offer a slot\n"
      + '    they are already driving across.'
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
    + 'LIVE'.padStart(6) + 'HOOK'.padStart(6) + 'SWEEP'.padStart(7) + 'BLOCK'.padStart(7)
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
      + String(r.counts.by_webhook).padStart(6)
      + String(r.counts.by_sync).padStart(7)
      + String(r.counts.blocked).padStart(7)
      + `  ${verdict(r)}`
    );
  }

  console.log('\nSummary');
  line('locations probed', found.length);
  line('cannot read calendars', found.filter((r) => !r.scopes.ok).length);
  line('no webhook ever landed', found.filter((r) => r.counts.live > 0 && r.counts.by_webhook === 0).length);
  line('no blocked time ever', found.filter((r) => r.scopes.ok && r.counts.blocked === 0).length);

  const worst = found.find((r) => !r.scopes.ok)
    || found.find((r) => r.counts.live > 0 && r.counts.by_webhook === 0);
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
