-- 013_ghl_raw.sql
--
-- Forensic archive of every webhook payload GHL sends us. Written to BEFORE
-- any dispatch logic, so even unrecognised event types get captured. Purpose:
--   - Debug new event shapes as we onboard them (Tasks, Users, Relations, etc.)
--   - Audit trail: "did GHL actually send us this?"
--   - Recover from writer bugs without needing GHL to re-emit
--
-- Retention: 30 days rolling. Purged by the same daily cron that trims
-- processed_events. Cheap insurance — a webhook body is a few KB.
--
-- NOT the source of truth for anything. Never read from this table for
-- business logic; that's what the promoted tables are for.

CREATE TABLE IF NOT EXISTS ghl_raw (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT,                             -- event.webhookId (nullable — some events may lack it)
  location_id   TEXT,                             -- nullable — malformed events may lack location
  event_type    TEXT,                             -- TaskCreate / UserUpdate / RelationCreate / etc.
  payload       JSONB NOT NULL,                   -- full req.body
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Common query shapes:
--   "show me every TaskCreate for BGD in the last week"       (loc, type, time)
--   "find the raw payload for this specific webhook delivery" (event_id)
CREATE INDEX IF NOT EXISTS ghl_raw_loc_type_ts ON ghl_raw (location_id, event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS ghl_raw_event_id    ON ghl_raw (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ghl_raw_received_at ON ghl_raw (received_at);

-- Enable RLS but with a permissive read policy (this table is cross-tenant
-- forensics; ops can read everything, no tenant scoping via app.location_id).
ALTER TABLE ghl_raw ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ghl_raw_all ON ghl_raw;
CREATE POLICY ghl_raw_all ON ghl_raw USING (true) WITH CHECK (true);
