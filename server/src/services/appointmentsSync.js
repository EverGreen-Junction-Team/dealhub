// appointmentsSync.js — nightly reconciliation for the `appointments` table.
//
// WHY THIS EXISTS, in two parts. The first is the ordinary reason every sync
// in this app exists: a webhook can be dropped, and the nightly pass is the
// net. The second is specific to the calendar and is the more important one:
//
//   BLOCKED TIME HAS NO WEBHOOK.
//
// A rep blocking out travel, a holiday or an admin afternoon creates a
// calendar event that is not an appointment. HighLevel's webhook index
// (docs/category/webhook, read 24 Nov 2026) lists 78 events, and the only
// three that touch a calendar are AppointmentCreate, AppointmentUpdate and
// AppointmentDelete. No blocked-slot event, no calendar-event event, no
// availability event. So blocked time reaches this database through THIS
// FILE AND NOWHERE ELSE — not as a fallback, as the only route.
//
// That matters more than it sounds. A calendar that shows bookings but not
// blocks does not show the gaps, and showing the gaps is the whole point of
// the thing — a dispatcher looking for a free Tuesday would be offered one
// the rep is already driving across.
//
// THIS ASSUMPTION IS UNVERIFIED and is the single most useful thing to test
// against a live sub-account. Block an hour out in GHL and watch: if a
// webhook arrives, routes/webhooks.js logs it loudly as a calendar-shaped
// type it does not handle, and the fix is a case in appointmentWriter. If
// nothing arrives, this file is the only path and its window matters.
//
// ── SOURCE ───────────────────────────────────────────────────────────
//
// There is no "search all appointments in a location" endpoint. Calendar
// events are read per CALENDAR over a TIME WINDOW:
//
//   GET /calendars/              list the location's calendars
//   GET /calendars/events        appointments in a window   (calendars/events.readonly)
//   GET /calendars/blocked-slots blocked time in a window   (same scope)
//
// so the sweep is: list the calendars, then walk each one over the window.
// Both event endpoints take the same parameters and return the same shape,
// which is why one fetcher serves both — they differ only in what they
// mean, and that difference is recorded as event_kind.
//
// Either endpoint being unavailable is survivable and logged as itself: a
// location whose app lacks the scope still gets its appointments through
// webhooks, it just stops being reconciled.
//
// ── THE WINDOW, AND WHY DELETES ARE SCOPED TO IT ─────────────────────
//
// A diary is read forwards. Reconciling four years of history every night
// would be a large, slow sweep to correct bookings nobody will look at, so
// the window is a rolling one: a short way back (to catch an appointment
// moved or cancelled after the fact) and a long way forward (because that
// is the part people actually plan against).
//
// The consequence is that "GHL did not return it" means "not in this window
// on this calendar", NOT "deleted". A location-wide delete pass against a
// windowed list would soft-delete every appointment outside it — which is
// to say, all of next year. So reconcileDeletes is confined to the exact
// window and the exact calendars that were successfully read, and it still
// goes through the shared shouldReconcileDeletes guard on top. The same trap
// businessesSync and tasksSync hit, reached by a different route.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { ensureContactExists } from './contactStub.js';
import { fetchCalendarTimezone } from './calendarInfo.js';
import { resolveOppForContact } from './attributionEngine.js';
import { shouldReconcileDeletes } from './businessesReconcile.js';
import { recordSyncRun } from './syncRunLog.js';
import { logger } from '../utils/logger.js';

// The rolling window, in days either side of the run.
//
// 30 back: far enough to catch a no-show marked a fortnight late, short
// enough that the sweep stays small. 180 forward: surveys and fits get
// booked months out, and an appointment that falls outside the window is
// simply not reconciled until it drifts into it — it is never deleted for
// being outside (see reconcileDeletes).
const WINDOW_DAYS_BACK = 30;
const WINDOW_DAYS_FORWARD = 180;

// GHL rate-limits per location and a sub-account can have a calendar per
// rep. A short pause between calendars keeps the nightly job polite.
const THROTTLE_MS = 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A ceiling, so a location that somehow reports hundreds of calendars cannot
// turn this into an hours-long crawl. Hitting it marks the run truncated,
// which disables delete reconciliation for that run.
const MAX_CALENDARS_PER_RUN = 100;

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The window, as the two things the caller needs it as.
 *
 * GHL's calendar-event endpoints take epoch MILLISECONDS, not the ISO
 * strings its webhooks send. Passing an ISO string returns an empty list
 * rather than an error, which reads exactly like "this calendar is empty" —
 * so the conversion happens here, once, and the Date objects go to the
 * delete pass where SQL wants them.
 */
