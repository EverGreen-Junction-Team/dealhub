// ghlAppointmentWrite.js — push appointment moves, reassignments and
// cancellations to GHL.
//
// Modelled on ghlContactWrite.js rather than ghlTaskWrite.js, and the
// difference is worth stating because it is the whole reason this file is
// short:
//
//   TASKS have no TaskUpdate webhook, so ghlTaskWrite has to apply GHL's
//   echoed task to our row by hand or an edit would appear to save and then
//   vanish on the next render.
//
//   APPOINTMENTS DO have AppointmentUpdate. So this writes to GHL and lets
//   the webhook write Postgres, exactly as contacts work. One path to the
//   row, no second opinion to reconcile.
//
// The echo is still RETURNED to the caller — the route hands it straight to
// the board so a dragged appointment settles into the time GHL actually
// stored rather than the one the browser hoped for — but it is not written
// to the database here. appointmentWriter owns that.
//
// ── THE AI NEVER REACHES THIS FILE ───────────────────────────────────
//
// server/AI_WRITE_FRAMEWORK.md: the model proposes into `ai_actions` and a
// human confirms. These functions are called from rep-driven routes only,
// behind the same confirmation pattern every other write uses. Moving
// somebody's day is not something to do on an inference.
//
// And NOT through the MCP connector, which is a protocol for LLM clients:
// the app already holds this location's OAuth token in `installs`, and
// routing an app write through MCP would step around the confirm-and-audit
// framework entirely.
//
// ── EVERY ENDPOINT IS ON THE EVENT, NOT THE CALENDAR ─────────────────
//
//   PUT    /calendars/events/appointments/{eventId}
//   DELETE /calendars/events/appointments/{eventId}
//
// Scope: `calendars/events.write`. Note that app scopes can only be changed
// while the marketplace app is in DRAFT, unlike webhook subscriptions, which
// can be changed at any time — so a missing scope here is not a five-minute
// fix and the error says so plainly.

import { ghlRequest } from './ghlClient.js';
import { rejectionMessage, logRejection, isSlotUnavailable } from './ghlRejection.js';
import { logger } from '../utils/logger.js';

const enc = encodeURIComponent;

export class AppointmentWriteError extends Error {
  constructor(message, { status = 400, field = null, detail = null, canOverride = false } = {}) {
    super(message);
    this.name = 'AppointmentWriteError';
    this.status = status;
    this.field = field;
    this.detail = detail;
    // True only when GHL refused on availability — a taken slot, or a
    // time outside the calendar's hours — which ignoreFreeSlotValidation
    // gets past. The card offers "Book it anyway" on exactly this.
    this.canOverride = canOverride;
  }
}

/**
 * WHETHER THE CUSTOMER GETS AN EMAIL.
 *
 * GHL's appointment endpoints take `toNotify`, which fires the calendar's
 * configured confirmation and reschedule notifications at the contact.
 *
 * WE DEFAULT IT TO FALSE, EXPLICITLY, ON EVERY CALL.
 *
 * Not because silence is the right policy — it may well not be — but because
 * the two mistakes are not symmetrical. A move that should have emailed the
 * customer and did not can be followed by an email a minute later. A move
 * that emailed fifty customers who should not have heard from us cannot be
 * taken back, and a dispatcher tidying next week's board would have sent
 * every one of them.
 *
 * So it is off until somebody decides it should be on, it is a parameter
 * rather than a constant so that decision is a config change and not a code
 * change, and it is never left to GHL's own default — which is to notify.
 * Omitting the field would make the louder behaviour the one you get by
 * forgetting.
 */
const NOTIFY_CUSTOMER_BY_DEFAULT = false;

/**
 * Map a GHL error onto something a rep can act on.
 *
 * Shared by both operations: the failure modes are the same and the wording
 * should be too.
 */
function translateGhlError(err, { appointmentId = null, verb } = {}) {
  const status = err.response?.status;
  const body = err.response?.data;

  if (status === 401 || status === 403) {
    return new AppointmentWriteError(
      'This app cannot change appointments yet — the calendars/events.write '
      + 'permission is missing. It has to be added while the app is in draft, '
      + 'then reauthorised.',
      { status: 403 }
    );
  }
  if (status === 404) {
    return new AppointmentWriteError(
      'That appointment no longer exists in the CRM — it may have been '
      + 'deleted since this page was loaded.',
      { status: 404 }
    );
  }
  if (status === 422 || status === 400) {
    // The common one here is a slot that breaks the calendar's own
    // availability rules — moving a survey to a Sunday, or on top of
    // something already booked. GHL names the reason and we do not try to
    // improve on it, because the alternative is telling a rep "that did not
    // work" about a rule they could have satisfied.
    const detail = body?.message || body?.error
      || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);
    // Logged, never shown raw — ghlRejection.js explains why: GHL names a
    // field for a validation error but a bare record id for a missing one,
    // and the whole sales team sees these.
    logRejection('ghlAppointmentWrite', { status, id: appointmentId, detail, body });
    const rej = rejectionMessage('appointment', detail);
    return new AppointmentWriteError(rej.message, {
      status: rej.status, detail, canOverride: isSlotUnavailable(detail)
    });
  }
  logger.error(
    { err, status, appointmentId, body },
    `ghlAppointmentWrite: ${verb} failed`
  );
  return new AppointmentWriteError(
    `Could not ${verb} the appointment — try again`,
    { status: 502 }
  );
}

