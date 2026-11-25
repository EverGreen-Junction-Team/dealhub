// appointmentWriter.js — handles AppointmentCreate / AppointmentUpdate /
// AppointmentDelete webhooks. Writes to `appointments` (migration 143).
//
// Design, and where it differs from taskWriter:
//
//   AppointmentCreate → INSERT. The deal is derived through the contact,
//                       because GHL has no appointment↔opportunity link of
//                       any kind (no relation, no field, no association).
//   AppointmentUpdate → UPSERT. This event DOES exist, unlike TaskUpdate,
//                       which is why there is no echo-applying write path
//                       here: a reschedule comes back to us on its own.
//   AppointmentDelete → soft delete. The row stays so the calendar can tell
//                       "removed" from "cancelled" (migration 143 explains
//                       why those are two columns).
//
// PAYLOAD SHAPE — the one that is not like the others:
//
//   { type, locationId, appointment: { id, address, title, calendarId,
//     contactId, groupId, appointmentStatus, assignedUserId, users[],
//     notes, source, startTime, endTime, dateAdded, dateUpdated } }
//
// The id is `appointment.id`. Not `appointmentId`, not a top-level `id`.
// Every other object in this app puts its id at the top level, so reading
// this one the familiar way yields undefined and silently drops the event.
//
// BLOCKED TIME is not handled here. HighLevel's webhook docs do not mention
// blocked slots at all, so we assume none of these three events fire for
// them and let appointmentsSync pick them up nightly. Everything this file
// writes is therefore event_kind = 'appointment'.

import { rawQuery } from '../db.js';
import { ensureContactExists } from './contactStub.js';
import { resolveOppForContact } from './attributionEngine.js';
import { fetchCalendarTimezone } from './calendarInfo.js';
import { logger } from '../utils/logger.js';

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pull the appointment out of the envelope.
 *
 * `event.appointment` is where the documented payload puts it. The flat
 * fallback is not speculative tidiness: GHL has shipped both nested and flat
 * shapes for other objects (opportunity events arrive either way, which is
 * why routes/webhooks.js reads `event.opportunity?.id || event.opportunityId`),
 * and a flat appointment payload would otherwise be dropped with no id.
 */
function appointmentBody(event) {
  const a = event?.appointment;
  return (a && typeof a === 'object') ? a : (event || {});
}

// Exported for the trap test. Reading the id out of this payload is the one
// thing about appointments that is unlike every other object here, so it is
// worth being able to assert directly rather than only through a handler
// that also needs a database and a GHL token.
export function pickAppointmentFields(event) {
  const a = appointmentBody(event);
  return {
    // THE TRAP. `a.id` first, because that is what the docs show. The other
    // two are tolerated rather than expected.
    appointmentId: a.id || a.appointmentId || a._id || null,
    calendarId: a.calendarId || null,
    groupId: a.groupId || null,
    contactId: a.contactId || null,
    assignedUserId: a.assignedUserId || null,
    // Every attendee, not just the owner. A survey with a fitter shadowing
    // occupies both diaries, and a per-person board has to draw it twice.
    userIds: Array.isArray(a.users)
      ? a.users.filter((u) => typeof u === 'string' && u)
      : null,
    title: a.title || null,
    address: a.address || null,
    // GHL has two free-text fields: `notes` (read-only on the API) and
    // `description`, which is the only one Create/Update can write — and
    // what our booking card's "Internal notes" box sends. Storing only
    // `notes` meant a note typed into this app was saved in the CRM and
    // never seen in this app again. Found by booking one on the live
    // board. One column, whichever field carries text.
    notes: a.notes || a.description || null,
    // Verbatim — see migration 143. No normalising, no lowercasing: an
    // unrecognised status must reach the UI as itself.
    appointmentStatus: a.appointmentStatus || null,
    source: a.source || null,
    startsAt: toTimestamp(a.startTime),
    endsAt: toTimestamp(a.endTime),
    createdAtGhl: toTimestamp(a.dateAdded),
    updatedAtGhl: toTimestamp(a.dateUpdated),
    raw: event
  };
}

/**
 * Owner's display name from our own `users` table.
 *
 * Same contract as taskWriter.resolveAssignedToName: NULL when the user is
 * not here yet, filled by the next UserUpdate or the nightly usersSync. The
 * nightly job runs users BEFORE the object syncs precisely so this resolves
 * on the same pass.
 */