function syncWindow(now = new Date()) {
  const from = new Date(now.getTime() - WINDOW_DAYS_BACK * 86400000);
  const to = new Date(now.getTime() + WINDOW_DAYS_FORWARD * 86400000);
  return { from, to, startMs: from.getTime(), endMs: to.getTime() };
}

/**
 * Every calendar in the location.
 *
 * Needs `calendars.readonly`. scopeOptional so a location without it does
 * not get its install flagged reauth_required — that flag stops every other
 * nightly sync for the tenant, and an unreconciled calendar is not worth
 * that.
 */
async function fetchCalendars(install, locationId) {
  const { data } = await ghlRequest(install, {
    method: 'GET',
    url: '/calendars/',
    params: { locationId },
    scopeOptional: true
  });
  const rows = data?.calendars || data?.data || [];
  return Array.isArray(rows) ? rows : [];
}

/**
 * One calendar's events over the window, from whichever endpoint.
 *
 * `path` is the only difference between appointments and blocked time — the
 * parameters and the response shape are identical, so this is shared rather
 * than written twice with one word changed.
 *
 * Returns null, NOT [], when the endpoint could not be read. The caller has
 * to tell "this calendar is empty" from "we could not look", because the
 * first permits delete reconciliation and the second must forbid it.
 */
async function fetchCalendarEvents(install, locationId, scope, path, { startMs, endMs }) {
  // `scope` is { calendarId } or { userId } — see PERSON-LEVEL BLOCKED TIME.
  // A bare string is still accepted as a calendar id.
  const by = typeof scope === 'string' ? { calendarId: scope } : scope;
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: path,
      params: {
        locationId,
        ...by,
        startTime: String(startMs),
        endTime: String(endMs)
      },
      scopeOptional: true
    });
    const rows = data?.events || data?.blockedSlots || data?.data || [];
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const status = err.response?.status;
    logger.warn(
      { locationId, ...by, path, status, err },
      'appointmentsSync: calendar event fetch failed — this calendar will '
      + 'not be reconciled on this run'
    );
    return null;
  }
}

/**
 * Write one event from GHL's shape.
 *
 * Deliberately NOT shared with appointmentWriter's upsert, for the reason
 * tasksSync gives for the same split: the webhook path has event context
 * this one does not, and binding them together makes each harder to change
 * for the other's sake.
 *
 * The important divergence is `eventKind`. This is the only writer that can
 * produce 'blocked', and it knows which it has solely from which endpoint
 * the row came back from — a blocked slot carries no field that announces
 * itself.
 */
