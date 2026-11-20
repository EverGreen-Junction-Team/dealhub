// The three things HighLevel's appointment webhooks get wrong, and the
// guards that stop each one from costing us an event.
//
// All three were read off HighLevel's own published webhook documentation
// before any of this was written, and all three are the kind of mistake that
// produces silence rather than an error: an appointment that never appears,
// with nothing in the logs that looks like a failure.
//
//   1. THE ID IS AT appointment.id
//      Not `appointmentId`, and not the top-level `id` that opportunity and
//      contact events use. Every other writer in this app reads the top
//      level. Reading it the familiar way yields undefined, the event is
//      dropped for having no id, and the booking simply never shows up.
//
//   2. THE DOCUMENTED EXAMPLES LIE ABOUT THEIR OWN TYPE
//      The AppointmentUpdate and AppointmentDelete doc pages both show an
//      example payload whose `type` reads "AppointmentCreate" — copied from
//      the Create page and never fixed. Anyone wiring this up from the
//      examples could conclude all three announce themselves as creates.
//      The defence is that create and update share one handler, so either
//      naming lands the same row.
//
//   3. BLOCKED SLOTS ARE NOT IN THE DOCS AT ALL
//      No event is listed for blocked time. We assume none fires and catch
//      it nightly — but a calendar-shaped type we do not handle has to be
//      LOUD, or the assumption can never be disproved.
//
// The payload fixtures below are the documented shape, field for field.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// appointmentWriter imports db.js, which imports config.js, which exits on a
// missing DATABASE_URL. Nothing here opens a connection — the parsing under
// test is pure — so the stubs just get the module graph to load. Same shape
// moduleLoad.test.mjs uses, and ||= so a real environment is left alone.
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';

// Dynamic, so the stubs above are set before config.js is evaluated — a
// static import would be hoisted above them and fail.
const { pickAppointmentFields } = await import('../appointmentWriter.js');