/**
 * Book a new appointment.
 *
 * ── WHAT GHL INSISTS ON ──────────────────────────────────────────────
 *
 * A calendar and a contact. Neither is optional and neither can be
 * sensibly defaulted:
 *
 *   calendarId  an appointment does not exist in the abstract — it exists
 *               on a calendar, and that calendar is what carries the
 *               working hours, the timezone and the notification settings.
 *               Picking one on the rep's behalf would silently choose all
 *               three.
 *   contactId   GHL has no concept of an appointment with nobody. A block
 *               of time with no customer is BLOCKED TIME, which is a
 *               different object on a different endpoint — see the note in
 *               appointmentsSync.js.
 *
 * Both are therefore required here rather than defaulted, and the errors
 * say which is missing rather than letting GHL answer with a 422 about a
 * field the rep never saw.
 *
 * ── WHAT WE DO NOT SEND ──────────────────────────────────────────────
 *
 * No opportunityId. GHL has no appointment-to-deal link to set — the deal
 * is DERIVED through the contact when the webhook lands (migration 143),
 * and it is left NULL when the contact has more than one open deal. So a
 * booking made here against a customer with two live jobs will show on the
 * board without a deal, and that is correct rather than a gap: the
 * alternative is guessing which job the surveyor is visiting about.
 */
export async function createGhlAppointment(install, {
  calendarId, contactId, startTime, endTime, title, address,
  assignedUserId, appointmentStatus, notifyCustomer, ignoreAvailability,
  description
} = {}) {
  if (!calendarId) {
    throw new AppointmentWriteError(
      'Pick a calendar — an appointment has to be booked on one, and the '
      + 'calendar is what sets the working hours and the timezone.',
      { status: 400, field: 'calendarId' }
    );
  }
  if (!contactId) {
    throw new AppointmentWriteError(
      'Pick a customer — your CRM cannot store an appointment without one. '
      + 'To hold time with no customer, block it out in the calendar instead.',
      { status: 400, field: 'contactId' }
    );
  }
  if (!startTime || !endTime) {
    throw new AppointmentWriteError('An appointment needs a start and an end', {
      status: 400, field: startTime ? 'endTime' : 'startTime'
    });
  }

  const body = {
    calendarId,
    locationId: install.location_id,
    contactId,
    startTime,
    endTime,
    // Sent only when given. GHL names an appointment after the calendar's
    // own template when no title is supplied, which is a better default
    // than anything generic we could invent here.
    ...(title ? { title } : {}),
    ...(address ? { address } : {}),
    // ── THE NOTE, AND WHAT GHL WILL ACTUALLY DO WITH IT ───────────
    //
    // `description` is the ONLY free-text field on Create Appointment.
    // Verified against the v3 docs on 25 Nov 2026: the create and
    // update bodies have no `notes` field at all. Get Appointment
    // returns an `event.notes`, but the docs never say how to write
    // it through this route.
    //
    // GHL's own "Internal notes" box is a different thing: a separate
    // resource at POST /calendars/appointments/{id}/notes, capped at
    // 5000 characters, and — per the docs — "stored on the contact".
    // Writing there would need a second call after the appointment
    // exists and would put the text on the customer's record, which is
    // not what "internal" implies to the person typing it.
    //
    // So this lands in the appointment's description, where it is
    // attached to the booking itself and visible on the appointment in
    // GHL. If parity with that box is wanted later it is a second
    // call, not a change to this one.
    ...(description ? { description } : {}),
    ...(assignedUserId ? { assignedUserId } : {}),
    // 'confirmed' unless told otherwise. A booking made deliberately by a
    // dispatcher is confirmed by definition; leaving it unset makes the
    // card render with no status and read as provisional.
    appointmentStatus: appointmentStatus || 'confirmed',
    // Always explicit — see NOTIFY_CUSTOMER_BY_DEFAULT. Booking is the one
    // case where notifying is arguably right (the customer has just agreed
    // to a visit and wants the confirmation), so this is the first place
    // anyone should consider turning it on. It is still off until someone
    // decides that, because the default must not be set by forgetting.
    toNotify: notifyCustomer === true
  };
  if (ignoreAvailability === true) body.ignoreFreeSlotValidation = true;

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: '/calendars/events/appointments',
      data: body
    });
    const created = data?.appointment || data?.event || data || null;
    logger.info(
      {
        locationId: install.location_id,
        appointmentId: created?.id || null,
        calendarId, contactId, assignedUserId: assignedUserId || null,
        notifiedCustomer: body.toNotify === true
      },
      'ghlAppointmentWrite: appointment created'
    );
    return created;
  } catch (err) {
    throw translateGhlError(err, { verb: 'book' });
  }
}