async function upsertEvent(install, locationId, e, eventKind, { calendarId }) {
  const appointmentId = e.id || e._id;
  if (!appointmentId) return false;

  const contactId = e.contactId || null;
  const assignedUserId = e.assignedUserId || null;
  const startsAt = toTimestamp(e.startTime);
  const endsAt = toTimestamp(e.endTime);

  // FK safety, exactly as on the webhook path: a booking widget can create
  // the contact and the appointment together, and contactsSync may not have
  // reached it. Blocked time has no contact at all, which is why this is
  // guarded rather than assumed.
  if (contactId) await ensureContactExists(locationId, contactId);

  // Blocked time is nobody's deal. Deriving one would attach a rep's holiday
  // to whatever job their contact happens to be on — so the derivation is
  // skipped entirely rather than being allowed to return something.
  let opportunityId = null;
  if (eventKind === 'appointment' && contactId) {
    const decision = await resolveOppForContact(
      locationId, contactId, toTimestamp(e.dateAdded) || startsAt || new Date()
    );
    opportunityId = decision?.mappingStatus === 'mapped' ? decision.opportunityId : null;
  }

  const [calendarTimezone, assignedUserName] = await Promise.all([
    fetchCalendarTimezone(install, e.calendarId || calendarId),
    (async () => {
      if (!assignedUserId) return null;
      const { rows } = await rawQuery(
        `SELECT name FROM users WHERE location_id = $1 AND user_id = $2 LIMIT 1`,
        [locationId, assignedUserId]
      );
      return rows[0]?.name || null;
    })()
  ]);

  const { rowCount } = await rawQuery(
    `INSERT INTO appointments (
       location_id, appointment_id,
       calendar_id, calendar_timezone, group_id,
       contact_id, opportunity_id,
       assigned_user_id, assigned_user_name, user_ids,
       event_kind, title, address, notes, appointment_status, source,
       starts_at, ends_at,
       raw_appointment, from_backfill,
       created_at_ghl, updated_at_ghl, imported_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true,$20,$21, now(), now()
     )
     ON CONFLICT (location_id, appointment_id) DO UPDATE SET
       calendar_id        = COALESCE(EXCLUDED.calendar_id, appointments.calendar_id),
       calendar_timezone  = COALESCE(EXCLUDED.calendar_timezone, appointments.calendar_timezone),
       group_id           = COALESCE(EXCLUDED.group_id, appointments.group_id),
       contact_id         = COALESCE(EXCLUDED.contact_id, appointments.contact_id),
       opportunity_id     = COALESCE(EXCLUDED.opportunity_id, appointments.opportunity_id),
       assigned_user_id   = EXCLUDED.assigned_user_id,
       assigned_user_name = COALESCE(EXCLUDED.assigned_user_name, appointments.assigned_user_name),
       user_ids           = COALESCE(EXCLUDED.user_ids, appointments.user_ids),
       -- Latched to 'blocked' once known.
       --
       -- The two endpoints are the ONLY thing that distinguishes the kinds,
       -- and if a blocked slot were ever also returned by the appointments
       -- endpoint, the later write would quietly reclassify a block as a
       -- booking and it would stop showing as unavailable time. Promoting in
       -- one direction only means the stricter reading wins.
       event_kind         = CASE WHEN appointments.event_kind = 'blocked'
                                 THEN 'blocked' ELSE EXCLUDED.event_kind END,
       -- Assigned outright: reconciling an edit is what this job is for.
       title              = EXCLUDED.title,
       address            = EXCLUDED.address,
       notes              = EXCLUDED.notes,
       appointment_status = EXCLUDED.appointment_status,
       source             = COALESCE(EXCLUDED.source, appointments.source),
       starts_at          = EXCLUDED.starts_at,
       ends_at            = EXCLUDED.ends_at,
       raw_appointment    = EXCLUDED.raw_appointment,
       created_at_ghl     = COALESCE(appointments.created_at_ghl, EXCLUDED.created_at_ghl),
       updated_at_ghl     = COALESCE(EXCLUDED.updated_at_ghl, appointments.updated_at_ghl),
       -- Back from the dead: GHL still has it, so we do too.
       deleted_at         = NULL,
       updated_at         = now()
     WHERE
       -- Skip unchanged rows, so "what moved last night" stays answerable
       -- from updated_at instead of being every row every night.
       appointments.starts_at          IS DISTINCT FROM EXCLUDED.starts_at
       OR appointments.ends_at         IS DISTINCT FROM EXCLUDED.ends_at
       OR appointments.title           IS DISTINCT FROM EXCLUDED.title
       OR appointments.address         IS DISTINCT FROM EXCLUDED.address
       OR appointments.notes           IS DISTINCT FROM EXCLUDED.notes
       OR appointments.appointment_status IS DISTINCT FROM EXCLUDED.appointment_status
       OR appointments.assigned_user_id   IS DISTINCT FROM EXCLUDED.assigned_user_id
       OR appointments.event_kind      IS DISTINCT FROM EXCLUDED.event_kind
       OR appointments.calendar_timezone IS DISTINCT FROM EXCLUDED.calendar_timezone
       OR appointments.deleted_at      IS NOT NULL`,
    [
      locationId, appointmentId,
      e.calendarId || calendarId || null, calendarTimezone, e.groupId || null,
      contactId, opportunityId,
      assignedUserId, assignedUserName,
      Array.isArray(e.users) ? e.users.filter((u) => typeof u === 'string' && u) : null,
      eventKind,
      // notes OR description — see appointmentWriter for why both.
      e.title || null, e.address || null, e.notes || e.description || null,
      e.appointmentStatus || null, e.source || null,
      startsAt, endsAt,
      e,
      toTimestamp(e.dateAdded), toTimestamp(e.dateUpdated)
    ]
  );
  // 0 means the WHERE skipped it — unchanged, not failed.
  return rowCount > 0;
}

/**
 * Soft-delete appointments GHL no longer has IN THE SWEPT WINDOW.
 *
 * Three guards, and all three are load-bearing:
 *
 *   1. the shared shouldReconcileDeletes verdict — a failed or truncated
 *      sweep must never be read as "GHL has nothing";
 *   2. the WINDOW — `NOT (appointment_id = ANY(...))` matches everything
 *      outside it, which without this clause is next year's entire diary;
 *   3. the CALENDARS actually read — a calendar whose fetch failed is not in
 *      the list, and its appointments must not be deleted for it.
 *
 * Note it does NOT filter on event_kind. A blocked slot removed in GHL has
 * to disappear here too, and it came back from the same window.
 */
