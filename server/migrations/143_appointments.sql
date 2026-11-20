-- 143_appointments.sql
--
-- GHL appointments. One row per (location_id, appointment_id).
--
-- The operations calendar needs exactly one thing Deal Hub has never held:
-- the appointment. Deal, contact, owner and value are all here already, so
-- this table plus the joins it carries IS the calendar's data model.
--
-- Populated by webhooks (appointmentWriter.js):
--   - AppointmentCreate → INSERT, opportunity derived via the contact
--   - AppointmentUpdate → UPSERT, every mutable field assigned outright
--   - AppointmentDelete → soft delete, stamp deleted_at
--
-- and reconciled nightly (appointmentsSync.js) for what webhooks drop and
-- for the things GHL never pushes at all — see BLOCKED TIME below.
--
-- ── HIGHLEVEL REMAINS THE SYSTEM OF RECORD ───────────────────────────
--
-- Reps connect Google and Outlook inside HighLevel, which already syncs
-- both ways. This table is a MIRROR, not a second source of truth, and the
-- calendar UI reads it rather than calling HighLevel on render. Anything
-- the app changes goes out through the GHL write path and comes back
-- through these same webhooks, the way contacts already work.
--
-- ── THE ID FIELD IS NOT WHAT EVERY OTHER OBJECT USES ─────────────────
--
-- Worth stating in the schema because it has already caught us reading the
-- docs: the webhook carries the id at `appointment.id`. NOT `appointmentId`,
-- and NOT a top-level `id` like opportunity and contact events use. The
-- payload is `{ type, locationId, appointment: { id, ... } }` and nothing
-- useful is at the top level besides the type and the location.
--
-- ── WHY appointment_status AND deleted_at ARE SEPARATE COLUMNS ───────
--
-- `tasks` folds both into one `status` ('open' | 'completed' | 'deleted'),
-- which works there because GHL's task state really is a single axis.
--
-- Appointments have two independent ones. GHL's own `appointmentStatus` is
-- confirmed / cancelled / showed / noshow / invalid — the BOOKING's state,
-- which the calendar renders as colour and which a rep changes all day. Our
-- deleted_at is whether the record still exists at all. A cancelled
-- appointment is not deleted; it still occupies its slot in the diary and
-- the client explicitly wants to see it there.
--
-- Collapsing them would make "cancelled" and "removed from HighLevel"
-- indistinguishable, and the calendar cannot draw a row it cannot tell
-- apart from a deletion. So: appointment_status holds GHL's word VERBATIM
-- (no normalising — a value we have not seen before must survive to the UI
-- rather than be mapped onto the nearest one we know), deleted_at holds
-- ours, and "live" means deleted_at IS NULL.
--
-- The documented set is not published as an enum anywhere, only as the
-- example value "confirmed", so no CHECK constraint: a constraint on a set
-- GHL has not committed to would reject real appointments.
--
-- ── BLOCKED TIME ─────────────────────────────────────────────────────
--
-- A rep blocking travel or admin out of their diary creates a calendar
-- event that is NOT an appointment. HighLevel's webhook documentation does
-- not mention blocked slots anywhere — there is no BlockedSlotCreate event
-- listed, and the three Appointment events say nothing about them.
--
-- We therefore assume NO WEBHOOK FIRES for blocked time and catch it in the
-- nightly reconcile instead, which reads the calendar-events endpoint and
-- sees both kinds. event_kind is what tells them apart once they are here.
--
-- This assumption is unverified against a live sub-account and is the first
-- thing to test. If blocked slots DO fire an appointment webhook, the only
-- change needed is that appointmentWriter starts setting event_kind — the
-- column is already here and the UI already filters on it.
--
-- 'appointment' is the default because the webhook path only ever produces
-- appointments; a row that arrives without anyone deciding is one.
--
-- ── TIMEZONES ────────────────────────────────────────────────────────
--
-- startTime and endTime arrive as ISO 8601 WITH a UTC offset
-- ("2023-09-25T16:00:00+05:30"), so TIMESTAMPTZ stores the correct instant
-- without any parsing of our own. That is the easy half.
--
-- The hard half is that an instant is not enough to draw a calendar. "9am"
-- is a fact about a place, and a HighLevel calendar carries its own
-- timezone which is not necessarily the sub-account's and is definitely not
-- the viewer's browser. So calendar_timezone records the IANA zone the
-- booking was made in, enriched from the calendar, and rendering resolves a
-- zone ONCE rather than through scattered date construction.
--
-- NULL means we have not been able to read the calendar yet, and the reader
-- falls back to the location's zone. It is deliberately not defaulted to
-- anything: a guessed zone that is wrong by an hour is worse than a known
-- absence, because nothing downstream can tell it was guessed.