/**
 * Move, reassign or cancel one appointment.
 *
 * Every field is optional: this is a PATCH in spirit, and the board sends
 * only what the rep actually changed. A drag across columns sends an
 * assignedUserId; a drag down a column sends times; cancelling sends a
 * status. Sending the unchanged rest would turn a reassignment into a
 * rewrite of every field, which is how a title gets clobbered by a stale
 * copy the browser was holding.
 *
 * @param {object}  install
 * @param {string}  appointmentId
 * @param {object}  patch
 * @param {string} [patch.startTime]          ISO 8601, offset included
 * @param {string} [patch.endTime]            ISO 8601, offset included
 * @param {string} [patch.assignedUserId]     the rep this moves to
 * @param {string} [patch.appointmentStatus]  e.g. 'cancelled'
 * @param {string} [patch.title]
 * @param {string} [patch.address]
 * @param {boolean}[patch.notifyCustomer]     see NOTIFY_CUSTOMER_BY_DEFAULT
 * @param {boolean}[patch.ignoreAvailability] see below
 * @returns the appointment GHL echoed back
 */
export async function updateGhlAppointment(install, appointmentId, patch = {}) {
  if (!appointmentId) {
    throw new AppointmentWriteError('No appointment was given to update', {
      status: 400, field: 'appointmentId'
    });
  }

  const body = {};
  // Only what was actually passed. `in` rather than a truthiness check: an
  // empty-string address is a deliberate clearing, and `false` is a real
  // value for the flags below.
  for (const key of ['startTime', 'endTime', 'assignedUserId', 'appointmentStatus', 'title', 'address']) {
    if (key in patch && patch[key] !== undefined) body[key] = patch[key];
  }

  if (Object.keys(body).length === 0) {
    throw new AppointmentWriteError('Nothing was changed', { status: 400 });
  }

  // Always sent, never omitted — see NOTIFY_CUSTOMER_BY_DEFAULT.
  body.toNotify = patch.notifyCustomer === true
    ? true
    : (patch.notifyCustomer === false ? false : NOTIFY_CUSTOMER_BY_DEFAULT);

  // THE CALENDAR'S AVAILABILITY RULES ARE RESPECTED BY DEFAULT.
  //
  // GHL's `ignoreFreeSlotValidation` lets a write land on a slot the calendar
  // says is unavailable — outside working hours, or on top of an existing
  // booking. Tempting for a drag-and-drop board, where being refused mid-drag
  // is a genuine irritation.
  //
  // Left FALSE anyway. Those rules are somebody's working day: a calendar
  // that says no Sundays says it because a surveyor does not work Sundays,
  // and an app that quietly overrode it would be booking real people into
  // real time they had said they did not have. The refusal is surfaced with
  // GHL's own reason instead, so the rep can see what rule they hit and
  // decide — which is the difference between a tool and a trap.
  if (patch.ignoreAvailability === true) {
    body.ignoreFreeSlotValidation = true;
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      url: `/calendars/events/appointments/${enc(appointmentId)}`,
      data: body
    });
    const echoed = data?.appointment || data?.event || data || null;
    logger.info(
      {
        locationId: install.location_id,
        appointmentId,
        changed: Object.keys(body).filter((k) => k !== 'toNotify'),
        // Worth its own field in every log line: "did we email the customer"
        // is the question somebody will ask afterwards, and it should be
        // answerable without reconstructing the request body.
        notifiedCustomer: body.toNotify === true
      },
      'ghlAppointmentWrite: appointment updated'
    );
    return echoed;
  } catch (err) {
    throw translateGhlError(err, { appointmentId, verb: 'move' });
  }
}

/**
 * Delete an appointment outright.
 *
 * SEPARATE FROM CANCELLING, and the board should almost always prefer the
 * cancel — `updateGhlAppointment(id, { appointmentStatus: 'cancelled' })`.
 *
 * A cancelled appointment keeps its slot in the diary and its link to the
 * deal: it is the record that somebody was going to visit on Tuesday and
 * then did not, which is exactly the thing a sales operation wants to be
 * able to count. A deleted one is gone, and the afternoon it occupied looks
 * like it was always free.
 *
 * Kept because a genuine mistake — an appointment booked on the wrong
 * account — should be removable, not permanently cancelled.
 */
export async function deleteGhlAppointment(install, appointmentId, { notifyCustomer } = {}) {
  if (!appointmentId) {
    throw new AppointmentWriteError('No appointment was given to delete', {
      status: 400, field: 'appointmentId'
    });
  }
  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/calendars/events/appointments/${enc(appointmentId)}`,
      params: {
        toNotify: notifyCustomer === true ? 'true' : 'false'
      }
    });
    logger.info(
      {
        locationId: install.location_id,
        appointmentId,
        notifiedCustomer: notifyCustomer === true
      },
      'ghlAppointmentWrite: appointment deleted'
    );
    return true;
  } catch (err) {
    throw translateGhlError(err, { appointmentId, verb: 'delete' });
  }
}
