-- 048_vw_opportunity_effective_tags.sql
--
-- Projects contact-level tags onto each of the contact's opportunities.
--
-- Why this exists: GHL's data model is contact-scoped for tags. There is no
-- opportunity-level tag API — no tags[] field on the opportunity object, no
-- webhook for opportunity tags. But in the product, a tag applied to a
-- contact IS considered to reach that contact's opportunities. So the
-- "opportunity's tags" question is answerable via the contact join, not via
-- a separate opp-tag table.
--
-- One row per (opportunity_id, tag session). Includes both active and
-- historical tag sessions so downstream consumers can filter as they need.
--
-- Downstream filtering guide:
--   • current tags on an opp                 → WHERE removed_at IS NULL
--   • tags applied WHILE this opp was open   → WHERE tag_applied_after_opp_created
--   • historical tag snapshot at a moment T  → WHERE applied_at <= T
--                                                AND (removed_at IS NULL OR removed_at > T)
--
-- Edge cases:
--   • Contact has 2+ open opps (real duplicates): tag lands on ALL of them.
--     Correct at the model level — that's how GHL treats it too.
--   • Historical tags on won/lost opps: tag applied years ago still shows
--     when a new opp is opened for the same contact. Filter with
--     tag_applied_after_opp_created if that's a problem for your analysis.
--
-- SECURITY INVOKER — base tables (contact_tags → tag_history, opportunities)
-- carry their own RLS. Anon reads flow through those policies naturally.

DROP VIEW IF EXISTS vw_opportunity_effective_tags;

CREATE VIEW vw_opportunity_effective_tags
  WITH (security_invoker = true) AS
SELECT
  o.location_id,
  o.opportunity_id,
  o.contact_id,
  o.name                                                       AS opportunity_name,
  o.pipeline_name,
  o.current_stage_name,
  o.status                                                     AS opportunity_status,
  o.created_at_ghl                                             AS opportunity_created_at,
  o.won_at,
  o.lost_at,
  o.abandoned_at,

  ct.tag_id,
  ct.tag_name,
  ct.applied_at,
  ct.removed_at,
  ct.detected_via,

  (ct.removed_at IS NULL)                                      AS tag_is_active,

  -- Was the tag applied AFTER the opp was created? Guards against a
  -- long-lived tag on the contact bleeding into a brand-new opp that has
  -- nothing to do with it.
  (
    o.created_at_ghl IS NOT NULL
    AND ct.applied_at >= o.created_at_ghl
  )                                                            AS tag_applied_after_opp_created,

  -- Was the tag active AT ANY POINT during this opp's open lifetime?
  -- Useful for "the deal was in play when the tag applied" attribution.
  (
    ct.applied_at <= COALESCE(o.won_at, o.lost_at, o.abandoned_at, now())
    AND (
      ct.removed_at IS NULL
      OR ct.removed_at >= COALESCE(o.created_at_ghl, o.imported_at)
    )
  )                                                            AS tag_overlapped_opp_lifetime

FROM opportunities o
JOIN contact_tags ct
  ON ct.location_id = o.location_id
 AND ct.contact_id  = o.contact_id

WHERE o.is_deleted = false
  AND o.deleted_at IS NULL
  AND o.is_ghost   = false;

COMMENT ON VIEW vw_opportunity_effective_tags IS
  'Contact tags projected onto opportunities. GHL models tags as contact-scoped; this view exposes them at the opportunity level via the contact join. One row per (opportunity, tag session). tag_is_active = still applied; tag_applied_after_opp_created = tag landed after the opp was opened (excludes historical tag bleed); tag_overlapped_opp_lifetime = tag was active at some point while the opp was open. SECURITY INVOKER.';
