-- 006_assigned_to_name.sql
--
-- Add human-readable user name alongside assigned_to (GHL user id). Lets the
-- client filter by Sales Manager name without joining a separate users table.
--
-- Populated by the enrichment layer (services/ghlEnrichment.getUserName).
-- Cached per (location, userId) for 1h so we don't hammer GHL on every write.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS assigned_to_name TEXT;

CREATE INDEX IF NOT EXISTS opportunities_loc_assigned_to_name
  ON opportunities (location_id, assigned_to_name);