CREATE TABLE IF NOT EXISTS appointments (
  location_id         TEXT NOT NULL,
  appointment_id      TEXT NOT NULL,                  -- appointment.id — NOT appointmentId

  -- Where it lives in HighLevel.
  calendar_id         TEXT,
  calendar_timezone   TEXT,                           -- IANA zone of the calendar; NULL = not yet read
  group_id            TEXT,

  -- Who it is with.
  contact_id          TEXT,
  opportunity_id      TEXT,                           -- derived through the contact; NULL when ambiguous

  -- Who is doing it.
  assigned_user_id    TEXT,                           -- GHL user id
  assigned_user_name  TEXT,                           -- resolved from users, as tasks.assigned_to_name is
  user_ids            TEXT[],                         -- appointment.users — every attendee, not just the owner

  -- What it is.
  event_kind          TEXT NOT NULL DEFAULT 'appointment',  -- 'appointment' | 'blocked'
  title               TEXT,
  address             TEXT,                           -- a place or a meeting URL; GHL does not distinguish
  notes               TEXT,
  appointment_status  TEXT,                           -- GHL's word, verbatim
  source              TEXT,                           -- e.g. 'booking_widget'

  -- When.
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,

  raw_appointment     JSONB,                          -- full payload, for fields we have not promoted
  from_backfill       BOOLEAN NOT NULL DEFAULT false,
  created_at_ghl      TIMESTAMPTZ,                    -- appointment.dateAdded
  updated_at_ghl      TIMESTAMPTZ,                    -- appointment.dateUpdated
  deleted_at          TIMESTAMPTZ,                    -- set on AppointmentDelete
  imported_at         TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),

  PRIMARY KEY (location_id, appointment_id),

  -- Same shape as tasks: contact and opportunity are both nullable and both
  -- FK-checked. appointmentWriter stubs the contact first (contactStub.js)
  -- because an AppointmentCreate can beat its ContactCreate, exactly as a
  -- TaskCreate can.
  FOREIGN KEY (location_id, contact_id)     REFERENCES contacts (location_id, contact_id),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);

COMMENT ON COLUMN appointments.appointment_id IS
  'GHL appointment id, read from appointment.id on the webhook payload — not '
  'appointmentId, and not the top-level id that opportunity and contact '
  'events use. Different from every other object in this schema.';

COMMENT ON COLUMN appointments.event_kind IS
  '''appointment'' for a booking with a customer, ''blocked'' for time a rep '
  'has blocked out. Blocked slots are believed to fire no webhook at all, so '
  'they can only arrive through the nightly reconcile; the webhook path '
  'always writes ''appointment''.';

COMMENT ON COLUMN appointments.appointment_status IS
  'GHL''s appointmentStatus, stored verbatim — confirmed / cancelled / '
  'showed / noshow / invalid are the values seen, but the set is not '
  'published, so unrecognised values pass through unchanged rather than '
  'being mapped onto the nearest known one. Orthogonal to deleted_at: a '
  'cancelled appointment still exists and still shows in the diary.';

COMMENT ON COLUMN appointments.calendar_timezone IS
  'IANA timezone of the HighLevel calendar this was booked on. starts_at is '
  'an unambiguous instant; this is what makes it renderable as a time of '
  'day. NULL means the calendar has not been read yet — readers fall back '
  'to the location timezone and must never assume the browser''s.';

COMMENT ON COLUMN appointments.opportunity_id IS
  'Derived through the contact, the way deal tags are fanned out in '
  'migration 134 — GHL has no appointment-to-opportunity link. NULL when '
  'the contact has no open deal OR when it has more than one and the choice '
  'would be a guess. Readers must treat NULL as "unknown", never as "no '
  'deal".';

-- Query shapes the calendar actually issues:
--   "everything in this week"                  (location_id, starts_at)
--   "this person's week"                       (location_id, assigned_user_id, starts_at)
--   "this deal's appointments"                 (location_id, opportunity_id)
--   "this contact's appointments"              (location_id, contact_id)
--
-- Every one of them is partial on deleted_at IS NULL, because the calendar
-- never draws deleted rows and the deleted half is dead weight on writes.
-- The week query is the one that runs on every render, so it leads.
CREATE INDEX IF NOT EXISTS appointments_loc_starts
  ON appointments (location_id, starts_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS appointments_loc_user_starts
  ON appointments (location_id, assigned_user_id, starts_at)
  WHERE deleted_at IS NULL AND assigned_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_loc_opp
  ON appointments (location_id, opportunity_id)
  WHERE deleted_at IS NULL AND opportunity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_loc_contact
  ON appointments (location_id, contact_id)
  WHERE deleted_at IS NULL AND contact_id IS NOT NULL;

-- The reconcile asks "what do we hold on this calendar in this window", so
-- it reads by calendar rather than by person. Not partial on deleted_at:
-- the sweep has to see soft-deleted rows to bring one back if it reappears
-- in GHL, which is the same reason tasksSync's upsert clears deleted_at.
CREATE INDEX IF NOT EXISTS appointments_loc_calendar_starts
  ON appointments (location_id, calendar_id, starts_at)
  WHERE calendar_id IS NOT NULL;

-- RLS scoped by location, as every other tenant table is.
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON appointments;
CREATE POLICY tenant_iso ON appointments USING (location_id = current_setting('app.location_id', true));