async function resolveAssignedUserName(locationId, userId) {
  if (!userId) return null;
  const { rows } = await rawQuery(
    `SELECT name FROM users WHERE location_id = $1 AND user_id = $2 LIMIT 1`,
    [locationId, userId]
  );
  return rows[0]?.name || null;
}

/**
 * Which deal this appointment belongs to, or NULL.
 *
 * GHL HAS NO LINK TO READ. An appointment carries a contactId and nothing
 * else about the pipeline, so the only route to a deal is the one migration
 * 134 took for tags: go through the contact.
 *
 * resolveOppForContact is the engine messages, tasks and notes already use,
 * so an appointment lands on the same deal those did rather than on a
 * second opinion. It answers 'mapped' only when the contact has exactly one
 * open deal; 'excluded_multi_open' and 'ambiguous' mean it declined.
 *
 * WE TAKE THE DECLINE. A contact with two open deals gets NULL, not the
 * earlier/larger/nearer one — a wrong deal on a booking is worse than no
 * deal, because the calendar would show a surveyor visiting about the wrong
 * job and nothing on screen would say it was inferred. NULL reads as
 * "unknown" and the UI can ask.
 */
async function deriveOpportunityId(locationId, contactId, atTimestamp) {
  if (!contactId) return { opportunityId: null, decision: null };
  const decision = await resolveOppForContact(locationId, contactId, atTimestamp);
  return {
    opportunityId: decision?.mappingStatus === 'mapped' ? decision.opportunityId : null,
    decision
  };
}

/**
 * The shared write for Create and Update.
 *
 * ONE statement for both events, deliberately. The two payloads are
 * identical in shape, GHL redelivers, and webhooks arrive out of order — an
 * Update can land before the Create it follows. A separate INSERT-only
 * create path would drop that Update on the floor; this one simply inserts
 * the row from whichever arrived first.
 *
 * Mutable fields are ASSIGNED, not COALESCEd. The whole purpose of
 * AppointmentUpdate is that a rep cleared the notes, moved the time or
 * cancelled it — COALESCE would make every field write-once and the
 * reschedule would appear to save and then revert, which is the exact bug
 * tasksSync's own comment warns about.
 *
 * The exceptions are the two derived columns, and they are exceptions for
 * the same reason: an enrichment that FAILED this time must not erase one
 * that succeeded last time. A missing calendar timezone means the scope was
 * unavailable for a moment, not that the calendar moved to UTC.
 */
async function upsertAppointment(locationId, a, { calendarTimezone, assignedUserName, opportunityId }) {
  await rawQuery(
    `INSERT INTO appointments (
       location_id, appointment_id,
       calendar_id, calendar_timezone, group_id,
       contact_id, opportunity_id,
       assigned_user_id, assigned_user_name, user_ids,
       event_kind, title, address, notes, appointment_status, source,
       starts_at, ends_at,
       raw_appointment, from_backfill,
       created_at_ghl, updated_at_ghl,
       imported_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'appointment',$11,$12,$13,$14,$15,$16,$17,$18,false,$19,$20, now(), now()
     )
     ON CONFLICT (location_id, appointment_id) DO UPDATE SET
       calendar_id        = COALESCE(EXCLUDED.calendar_id, appointments.calendar_id),
       -- Enrichment: keep what we have when this pass could not read it.
       calendar_timezone  = COALESCE(EXCLUDED.calendar_timezone, appointments.calendar_timezone),
       group_id           = COALESCE(EXCLUDED.group_id, appointments.group_id),
       contact_id         = COALESCE(EXCLUDED.contact_id, appointments.contact_id),
       -- Derived: a newly successful derivation wins, a failed one keeps the
       -- existing answer. Never blanked by a pass that merely declined.
       opportunity_id     = COALESCE(EXCLUDED.opportunity_id, appointments.opportunity_id),
       -- Reassignment is a real edit and the main thing a dispatcher does,
       -- so this is assigned outright. The NAME is COALESCEd behind it only
       -- so an unknown user does not blank a name we already resolved.
       assigned_user_id   = EXCLUDED.assigned_user_id,
       assigned_user_name = COALESCE(EXCLUDED.assigned_user_name, appointments.assigned_user_name),
       -- null (not []) when the payload carried no users array at all —
       -- absence is no information, an empty array is "nobody". Same
       -- distinction taskWriter draws for relations, and for the same
       -- reason: treating absent as empty wipes the list on every edit.
       user_ids           = COALESCE(EXCLUDED.user_ids, appointments.user_ids),
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
       -- An appointment that comes back in GHL after being deleted is live
       -- again. tasksSync does the same for tasks; without it a restored
       -- booking would stay invisible forever.
       deleted_at         = NULL,
       updated_at         = now()`,
    [
      locationId, a.appointmentId,
      a.calendarId, calendarTimezone, a.groupId,
      a.contactId, opportunityId,
      a.assignedUserId, assignedUserName, a.userIds,
      a.title, a.address, a.notes, a.appointmentStatus, a.source,
      a.startsAt, a.endsAt,
      a.raw,
      a.createdAtGhl, a.updatedAtGhl
    ]
  );
}