const here = dirname(fileURLToPath(import.meta.url));
const router = readFileSync(join(here, '..', '..', 'routes', 'webhooks.js'), 'utf8');
const sync = readFileSync(join(here, '..', 'appointmentsSync.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// The documented AppointmentCreate payload.
const documented = {
  type: 'AppointmentCreate',
  locationId: '0007BWpSzSwfiuSl0tR2',
  appointment: {
    id: '0007BWpSzSwfiuSl0tR2',
    address: 'https://example.com/meeting',
    title: 'Appointment with CRM Dev team',
    calendarId: 'BqTwX8QFwXzpegMve9EQ',
    contactId: '9NkT25Vor1v4aQatFsv2',
    groupId: '9NkT25Vor1v4aQatFsv2',
    appointmentStatus: 'confirmed',
    assignedUserId: 'YlWd2wuCAZQzh2cH1fVZ',
    users: ['YlWd2wuCAZQzh2cH1fVZ', '9NkT25Vor1v4aQatFsv2'],
    notes: 'Some dummy note',
    source: 'booking_widget',
    startTime: '2023-09-25T16:00:00+05:30',
    endTime: '2023-09-25T17:00:00+05:30',
    dateAdded: '2023-09-20T10:00:00+05:30',
    dateUpdated: '2023-09-21T10:00:00+05:30'
  }
};

console.log('trap 1 — the id is at appointment.id');

t('the id is read from the nested appointment object', () => {
  assert.equal(pickAppointmentFields(documented).appointmentId, '0007BWpSzSwfiuSl0tR2');
});

t('reading it the way every other writer does would have failed', () => {
  // The assertion that gives trap 1 its teeth. There is no `appointmentId`
  // key anywhere in the documented payload, so a writer modelled on
  // taskWriter's `payload.id || payload.taskId` finds nothing.
  assert.equal(documented.appointment.appointmentId, undefined);
  assert.equal(documented.appointmentId, undefined);
});

t('a top-level id does not win over the nested one', () => {
  // The dangerous near-miss: the envelope's own `id` is NOT the appointment.
  // Preferring it would attach every event to the wrong record while looking
  // like it worked.
  const withEnvelopeId = {
    ...documented,
    id: 'envelope-not-the-appointment'
  };
  assert.equal(
    pickAppointmentFields(withEnvelopeId).appointmentId,
    '0007BWpSzSwfiuSl0tR2'
  );
});

t('a flat payload still yields its id', () => {
  // Tolerated, not expected — GHL ships flat and nested shapes for other
  // objects, and a flat appointment would otherwise be dropped id-less.
  const flat = { type: 'AppointmentCreate', locationId: 'loc', ...documented.appointment };
  assert.equal(pickAppointmentFields(flat).appointmentId, '0007BWpSzSwfiuSl0tR2');
});

t('no id at all is null, not undefined noise', () => {
  const empty = { type: 'AppointmentCreate', locationId: 'loc', appointment: {} };
  assert.equal(pickAppointmentFields(empty).appointmentId, null);
});

console.log('fields the calendar needs');

t('times parse to instants, offset honoured', () => {
  const a = pickAppointmentFields(documented);
  // 16:00+05:30 is 10:30 UTC. The offset in the string is what makes
  // TIMESTAMPTZ correct without any zone handling of our own.
  assert.equal(a.startsAt.toISOString(), '2023-09-25T10:30:00.000Z');
  assert.equal(a.endsAt.toISOString(), '2023-09-25T11:30:00.000Z');
});

t('every attendee is kept, not just the owner', () => {
  // A survey with a fitter shadowing occupies both diaries; a per-person
  // board has to draw it twice.
  assert.deepEqual(pickAppointmentFields(documented).userIds, [
    'YlWd2wuCAZQzh2cH1fVZ', '9NkT25Vor1v4aQatFsv2'
  ]);
});

t('an absent users array is null, not an empty list', () => {
  // Absence is no information; an empty array is "nobody". The upsert
  // COALESCEs on this distinction, so collapsing them would wipe the
  // attendee list on every unrelated edit.
  const noUsers = { ...documented, appointment: { ...documented.appointment, users: undefined } };
  assert.equal(pickAppointmentFields(noUsers).userIds, null);
});

t('status is passed through verbatim', () => {
  // No normalising. The documented set is not published, so a value we have
  // not seen has to survive to the UI as itself rather than be mapped onto
  // the nearest one we know.
  const odd = { ...documented, appointment: { ...documented.appointment, appointmentStatus: 'noshow' } };
  assert.equal(pickAppointmentFields(odd).appointmentStatus, 'noshow');
  const unknown = { ...documented, appointment: { ...documented.appointment, appointmentStatus: 'SomethingNew' } };
  assert.equal(pickAppointmentFields(unknown).appointmentStatus, 'SomethingNew');
});

console.log('trap 2 — the docs mislabel update and delete as creates');

t('all three real event types are subscribed', () => {
  for (const type of ['AppointmentCreate', 'AppointmentUpdate', 'AppointmentDelete']) {
    assert.ok(router.includes(`'${type}'`), `${type} is not in APPOINTMENT_TYPES`);
  }
});

t('create and update share one handler, so a mislabelled type still lands', () => {
  // The structural defence against trap 2. Delete is the only branch; if a
  // reschedule arrives announcing itself as "AppointmentCreate" — which is
  // exactly what the docs show — it falls to the same upsert and updates the
  // row it should. A three-way branch on `type` would not survive that.
  const dispatch = router.slice(
    router.indexOf('if (isAppointmentEvent) {'),
    router.indexOf('// ── User events')
  );
  assert.ok(dispatch.length > 100, 'appointment dispatch block not found');
  assert.ok(
    dispatch.includes("eventType === 'AppointmentDelete'"),
    'delete should be the only type branched on'
  );
  assert.ok(
    !dispatch.includes("eventType === 'AppointmentCreate'"),
    'create must not be branched on separately — that is what trap 2 breaks'
  );
  assert.ok(dispatch.includes('handleAppointmentUpsert'));
});

console.log('trap 3 — blocked time is undocumented');

t('a calendar-shaped type we do not handle is logged at warn, not info', () => {
  // So the assumption can be disproved. An unhandled blocked-slot event must
  // not disappear into the generic unrecognised-type line at info level
  // among every other unsubscribed GHL event.
  const guard = router.slice(
    router.indexOf('if (!isOpportunityEvent'),
    router.indexOf('// allowDead: TRUE here')
  );
  assert.ok(/appointment\|calendar\|block/i.test(guard), 'no calendar-shaped type guard');
  assert.ok(guard.includes('logger.warn'), 'the guard must warn, not info');
});

t('the nightly reconcile reads blocked slots as well as appointments', () => {
  // The only path blocked time has, on the current reading of the docs.
  assert.ok(sync.includes('/calendars/blocked-slots'));
  assert.ok(sync.includes('/calendars/events'));
});

t('blocked time never acquires a deal', () => {
  // A rep's holiday attached to whatever job their contact happens to be on
  // would be worse than no attribution at all.
  assert.ok(sync.includes("eventKind === 'appointment' && contactId"));
});

t("a row known to be blocked is never reclassified as a booking", () => {
  // The two endpoints are the only thing that tells the kinds apart. If a
  // blocked slot were ever returned by the appointments endpoint too, the
  // later write would silently turn it into a booking and the time would
  // stop reading as unavailable.
  assert.ok(sync.includes("WHEN appointments.event_kind = 'blocked'"));
});

console.log('delete reconciliation is windowed');

t('the nightly delete pass is confined to the window AND the calendars read', () => {
  // `NOT (appointment_id = ANY(...))` matches everything outside the swept
  // window — which is to say all of next year's diary. Both clauses, plus
  // the shared guard, are what stop a windowed sweep reading as "GHL has
  // nothing".
  const del = sync.slice(sync.indexOf('async function reconcileDeletes'));
  assert.ok(del.includes('starts_at >= $4'), 'window lower bound missing');
  assert.ok(del.includes('starts_at <= $5'), 'window upper bound missing');
  assert.ok(del.includes('calendar_id = ANY($3::text[])'), 'calendar scoping missing');
  assert.ok(del.includes('shouldReconcileDeletes'), 'shared truncation guard missing');
});

console.log(`\n${n} passed, 0 failed`);