async function reconcileDeletes(locationId, seenIds, { truncated, calendarIds, userIds = [], window }) {
  const verdict = shouldReconcileDeletes({ seenCount: seenIds.length, truncated });
  if (!verdict.reconcile) {
    logger.warn(
      { locationId, seenCount: seenIds.length, truncated, reason: verdict.reason },
      'appointmentsSync: skipping delete reconciliation'
    );
    return 0;
  }
  // Person-level blocked time (see PERSON-LEVEL BLOCKED TIME): a block
  // removed in GHL must leave here too. Only blocked rows, only for people
  // whose fetch SUCCEEDED, and never a row tied to a calendar that was not
  // itself read — the same three guards as the calendar pass.
  let userDeleted = 0;
  if (userIds.length) {
    const r = await rawQuery(
      `UPDATE appointments
          SET deleted_at = now(), updated_at = now()
        WHERE location_id = $1
          AND deleted_at IS NULL
          AND event_kind = 'blocked'
          AND assigned_user_id = ANY($3::text[])
          AND (calendar_id IS NULL OR calendar_id = ANY($6::text[]))
          AND starts_at >= $4
          AND starts_at <= $5
          AND NOT (appointment_id = ANY($2::text[]))`,
      [locationId, seenIds, userIds, window.from, window.to, calendarIds]
    );
    userDeleted = r.rowCount || 0;
  }
  if (!calendarIds.length) return userDeleted;

  const { rowCount } = await rawQuery(
    `UPDATE appointments
        SET deleted_at = now(), updated_at = now()
      WHERE location_id = $1
        AND deleted_at IS NULL
        AND calendar_id = ANY($3::text[])
        AND starts_at >= $4
        AND starts_at <= $5
        AND NOT (appointment_id = ANY($2::text[]))`,
    [locationId, seenIds, calendarIds, window.from, window.to]
  );
  return (rowCount || 0) + userDeleted;
}

/**
 * Sync one location.
 */
