import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { contactLabel } from '../utils/contactLabel.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import { fetchLocationTimezone } from '../services/locationInfo.js';
import {
  updateGhlAppointment, deleteGhlAppointment, createGhlAppointment,
  AppointmentWriteError
} from '../services/ghlAppointmentWrite.js';
import { ghlRequest } from '../services/ghlClient.js';
import { userMessage } from '../utils/userMessage.js';
import { logger } from '../utils/logger.js';

export const appointmentsRouter = express.Router();
appointmentsRouter.use(requireSession);

// The operations calendar's board: a column per person, read down the day.
//
// ── WHY THIS IS NOT PAGED ────────────────────────────────────────────
//
// Every other list in this app is keyset-paged, and this one deliberately is
// not. A board is a FIXED WINDOW: a day or a week, every column at once.
// There is no "load more" — a half-drawn Tuesday is not a smaller Tuesday,
// it is a wrong one, and a rep looking for a free slot would be offered one
// that is already taken on page two.
//
// The window is bounded instead, which gives the same protection paging
// gives a list: see MAX_WINDOW_DAYS.
//
// ── THE COLUMNS COME BACK WITH THE ROWS ──────────────────────────────
//
// `resources` (the people) is returned alongside `appointments` rather than
// being fetched separately from /api/deals/users, for one reason that only
// shows up in production: a departed rep. /api/deals/users lists ACTIVE
// account users, which is right for an owner picker — you should not be able
// to assign new work to someone who has left. But their appointments still
// exist, and a board built from that list would draw every one of them into
// no column at all, or drop them silently.
//
// So the column set is the union of "people you can assign to" and "people
// who actually have something in this window". The second group is flagged
// `assignable: false` so the UI can show the work without offering it as a
// destination.

const MAX_WINDOW_DAYS = 31;
const DEFAULT_WINDOW_DAYS = 7;

// An ISO date or datetime, as the board sends it.
function parseWhen(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The window to draw, clamped.
 *
 * A board with no bounds is a request for every appointment ever booked, and
 * the first person to type a URL by hand would get it. Clamped rather than
 * rejected: someone asking for three months gets one month and a flag saying
 * so, which is more useful than an error for what is almost always a typo.
 */
function resolveWindow(query) {
  const from = parseWhen(query.from) || new Date();
  let to = parseWhen(query.to);
  if (!to) {
    to = new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86400000);
  }
  let clamped = false;
  if (to <= from) {
    to = new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86400000);
    clamped = true;
  }
  const maxTo = new Date(from.getTime() + MAX_WINDOW_DAYS * 86400000);
  if (to > maxTo) {
    to = maxTo;
    clamped = true;
  }
  return { from, to, clamped };
}

