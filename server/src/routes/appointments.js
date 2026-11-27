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
import { pickSlots, slotWindow } from '../services/freeSlots.js';
import { deriveOpportunityId } from '../services/appointmentWriter.js';
import {
  linkableObjects, recordsForContact, searchRecords, linkRecord, unlinkRecord
} from '../services/ghlCustomObjects.js';
import { AssociationError } from '../services/associationConstants.js';
import { normaliseColour, colourMap } from '../services/calendarColours.js';

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

// 45, not 31. A MONTH VIEW IS NOT 31 DAYS.
//
// The month grid draws whole weeks, so it reaches back into the previous
// month and forward into the next — up to 42 days for a month that starts
// on a Sunday and has 31 of them. Clamped at 31 the grid would silently
// lose its last week and a half: appointments drawn as absent, on a view
// whose whole job is "which day is it on".
const MAX_WINDOW_DAYS = 45;
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
                a.event_kind, a.title, a.address, a.notes, a.opportunity_pinned,
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
      //
      // NARROWED BY ?assignedTo, which this previously ignored — so filtering
      // the board to one person, or to Unassigned, still drew a column for
      // every user in the account. On a sub-account with a dozen marketing
      // and system logins that is a screen of empty columns with no sign the
      // filter did anything at all.
      //
      // 'unassigned' yields NO people columns. The board adds the Unassigned
      // column itself when something is in it, so the filter resolves to
      // exactly that one column rather than to nothing.
      const userParams = [locationId];
      let userScope = '';
      if (assignedTo && assignedTo !== 'unassigned') {
        userParams.push(assignedTo);
        userScope = 'AND user_id = $' + userParams.length;
      }
      const { rows: assignable } = assignedTo === 'unassigned'
        ? { rows: [] }
        : await client.query(
          `SELECT user_id, name, email
             FROM users
            WHERE location_id = $1
              AND active = true
              AND deleted_at IS NULL
              AND user_type = 'account'
              AND (location_ids IS NULL OR $1 = ANY(location_ids))
              ${userScope}
            ORDER BY name ASC NULLS LAST, email ASC`,
          userParams
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
        // A person linked this deal (or chose none) — migration 145.
        dealPinned: r.opportunity_pinned === true,
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
// ── GET /api/appointments/free-slots ──────────────────────────────────
//
// The times a calendar will accept, for one day, so the booking card can
// say BEFORE Save whether the chosen time is open — and offer ones that
// are. See services/freeSlots.js for the shape and why.
//
//   calendarId   required
//   from, to     ISO, the day's window in the board's zone (end exclusive)
//   timezone     the board's zone, so slots come back in it
//   userId       optional — the person going, when one is chosen
appointmentsRouter.get('/free-slots', async (req, res, next) => {
  const locationId = req.locationId;
  const { calendarId, from, to, timezone, userId } = req.query || {};
  if (!calendarId) return res.status(400).json({ error: 'Pick a calendar first', field: 'calendarId' });
  const window = slotWindow(from, to);
  if (!window) return res.status(400).json({ error: 'That is not a valid day to check', field: 'from' });
  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: userMessage(why) });
    }
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/calendars/${encodeURIComponent(calendarId)}/free-slots`,
      params: {
        ...window,
        ...(timezone ? { timezone } : {}),
        ...(userId ? { userId } : {})
      },
      // Optional by nature: a missing scope must not mark the install for
      // reauth and halt every sync — the card simply shows no hint.
      scopeOptional: true
    });
    res.json({ slots: pickSlots(data) });
  } catch (err) {
    // Never blocks a booking: the card treats any failure as "unknown" and
    // Save still works (and GHL still has the final say).
    logger.warn({ err, locationId, calendarId }, 'GET /api/appointments/free-slots failed');
    res.status(502).json({ error: 'Could not check availability' });
  }
});

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
    // The colours chosen in Deal Hub (migration 148). A calendar without one
    // gets the dashboard palette's default, so `colour: null` is normal.
    //
    // NEVER FATAL. The list is what the Book form and the sidebar's
    // Calendars section are built from; a colour is decoration. Found live:
    // with the code deployed ahead of migration 148 this query threw, the
    // whole list answered 500, and booking had no calendar to pick. Now the
    // list comes back with default colours and the failure is logged.
    let colours = new Map();
    try {
      colours = colourMap(await withTenant(locationId, async (client) => {
        const { rows: r } = await client.query(
          'SELECT calendar_id, colour FROM calendar_colours WHERE location_id = $1', [locationId]);
        return r;
      }));
    } catch (err) {
      logger.error({ err, locationId }, 'calendar colours could not be read — using defaults (is migration 148 applied?)');
    }
    res.json({
      calendars: rows
        // Inactive calendars are GHL's soft-delete: one is a calendar
        // somebody has retired, and offering it would let a rep book onto a
        // diary nobody reads.
        .filter((c) => c.isActive !== false)
        .map((c) => ({
          id: c.id || c._id,
          name: c.name || 'Calendar',
          timezone: c.timezone || null,
          colour: colours.get(c.id || c._id) || null
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

// ── PUT /api/appointments/calendars/:calendarId/colour ────────────────
//
// { colour: '#rrggbb' } sets the colour every booking on this calendar is
// drawn in; { colour: null } goes back to the palette's default. For the
// whole sub-account — the same rule as the account's appearance defaults:
// anyone in it may change it, and updated_by says who did. Stored in Deal
// Hub only; GHL's own calendar settings are not touched.
appointmentsRouter.put('/calendars/:calendarId/colour', async (req, res, next) => {
  const locationId = req.locationId;
  const calendarId = String(req.params.calendarId || '').trim();
  const colour = normaliseColour(req.body?.colour);
  if (!calendarId || calendarId.length > 100) {
    return res.status(400).json({ error: 'Which calendar?', field: 'calendarId' });
  }
  if (colour === undefined) {
    return res.status(400).json({ error: 'That is not a colour — use #rrggbb', field: 'colour' });
  }
  try {
    await withTenant(locationId, async (client) => {
      if (colour === null) {
        await client.query(
          'DELETE FROM calendar_colours WHERE location_id = $1 AND calendar_id = $2',
          [locationId, calendarId]);
      } else {
        await client.query(
          `INSERT INTO calendar_colours (location_id, calendar_id, colour, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (location_id, calendar_id)
           DO UPDATE SET colour = EXCLUDED.colour, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [locationId, calendarId, colour, req.session?.userId || null]);
      }
    });
    logger.notice({ locationId, calendarId, colour, userId: req.session?.userId || null },
      'calendar colour changed');
    res.json({ ok: true, calendarId, colour });
  } catch (err) {
    logger.error({ err, locationId, calendarId }, 'PUT /api/appointments/calendars/:id/colour failed');
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
    assignedUserId, notifyCustomer, ignoreAvailability, description
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
      notifyCustomer, ignoreAvailability,
      // The note the dispatcher typed. Lands in GHL's appointment
      // description — see createGhlAppointment for why that and not the
      // separate notes resource.
      description
    });

    res.status(201).json({ appointment: created });
  } catch (err) {
    if (err instanceof AppointmentWriteError) {
      return res.status(err.status).json({
        error: err.message, field: err.field,
        // Lets the card offer "Book it anyway" only when the override
        // would actually get past this refusal.
        canOverride: err.canOverride === true
      });
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
// ── PUT /api/appointments/:id/deal ────────────────────────────────────
//
// Link an appointment to one of its customer's deals — or to none — by
// hand. Stored in Deal Hub only: GHL has no appointment-to-deal link (see
// migration 145), and the sweep and webhook writer leave a pinned choice
// alone.
//
//   { dealId: '...' }   link this deal (must be on the appointment's customer)
//   { dealId: null }    deliberately no deal
//   { mode: 'auto' }    hand it back to the automatic link
appointmentsRouter.put('/:id/deal', async (req, res, next) => {
  const locationId = req.locationId;
  const appointmentId = req.params.id;
  const auto = req.body?.mode === 'auto';
  const dealId = auto ? null : (req.body?.dealId || null);
  try {
    const result = await withTenant(locationId, async (client) => {
      const { rows: [appt] } = await client.query(
        `SELECT appointment_id, contact_id, event_kind, created_at_ghl, starts_at
           FROM appointments
          WHERE location_id = $1 AND appointment_id = $2 AND deleted_at IS NULL`,
        [locationId, appointmentId]
      );
      if (!appt) return { status: 404, error: 'That appointment no longer exists' };
      if (appt.event_kind === 'blocked') return { status: 400, error: 'Blocked time is not linked to deals' };

      if (auto) {
        // Work the automatic link out NOW, the same way the webhook writer
        // does. Only unpinning left the hand-made choice on screen until the
        // next sync — found live: "Deal will follow the automatic link again"
        // over a card still showing no deal. NULL is a real answer here (two
        // open deals is a decline, by the agreed rule), not "keep the old one".
        const { opportunityId } = await deriveOpportunityId(
          locationId, appt.contact_id, appt.created_at_ghl || appt.starts_at || new Date()
        );
        await client.query(
          `UPDATE appointments
              SET opportunity_pinned = false, opportunity_id = $3, updated_at = now()
            WHERE location_id = $1 AND appointment_id = $2`,
          [locationId, appointmentId, opportunityId]
        );
        let deal = null;
        if (opportunityId) {
          const { rows: [o] } = await client.query(
            `SELECT opportunity_id, name, monetary_value, currency FROM opportunities
              WHERE location_id = $1 AND opportunity_id = $2`,
            [locationId, opportunityId]
          );
          deal = o || null;
        }
        return {
          ok: true,
          pinned: false,
          deal: deal && {
            id: deal.opportunity_id,
            name: deal.name,
            value: deal.monetary_value == null ? null : Number(deal.monetary_value),
            currency: deal.currency || null
          }
        };
      }

      let deal = null;
      if (dealId) {
        if (!appt.contact_id) {
          return { status: 400, error: 'This appointment has no customer, so it cannot be linked to a deal', field: 'dealId' };
        }
        // Only a deal the customer is on — the picker offers nothing else,
        // and the server must not trust that it did.
        const { rows } = await client.query(
          `SELECT o.opportunity_id, o.name, o.monetary_value, o.currency
             FROM opportunities o
            WHERE o.location_id = $1 AND o.opportunity_id = $2
              AND o.is_deleted = false AND o.deleted_at IS NULL
              AND (o.contact_id = $3 OR EXISTS (
                    SELECT 1 FROM opportunity_contacts oc
                     WHERE oc.location_id = o.location_id
                       AND oc.opportunity_id = o.opportunity_id
                       AND oc.contact_id = $3))`,
          [locationId, dealId, appt.contact_id]
        );
        deal = rows[0] || null;
        if (!deal) return { status: 422, error: 'That deal is not on this customer', field: 'dealId' };
      }

      await client.query(
        `UPDATE appointments
            SET opportunity_id = $3, opportunity_pinned = true, updated_at = now()
          WHERE location_id = $1 AND appointment_id = $2`,
        [locationId, appointmentId, dealId]
      );
      return {
        ok: true,
        pinned: true,
        deal: deal && {
          id: deal.opportunity_id,
          name: deal.name,
          value: deal.monetary_value == null ? null : Number(deal.monetary_value),
          currency: deal.currency || null
        }
      };
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field || null });
    res.json(result);
  } catch (err) {
    logger.error({ err, locationId, appointmentId }, 'PUT /api/appointments/:id/deal failed');
    next(err);
  }
});

// ── Custom object records, through the customer ───────────────────────
//
// An appointment is not an object GHL's associations can point at, so the
// records "on a booking" are the records linked to its CUSTOMER — the same
// ones GHL's own contact page lists. See services/ghlCustomObjects.js.

const RECORD_SCOPES_MESSAGE = 'This app cannot read or link custom object records yet — '
  + 'it needs the objects and associations permissions (objects/schema.readonly, '
  + 'objects/record.readonly, associations.readonly, associations/relation.readonly, '
  + 'associations/relation.write). They have to be added while the app is in draft, '
  + 'then reauthorised.';

function sendRecordError(res, next, err, what, ctx) {
  if (err?.code === 'GHL_SCOPE_MISSING') {
    return res.status(403).json({ error: RECORD_SCOPES_MESSAGE, reason: 'scope_missing' });
  }
  if (err instanceof AssociationError) {
    return res.status(err.status || 422).json({
      error: err.message, field: err.field || null, reason: err.reason || null
    });
  }
  logger.error({ err, ...ctx }, `${what} failed`);
  return next(err);
}

// The appointment's customer, or a reason there is none.
async function appointmentCustomer(locationId, appointmentId) {
  return withTenant(locationId, async (client) => {
    const { rows: [a] } = await client.query(
      `SELECT contact_id, event_kind FROM appointments
        WHERE location_id = $1 AND appointment_id = $2 AND deleted_at IS NULL`,
      [locationId, appointmentId]
    );
    if (!a) return { status: 404, error: 'That appointment no longer exists' };
    if (a.event_kind === 'blocked') return { status: 400, error: 'Blocked time has no customer' };
    if (!a.contact_id) return { status: 400, error: 'This appointment has no customer' };
    return { contactId: a.contact_id };
  });
}

async function installOr409(locationId, res) {
  const install = await getActiveInstall(locationId);
  if (install) return install;
  const why = await explainInactiveInstall(locationId);
  res.status(409).json({ error: userMessage(why) });
  return null;
}

// GET /api/appointments/records/search?objectKey=&q=
// Declared before /:id/records — Express matches in order, and this path is
// two segments, so it never collides, but keeping it first says so.
appointmentsRouter.get('/records/search', async (req, res, next) => {
  const locationId = req.locationId;
  const objectKey = (req.query.objectKey || '').toString();
  const q = (req.query.q || '').toString().slice(0, 100);
  if (!objectKey.startsWith('custom_objects.')) {
    return res.status(400).json({ error: 'Choose a record type', field: 'objectKey' });
  }
  try {
    const install = await installOr409(locationId, res);
    if (!install) return;
    const { schemas } = await linkableObjects(install);
    const schema = schemas.find((s) => s.key === objectKey);
    if (!schema) return res.status(400).json({ error: 'That record type cannot be linked to a customer', field: 'objectKey' });
    res.json({ records: await searchRecords(install, objectKey, q, schema) });
  } catch (err) {
    sendRecordError(res, next, err, 'GET /api/appointments/records/search', { locationId, objectKey });
  }
});

// GET /api/appointments/:id/records
//   → { objects: [{ key, singular, plural }], records: [{ relationId, objectKey, objectLabel, id, label }] }
appointmentsRouter.get('/:id/records', async (req, res, next) => {
  const locationId = req.locationId;
  const appointmentId = req.params.id;
  try {
    const who = await appointmentCustomer(locationId, appointmentId);
    if (!who.contactId) return res.status(who.status).json({ error: who.error });
    const install = await installOr409(locationId, res);
    if (!install) return;
    const linkable = await linkableObjects(install);
    const records = await recordsForContact(install, who.contactId, linkable);
    res.json({
      objects: linkable.schemas.map(({ key, singular, plural }) => ({ key, singular, plural })),
      records
    });
  } catch (err) {
    sendRecordError(res, next, err, 'GET /api/appointments/:id/records', { locationId, appointmentId });
  }
});

// POST /api/appointments/:id/records  { objectKey, recordId }
appointmentsRouter.post('/:id/records', async (req, res, next) => {
  const locationId = req.locationId;
  const appointmentId = req.params.id;
  const objectKey = (req.body?.objectKey || '').toString();
  const recordId = (req.body?.recordId || '').toString();
  if (!objectKey) return res.status(400).json({ error: 'Choose a record type', field: 'objectKey' });
  if (!recordId) return res.status(400).json({ error: 'Choose a record', field: 'recordId' });
  try {
    const who = await appointmentCustomer(locationId, appointmentId);
    if (!who.contactId) return res.status(who.status).json({ error: who.error });
    const install = await installOr409(locationId, res);
    if (!install) return;
    const { associations } = await linkableObjects(install);
    const assoc = associations.find((a) => a.objectKey === objectKey);
    if (!assoc) return res.status(400).json({ error: 'That record type cannot be linked to a customer', field: 'objectKey' });
    await linkRecord(install, assoc, who.contactId, recordId);
    res.status(201).json({ ok: true });
  } catch (err) {
    sendRecordError(res, next, err, 'POST /api/appointments/:id/records', { locationId, appointmentId, objectKey });
  }
});

// DELETE /api/appointments/:id/records/:relationId
appointmentsRouter.delete('/:id/records/:relationId', async (req, res, next) => {
  const locationId = req.locationId;
  const appointmentId = req.params.id;
  const relationId = req.params.relationId;
  try {
    const who = await appointmentCustomer(locationId, appointmentId);
    if (!who.contactId) return res.status(who.status).json({ error: who.error });
    const install = await installOr409(locationId, res);
    if (!install) return;
    // Only a relation that is actually on THIS customer — re-read rather than
    // trusting the id, so one booking's dialog cannot unlink another's.
    const linkable = await linkableObjects(install);
    const records = await recordsForContact(install, who.contactId, linkable);
    if (!records.some((r) => r.relationId === relationId)) {
      return res.status(404).json({ error: 'That link is not on this customer' });
    }
    await unlinkRecord(install, relationId);
    res.json({ ok: true });
  } catch (err) {
    sendRecordError(res, next, err, 'DELETE /api/appointments/:id/records', { locationId, appointmentId });
  }
});

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