export async function syncAppointmentsForLocation(locationId) {
  const install = await getActiveInstall(locationId);
  if (!install) {
    logger.warn({ locationId }, 'appointmentsSync: no active install — skipping');
    return { seen: 0, changed: 0, deleted: 0, blocked: 0, truncated: false };
  }

  const window = syncWindow();

  let calendars;
  try {
    calendars = await fetchCalendars(install, locationId);
  } catch (err) {
    if (err.code === 'GHL_SCOPE_MISSING') {
      // Nothing to fall back to — unlike tasks, there is no second endpoint
      // that reaches calendar events without this scope. Said plainly,
      // because the consequence is that blocked time never arrives at all.
      logger.warn(
        { locationId },
        'appointmentsSync: cannot list calendars (calendars.readonly missing) '
        + '— appointments still arrive by webhook, but nothing is reconciled '
        + 'and blocked time will never be captured for this location'
      );
      return { seen: 0, changed: 0, deleted: 0, blocked: 0, truncated: true };
    }
    throw err;
  }

  const truncatedByCap = calendars.length > MAX_CALENDARS_PER_RUN;
  const toSweep = calendars.slice(0, MAX_CALENDARS_PER_RUN);

  const seenIds = [];
  const coveredCalendars = [];
  let changed = 0;
  let blocked = 0;
  let failedFetches = 0;

  for (const cal of toSweep) {
    const calendarId = cal.id || cal._id;
    if (!calendarId) continue;

    // Both kinds, same window. Appointments first so that if the blocked
    // endpoint is unavailable we have still reconciled the bookings.
    const appointments = await fetchCalendarEvents(
      install, locationId, calendarId, '/calendars/events', window
    );
    const blockedSlots = await fetchCalendarEvents(
      install, locationId, calendarId, '/calendars/blocked-slots', window
    );

    // null from EITHER means this calendar was not fully read, so it is not
    // "covered" and its rows are exempt from the delete pass. Anything we
    // did manage to read is still written — a partial read is good data,
    // it just is not evidence of absence.
    if (appointments === null || blockedSlots === null) {
      failedFetches++;
    } else {
      coveredCalendars.push(calendarId);
    }

    const batches = [
      ['appointment', appointments || []],
      ['blocked', blockedSlots || []]
    ];

    for (const [eventKind, rows] of batches) {
      for (const e of rows) {
        const id = e.id || e._id;
        if (!id) continue;
        seenIds.push(id);
        if (eventKind === 'blocked') blocked++;
        try {
          if (await upsertEvent(install, locationId, e, eventKind, { calendarId })) changed++;
        } catch (err) {
          // Postgres errors carry nothing useful on .message — the diagnosis
          // is in code/detail/constraint. Same lesson tasksSync records.
          logger.warn(
            {
              locationId, calendarId, appointmentId: id, eventKind, err,
              pgCode: err.code || null,
              detail: err.detail || null,
              constraint: err.constraint || null
            },
            'appointmentsSync: upsert failed'
          );
        }
      }
    }

    await sleep(THROTTLE_MS);
  }

  // ── PERSON-LEVEL BLOCKED TIME ───────────────────────────────────────
  //
  // GHL's docs (v3, Get Blocked Slots): "calendarId finds blocks set on an
  // event calendar only. Blocks set on a host (assignedUserId) are found by
  // userId." Everything above asked by calendar, so every block set on a
  // PERSON — including busy time synced in from their Google calendar —
  // was never fetched. Found on the live board: GHL showed "Busy 09:00–
  // 11:30" for James Stevens and our board showed nothing, and every sweep
  // so far had logged blocked: 0.
  //
  // So each active person in the location is asked too. A block already
  // seen through a calendar is skipped. A person whose fetch fails is left
  // out of `coveredUsers`, so their blocks are not deleted for it — but it
  // does not stop the calendar pass reconciling.
  const seenSet = new Set(seenIds);
  const coveredUsers = [];
  const { rows: people } = await rawQuery(
    `SELECT user_id FROM users
      WHERE location_id = $1
        AND active = true
        AND deleted_at IS NULL
        AND (location_ids IS NULL OR $1 = ANY(location_ids))`,
    [locationId]
  );
  for (const { user_id: userId } of people) {
    const slots = await fetchCalendarEvents(
      install, locationId, { userId }, '/calendars/blocked-slots', window
    );
    if (slots === null) continue;
    coveredUsers.push(userId);
    for (const e of slots) {
      const id = e.id || e._id;
      if (!id || seenSet.has(id)) continue;
      seenSet.add(id);
      seenIds.push(id);
      blocked++;
      try {
        if (await upsertEvent(install, locationId, e, 'blocked', { calendarId: e.calendarId || null })) changed++;
      } catch (err) {
        logger.warn(
          { locationId, userId, appointmentId: id, err, pgCode: err.code || null, detail: err.detail || null },
          'appointmentsSync: person-level block upsert failed'
        );
      }
    }
    await sleep(THROTTLE_MS);
  }

  const truncated = truncatedByCap || failedFetches > 0;
  const deleted = await reconcileDeletes(locationId, seenIds, {
    truncated, calendarIds: coveredCalendars, userIds: coveredUsers, window
  });

  const stats = {
    calendars: toSweep.length,
    covered: coveredCalendars.length,
    coveredUsers: coveredUsers.length,
    seen: seenIds.length,
    blocked,
    changed,
    deleted,
    truncated,
    windowFrom: window.from,
    windowTo: window.to
  };
  // blocked === 0 across a whole location is worth seeing in the log rather
  // than inferring from silence: it is either a sub-account where nobody
  // blocks time out, or the endpoint returning nothing useful — and those
  // look identical from the database.
  logger.info({ locationId, ...stats }, 'appointmentsSync: location synced');
  return stats;
}

/**
 * Every active install. Entry point for the nightly cron.
 */
export async function syncAllAppointments() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );

  if (rows.length === 0) {
    logger.info('appointmentsSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'appointmentsSync', objectType: 'appointments', scope: 'all',
      status: 'success', startedAt, stats: { locations: 0 }
    });
    return;
  }

  let locations = 0;
  let changed = 0;
  let deleted = 0;
  let blocked = 0;
  let failed = 0;

  for (const { location_id: locationId } of rows) {
    try {
      const s = await syncAppointmentsForLocation(locationId);
      locations++;
      changed += s.changed;
      deleted += s.deleted;
      blocked += s.blocked;
    } catch (err) {
      failed++;
      logger.error(
        { err, status: err.response?.status, locationId },
        'appointmentsSync: location failed'
      );
    }
  }

  await recordSyncRun({
    jobName: 'appointmentsSync', objectType: 'appointments', scope: 'all',
    status: failed > 0 ? 'partial' : 'success',
    startedAt,
    stats: { locations, changed, deleted, blocked, failed }
  });
}
