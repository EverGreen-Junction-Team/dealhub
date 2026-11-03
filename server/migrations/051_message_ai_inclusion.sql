-- 051_message_ai_inclusion.sql
--
-- Per-message "read by the AI" flag — spec §1C.
--
-- The Deal Hub timeline has always rendered an include/exclude checkbox, but
-- `included` was hardcoded true in routes/deals.js and the toggle only ever
-- mutated React state. So the UI promised "answers read only the included
-- messages" while the context builder read everything attributed to the deal.
-- This table makes the toggle real.
--
-- Exclusion-only by design: absence of a row means included. A rep excluding
-- a message is a deliberate act worth recording (with who and why); the
-- default needs no storage, and this way a newly-synced message is included
-- automatically without a backfill.

CREATE TABLE IF NOT EXISTS message_ai_exclusions (
  location_id     TEXT        NOT NULL,
  message_id      TEXT        NOT NULL,
  -- Scoped per opportunity: the same message can be attributed to one deal
  -- and, after a refile, to another. An exclusion decided for one deal
  -- shouldn't silently carry to the other.
  opportunity_id  TEXT        NOT NULL,
  excluded_by     TEXT,
  -- Why it was excluded. Feeds the coverage stamp's unread_reasons ("2
  -- excluded by Ollie") and is a tuning signal like ai_feedback.reason.
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id, message_id)
);

-- The context builder's hot path: "which messages are excluded for this deal".
CREATE INDEX IF NOT EXISTS message_ai_exclusions_loc_opp
  ON message_ai_exclusions (location_id, opportunity_id);

COMMENT ON TABLE message_ai_exclusions IS
  'Messages a rep has excluded from AI reading, per (deal, message). Exclusion-only: no row = included, so new messages default in without a backfill. Read by services/ai/contextBuilder.js and surfaced in the coverage stamp.';

ALTER TABLE message_ai_exclusions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON message_ai_exclusions;
CREATE POLICY tenant_iso ON message_ai_exclusions
  USING (location_id = current_setting('app.location_id', true));