// ── GET /api/appointments ─────────────────────────────────────────────
//
//   ?from=<ISO>&to=<ISO>        the window (default: 7 days from now)
//   ?assignedTo=<userId>        one person's column only
//   ?kind=appointment|blocked|all   (default: all — see below)
//   ?dealId=<opportunity_id>    this deal's appointments
//   ?contactId=<contact_id>     this customer's appointments
//
// kind defaults to ALL, which is the opposite of what a list would do.
//
// A board that hides blocked time is actively misleading in a way that a
// board with no appointments is not: the gaps are what a dispatcher reads.
// Showing bookings only would present a rep's travel afternoon as free.
appointmentsRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const { from, to, clamped } = resolveWindow(req.query);
  const assignedTo = (req.query.assignedTo || '').toString().trim();
  const kindRaw = (req.query.kind || 'all').toString();
  const kind = ['appointment', 'blocked', 'all'].includes(kindRaw) ? kindRaw : 'all';
  const dealId = (req.query.dealId || '').toString().trim() || null;
  const contactId = (req.query.contactId || '').toString().trim() || null;

  try {
    const { appointments, resources } = await withTenant(locationId, async (client) => {
      const params = [locationId, from, to];
      const conds = [
        'a.location_id = $1',
        'a.deleted_at IS NULL',
        // Overlap, not containment. An all-day block that started yesterday
        // still occupies this morning, and a survey running past midnight is
        // on both days — testing starts_at alone would drop both from the
        // very view they matter most in.
        'a.starts_at < $3',
        'COALESCE(a.ends_at, a.starts_at) >= $2'
      ];

      if (kind !== 'all') {
        params.push(kind);
        conds.push(`a.event_kind = $${params.length}`);
      }
      if (assignedTo) {
        if (assignedTo === 'unassigned') {
          // A real choice, not an empty one — the same reasoning the tasks
          // queue uses. An appointment nobody owns is the one most likely to
          // be missed, so it has to be selectable rather than only reachable
          // by looking at everything.
          conds.push('a.assigned_user_id IS NULL');
        } else {
          params.push(assignedTo);
          // ANY attendee, not only the owner. A survey with a fitter
          // shadowing belongs in both their columns; filtering on
          // assigned_user_id alone would hide it from the person who is
          // actually going.
          conds.push(`(a.assigned_user_id = $${params.length}
                       OR $${params.length} = ANY(a.user_ids))`);
        }
      }
      if (dealId) {
        params.push(dealId);
        conds.push(`a.opportunity_id = $${params.length}`);
      }
      if (contactId) {
        params.push(contactId);
        conds.push(`a.contact_id = $${params.length}`);
      }

      const { rows } = await client.query(
        `SELECT a.appointment_id, a.calendar_id, a.calendar_timezone,
                a.contact_id, a.opportunity_id,
                a.assigned_user_id, a.assigned_user_name, a.user_ids,
                a.event_kind, a.title, a.address, a.notes,
                a.appointment_status, a.source,
                a.starts_at, a.ends_at,
                c.first_name, c.last_name, c.company_name, c.email, c.phone,
                o.name AS deal_name, o.monetary_value, o.currency,
                o.status AS deal_status,
                -- The owner's name from the users table BEHIND the one stamped on
                -- the row: the stamped copy is correct as of when the
                -- appointment was written, and users is correct now. A rep who changed
                -- their display name last week should not read as two people
                -- on the same board.
                u.name AS owner_name_now
           FROM appointments a
           LEFT JOIN contacts c
             ON c.location_id = a.location_id AND c.contact_id = a.contact_id
           LEFT JOIN opportunities o
             ON o.location_id = a.location_id AND o.opportunity_id = a.opportunity_id
           LEFT JOIN users u
             ON u.location_id = a.location_id AND u.user_id = a.assigned_user_id
          WHERE ${conds.join('\n            AND ')}
          ORDER BY a.starts_at ASC, a.appointment_id ASC`,
        params
      );

      // The people who can be assigned work: the same set the owner picker
      // uses, and for the same reasons (see GET /api/deals/users).
      const { rows: assignable } = await client.query(
        `SELECT user_id, name, email
           FROM users
          WHERE location_id = $1
            AND active = true
            AND deleted_at IS NULL
            AND user_type = 'account'
            AND (location_ids IS NULL OR $1 = ANY(location_ids))
          ORDER BY name ASC NULLS LAST, email ASC`,
        [locationId]
      );

      return { appointments: rows, resources: assignable };
    });

    // Columns = people you can assign to, PLUS anyone holding work in this
    // window who is not in that list. See the header note: a departed rep's
    // Tuesday still has to be drawn.
    const columns = new Map();
    for (const u of resources) {
      columns.set(u.user_id, {
        id: u.user_id,
        name: u.name || u.email || u.user_id,
        email: u.email,
        assignable: true
      });
    }
    for (const row of appointments) {
      const id = row.assigned_user_id;
      if (!id || columns.has(id)) continue;
      columns.set(id, {
        id,
        name: row.owner_name_now || row.assigned_user_name || id,
        email: null,
        // Work shows; the column is not offered as a destination.
        assignable: false
      });
    }

    // The zone the board draws in. Resolved here, once, server-side —
    // locationInfo.js explains why this is never left to the browser.
    const locationTimezone = await (async () => {
      const install = await getActiveInstall(locationId, { allowDead: true });
      return install ? fetchLocationTimezone(install) : null;
    })();

    res.json({
      appointments: appointments.map((r) => ({
        id: r.appointment_id,
        kind: r.event_kind,
        title: r.title,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.appointment_status,
        source: r.source,
        address: r.address,
        notes: r.notes,
        calendarId: r.calendar_id,
        // Per row, because two calendars in one sub-account can sit in
        // different zones. The board falls back to `timezone` below.
        timezone: r.calendar_timezone,
        assignedUserId: r.assigned_user_id,
        assignedUserName: r.owner_name_now || r.assigned_user_name || null,
        attendeeIds: r.user_ids || [],
        contactId: r.contact_id,
        contactName: r.contact_id ? contactLabel(r) : null,
        // NULL deal is a real and common state — the contact has more than
        // one open deal and migration 143 declines to guess. The board shows
        // it as "No deal" rather than hiding the slot, the same way the task
        // queue treats an unattached task.
        dealId: r.opportunity_id,
        dealName: r.deal_name,
        dealValue: r.monetary_value,
        dealCurrency: r.currency,
        dealStatus: r.deal_status
      })),
      resources: [...columns.values()],
      timezone: locationTimezone,
      window: { from, to, clamped }
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/appointments failed');
    next(err);
  }
});

