-- 136_initial_enquiry.sql
--
-- The initial enquiry, and every one that came before it.
--
-- ── WHY ──────────────────────────────────────────────────────────────
--
-- A rep opening a deal has no way to see what the customer actually asked
-- for. The conversation is in the timeline, but the FIRST thing they said —
-- the enquiry that created the deal — is in whichever lead source produced
-- it, not on the record.
--
-- GHL gets a `master_initial_enquiry` opportunity custom field, which the
-- lead-source automations write into. We promote it to a column so the Deal
-- Hub can show it without digging through custom_fields JSONB.
--
-- ── WHY TWO COLUMNS ──────────────────────────────────────────────────
--
-- A customer enquires more than once. The automation OVERWRITES
-- master_initial_enquiry each time, so the earlier text is gone from GHL the
-- moment a second enquiry lands — and that history is exactly what tells a
-- rep the scope changed.
--
-- So: master_initial_enquiry holds the CURRENT enquiry, and before it is
-- overwritten the previous value is appended to all_initial_enquiry. The
-- append happens in our writer (stageHistoryWriter.js), on the change itself.
--
-- ── WHY all_ IS OURS ALONE ───────────────────────────────────────────
--
-- Nothing is written back to GHL. A second custom field there would be one
-- more thing for the automation to maintain, and our write to it would fire
-- an OpportunityUpdate webhook that looks exactly like a rep's edit — so the
-- next sync would read our own append back and could append it again.
--
-- ── SHAPE ────────────────────────────────────────────────────────────
--
--   [ { "text": "Need 3 Crittall doors", "seen_at": "2026-10-01T09:12:00Z" },
--     { "text": "Also wants a window",   "seen_at": "2026-10-05T14:03:00Z" } ]
--
-- Oldest first, so reading top to bottom is reading forward in time.
-- seen_at is when WE saw it change, not when the customer sent it: GHL does
-- not tell us the latter, and inventing it would be a date someone could act
-- on and be wrong about.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS master_initial_enquiry TEXT,
  ADD COLUMN IF NOT EXISTS all_initial_enquiry    JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN opportunities.master_initial_enquiry IS
  'The current initial enquiry, from the GHL custom field of the same name. Overwritten by the lead-source automation on each new enquiry.';

COMMENT ON COLUMN opportunities.all_initial_enquiry IS
  'Every PREVIOUS master_initial_enquiry, oldest first, as [{text, seen_at}]. Appended by stageHistoryWriter when the master value changes. Never written to GHL.';

-- Deals that HAVE an enquiry, for the "which deals are missing one" question
-- the Insights tab will ask. Partial: most of the table is NULL early on, and
-- an index over those rows would be larger than the answer it serves.
CREATE INDEX IF NOT EXISTS opportunities_has_enquiry
  ON opportunities (location_id)
  WHERE master_initial_enquiry IS NOT NULL AND master_initial_enquiry <> '';