// --- AppointmentCreate / AppointmentUpdate ----------------------------

export async function handleAppointmentUpsert(install, event, eventType) {
  const locationId = install.location_id;
  const a = pickAppointmentFields(event);

  if (!a.appointmentId) {
    // Loud, not debug. The id lives at a path nothing else in this app uses,
    // so "no id" is far more likely to be us reading the payload wrongly
    // than GHL sending a malformed one — and a silent drop here looks
    // exactly like "the webhook never arrived".
    logger.warn(
      { eventType, payloadKeys: Object.keys(event || {}) },
      'appointmentWriter: no appointment id on payload (expected at '
      + 'appointment.id) — dropping'
    );
    return;
  }

  // FK safety: an AppointmentCreate can beat its ContactCreate, and a
  // booking widget creates both in the same breath. Stub so the FK holds;
  // contactsSync fills the real fields in.
  await ensureContactExists(locationId, a.contactId);

  const { opportunityId, decision } = await deriveOpportunityId(
    locationId, a.contactId, a.createdAtGhl || a.startsAt || new Date()
  );

  // Both enrichments in parallel — neither needs the other, and the webhook
  // path is on GHL's retry clock.
  const [calendarTimezone, assignedUserName] = await Promise.all([
    fetchCalendarTimezone(install, a.calendarId),
    resolveAssignedUserName(locationId, a.assignedUserId)
  ]);

  await upsertAppointment(locationId, a, {
    calendarTimezone, assignedUserName, opportunityId
  });

  logger.info(
    {
      locationId, eventType,
      appointmentId: a.appointmentId,
      calendarId: a.calendarId,
      contactId: a.contactId,
      assignedUserId: a.assignedUserId,
      attendees: a.userIds?.length ?? null,
      startsAt: a.startsAt,
      appointmentStatus: a.appointmentStatus,
      opportunityId,
      // Why there is or is not a deal on this booking. 'excluded_multi_open'
      // here is the signal that a contact has several open deals and the
      // calendar will show the appointment unattributed.
      dealRule: decision?.rule || null,
      dealStatus: decision?.mappingStatus || null,
      calendarTimezone
    },
    'appointmentWriter: appointment upserted'
  );
}

// --- AppointmentDelete ------------------------------------------------

export async function handleAppointmentDelete(install, event) {
  const locationId = install.location_id;
  const a = pickAppointmentFields(event);

  if (!a.appointmentId) {
    logger.warn(
      { payloadKeys: Object.keys(event || {}) },
      'appointmentWriter: AppointmentDelete with no appointment id — dropping'
    );
    return;
  }

  // UPDATE-only, like taskWriter's delete. Phantom-inserting a row we have
  // never seen would put an appointment with no time, no person and no
  // customer into the diary — worse than the gap it would be papering over.
  const { rowCount } = await rawQuery(
    `UPDATE appointments
        SET deleted_at      = COALESCE(deleted_at, now()),
            raw_appointment = $3,
            updated_at_ghl  = COALESCE($4, updated_at_ghl),
            updated_at      = now()
      WHERE location_id = $1 AND appointment_id = $2`,
    [locationId, a.appointmentId, a.raw, a.updatedAtGhl]
  );

  if (rowCount === 0) {
    logger.warn(
      { locationId, appointmentId: a.appointmentId },
      'appointmentWriter: AppointmentDelete for unknown appointment — the '
      + 'create was never received'
    );
    return;
  }
  logger.info(
    { locationId, appointmentId: a.appointmentId },
    'appointmentWriter: AppointmentDelete applied'
  );
}