// ── GET /api/appointments/calendars ───────────────────────────────────
//
// The calendars a booking can be made on.
//
// NOT FROM OUR DATABASE, because we do not hold one. Appointments carry a
// calendar_id and we enrich a timezone from it (calendarInfo.js), but there
// is no `calendars` table — nothing so far has needed to LIST them, only to
// resolve one. Adding a table and a nightly sync for a dropdown that opens a
// few times a day would be a sync to keep correct forever in exchange for
// nothing; this is one cached call instead.
//
// MUST be registered before any GET /:id — the same single-segment
// shadowing trap /api/deals/users and /api/deals/pipelines document. There
// is no GET /:id on this router today, which is exactly why it is worth
// putting this first now rather than discovering it when one is added.
//
// Requires `calendars.readonly`. Without it the booking form has nothing to
// offer, so the error says which permission is missing rather than
// presenting an empty dropdown that looks like "no calendars exist".
appointmentsRouter.get('/calendars', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: userMessage(why) });
    }
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: '/calendars/',
      params: { locationId },
      scopeOptional: true
    });
    const rows = Array.isArray(data?.calendars) ? data.calendars : [];
    res.json({
      calendars: rows
        // Inactive calendars are GHL's soft-delete: one is a calendar
        // somebody has retired, and offering it would let a rep book onto a
        // diary nobody reads.
        .filter((c) => c.isActive !== false)
        .map((c) => ({
          id: c.id || c._id,
          name: c.name || 'Calendar',
          timezone: c.timezone || null
        }))
        .filter((c) => c.id)
    });
  } catch (err) {
    if (err.code === 'GHL_SCOPE_MISSING') {
      return res.status(403).json({
        error: 'This app cannot read your calendars yet — the '
          + 'calendars.readonly permission is missing. It has to be added '
          + 'while the app is in draft, then reauthorised.'
      });
    }
    logger.error({ err, locationId }, 'GET /api/appointments/calendars failed');
    next(err);
  }
});

// ── POST /api/appointments ────────────────────────────────────────────
//
// Book one.
//
// Like every other write here, this goes to GHL and the AppointmentCreate
// webhook writes our row — so the new appointment does NOT appear in a
// refetch issued the same instant. The response carries GHL's created
// appointment so the board can say what it booked, and the board polls
// briefly for the row to land rather than claiming it is already there.
appointmentsRouter.post('/', async (req, res, next) => {
  const locationId = req.locationId;
  const {
    calendarId, contactId, startTime, endTime, title, address,
    assignedUserId, notifyCustomer, ignoreAvailability
  } = req.body || {};

  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: userMessage(why) });
    }

    const created = await createGhlAppointment(install, {
      calendarId, contactId, startTime, endTime, title, address,
      assignedUserId,
      // Passed through, never defaulted here — ghlAppointmentWrite owns the
      // decision and documents why booking is the one case where notifying
      // the customer is arguably right.
      notifyCustomer, ignoreAvailability
    });

    res.status(201).json({ appointment: created });
  } catch (err) {
    if (err instanceof AppointmentWriteError) {
      return res.status(err.status).json({ error: err.message, field: err.field });
    }
    logger.error({ err, locationId }, 'POST /api/appointments failed');
    next(err);
  }
});

// ── PATCH /api/appointments/:id ───────────────────────────────────────
//
// Move it, give it to somebody else, or cancel it. One endpoint, because on
// a board these are the same gesture — a drag down a column is a move, a
// drag across columns is a reassignment, and often it is both at once.
//
// THE WRITE GOES TO GHL AND THE WEBHOOK WRITES OUR ROW. We do not touch
// `appointments` here: AppointmentUpdate fires and appointmentWriter owns
// that table. The echo is returned so the board can settle the card into the
// time GHL actually stored rather than the one the browser guessed.
appointmentsRouter.patch('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const appointmentId = req.params.id;
  const {
    startTime, endTime, assignedUserId, appointmentStatus,
    title, address, notifyCustomer, ignoreAvailability
  } = req.body || {};

  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: userMessage(why) });
    }

    // Blocked time is not an appointment and GHL's appointment endpoints do
    // not own it. Refused here with a reason rather than passed through to a
    // 404 that reads like the record is missing.
    const own = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT event_kind FROM appointments
          WHERE location_id = $1 AND appointment_id = $2 AND deleted_at IS NULL`,
        [locationId, appointmentId]
      );
      return rows[0] || null;
    });
    if (!own) {
      return res.status(404).json({ error: 'That appointment is no longer here.' });
    }
    if (own.event_kind === 'blocked') {
      return res.status(400).json({
        error: 'That is blocked-out time, not an appointment — it has to be '
          + 'changed in the calendar it was blocked on.'
      });
    }

    const echoed = await updateGhlAppointment(install, appointmentId, {
      startTime, endTime, assignedUserId, appointmentStatus, title, address,
      // Passed through explicitly, never defaulted here — ghlAppointmentWrite
      // owns that decision and documents why it is off.
      notifyCustomer, ignoreAvailability
    });

    res.json({ appointment: echoed });
  } catch (err) {
    if (err instanceof AppointmentWriteError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err, locationId, appointmentId }, 'PATCH /api/appointments/:id failed');
    next(err);
  }
});

// ── DELETE /api/appointments/:id ──────────────────────────────────────
//
// Rarely the right thing — prefer PATCH with appointmentStatus 'cancelled',
// which keeps the record that somebody was going to visit and then did not.
// ghlAppointmentWrite says more about the difference. Kept for the genuine
// mistake: an appointment booked on the wrong account.
appointmentsRouter.delete('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const appointmentId = req.params.id;
  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: userMessage(why) });
    }
    await deleteGhlAppointment(install, appointmentId, {
      notifyCustomer: req.body?.notifyCustomer
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof AppointmentWriteError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err, locationId, appointmentId }, 'DELETE /api/appointments/:id failed');
    next(err);
  }
});
