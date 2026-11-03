-- 021_tag_views.sql
--
-- Two SQL convenience views projected from tag_history:
--   - opportunity_tags: only rows where entity_type = 'opportunity'
--   - contact_tags:     only rows where entity_type = 'contact'
--
-- These are NOT physical tables — no second copy of the data. They exist
-- purely to let analytics queries filter to one entity type without having
-- to remember the WHERE entity_type = '...' clause every time.
--
-- Current tags = removed_at IS NULL.
-- Historical tags = removed_at IS NOT NULL.
-- Full timeline = no filter.
--
-- Per CSV blueprint §3.2 and §3.3.

CREATE OR REPLACE VIEW opportunity_tags AS
SELECT
  entity_id AS opportunity_id,
  tag_id,
  tag_name,
  location_id,
  applied_at,
  removed_at,
  detected_via
FROM tag_history
WHERE entity_type = 'opportunity';

COMMENT ON VIEW opportunity_tags IS
  'One row per (opportunity, tag) session. removed_at IS NULL = currently active. Projected from tag_history where entity_type = opportunity.';


CREATE OR REPLACE VIEW contact_tags AS
SELECT
  entity_id AS contact_id,
  tag_id,
  tag_name,
  location_id,
  applied_at,
  removed_at,
  detected_via
FROM tag_history
WHERE entity_type = 'contact';

COMMENT ON VIEW contact_tags IS
  'One row per (contact, tag) session. removed_at IS NULL = currently active. Projected from tag_history where entity_type = contact.';
