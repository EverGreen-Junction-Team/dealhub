-- 145 — A deal chosen by a person for an appointment, kept.
--
-- appointments.opportunity_id is DERIVED (migration 143): GHL has no
-- appointment-to-opportunity link, so the deal is inferred through the
-- contact, and left NULL when the contact has several open deals. Reps asked
-- to link the deal themselves from the calendar.
--
-- GHL cannot store that link (an appointment is not a valid side of any GHL
-- association — verified against the v3 docs, 25 Nov 2026), so it lives here.
-- `opportunity_pinned` marks a link a person made — including a deliberate
-- "no deal" — so neither the webhook writer nor the nightly sweep overwrites
-- it with a derived guess.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS opportunity_pinned BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN appointments.opportunity_pinned IS
  'True when a person chose opportunity_id (or chose none) in Deal Hub. '
  'Writers must leave opportunity_id alone while this is set. Deal Hub only: '
  'GHL has no field for it.';
