-- 012_analytics_views.sql
--
-- Analytics views per James's build spec. Two views, both keyed to
-- (location_id, opportunity_id) so they join 1:1:
--
--   1. vw_opportunity_flat
--      One row per opportunity, all the facts pulled together.
--      Designed for Claude-via-Supabase: no joins required at query time.
--
--   2. vw_opportunity_messages_json
--      One row per opportunity, full ordered conversation as a single
--      JSONB blob. Heavy — only joined to the flat view when feeding a
--      deal to an LLM.
--
-- Both views inherit RLS from the base tables (Postgres views run with the
-- caller's permissions, not the view-owner's, unless created WITH SECURITY
-- DEFINER — which we deliberately don't do).
--
-- Idempotent: CREATE OR REPLACE means re-running this migration is safe.
-- If the column list changes you may need to DROP VIEW first (CREATE OR
-- REPLACE refuses column renames / removals).

-- ─────────────────────────────────────────────────────────────────────────
-- View 1: vw_opportunity_flat — one row per deal, all the facts
-- ─────────────────────────────────────────────────────────────────────────

-- DROP first so re-runs after downstream column-type changes don't fail.
-- CREATE OR REPLACE VIEW refuses to change any column's type; DROP + CREATE
-- avoids that. Migration 029 re-creates the view with JSONB checkbox
-- columns; when this migration re-runs on a fresh clone, it'll get the
-- OLD (TEXT) shape briefly, then 029 replaces it.
DROP VIEW IF EXISTS vw_opportunity_flat;

CREATE VIEW vw_opportunity_flat AS
SELECT
  -- identity & routing
  o.location_id,
  o.opportunity_id,
  o.contact_id,
  o.name                         AS opportunity_name,
  o.pipeline_id,
  o.pipeline_name,
  o.assigned_to,
  o.assigned_to_name             AS owner_name,

  -- Business label. The four location_id values come from the GHL
  -- Marketplace install records — one sub-account per legal entity.
  -- When James adds more sub-accounts later, extend this CASE.
  CASE o.location_id
    WHEN 'fJNuIdxGgchGpJ9OoBbk' THEN 'Crittall'
    WHEN 'IFcSg4YvuVlx56msjbdf' THEN 'Bespoke Glazing Design'
    WHEN 'kHcvavc8fEeqkEPTK2T8' THEN 'Veritas Glazing Solutions'
    WHEN 'E0nGtwuWd1cmeoc6ilD1' THEN 'Omnia Glazing'
    ELSE o.location_id
  END                            AS business_name,

  -- source
  o.lead_source_opportunity,
  o.first_contact_method,
  c.utm_source,
  c.utm_medium,
  c.utm_campaign,
  c.gad_source,
  (c.gclid IS NOT NULL)          AS has_gclid,

  -- product
  o.product_system,
  o.product_type,
  o.client_type,
  o.postcode,

  -- inquiry
  o.inquiry,

  -- stage & conversion
  o.first_stage_name,
  o.current_stage_name,
  o.status,
  cur.entered_at                 AS current_stage_entered_at,
  -- Days since the deal entered its CURRENT stage. NULL if no open
  -- stage_history row (sweeper hasn't caught up, or opp is closed).
  ROUND(EXTRACT(EPOCH FROM (now() - cur.entered_at)) / 86400.0, 1)
                                 AS days_in_current_stage,

  -- Total pipeline age — from lead arrival to "now" if open, or to
  -- updated_at if closed (we don't capture a true closed_at yet).
  -- COALESCE on created_at_ghl with imported_at handles the rare case
  -- where GHL didn't send a creation timestamp.
  ROUND(
    EXTRACT(EPOCH FROM (
      CASE WHEN o.status = 'open' THEN now() ELSE o.updated_at END
      - COALESCE(o.created_at_ghl, o.imported_at)
    )) / 86400.0
  , 1)                            AS total_pipeline_age_days,

  -- value
  o.monetary_value,

  -- timing
  o.created_at_ghl,
  o.updated_at,
  msg.last_activity_at,
  -- First-response speed proxy. NULL when no outbound message exists.
  -- Can read oddly when messages predate the opportunity (e.g. an old
  -- conversation re-opened) — James notes this is v1, directional only.
  ROUND(EXTRACT(EPOCH FROM (msg.first_outbound_at - COALESCE(o.created_at_ghl, o.imported_at))) / 60.0, 1)
                                 AS first_response_minutes,
  COALESCE(msg.message_count, 0)  AS message_count,
  COALESCE(msg.inbound_count, 0)  AS inbound_count,
  COALESCE(msg.outbound_count, 0) AS outbound_count,
  COALESCE(msg.has_call, false)   AS has_call

FROM opportunities o

LEFT JOIN contacts c
  ON c.location_id = o.location_id
 AND c.contact_id  = o.contact_id

-- One open stage row per opportunity (current_stage = true is
-- maintained by the writer as a single-writer invariant).
LEFT JOIN stage_history cur
  ON cur.location_id    = o.location_id
 AND cur.opportunity_id = o.opportunity_id
 AND cur.current_stage  = true

-- Pre-aggregated message metrics. CRITICAL: this is a GROUP BY
-- subquery — never join `messages` directly, or rows multiply and every
-- count breaks.
LEFT JOIN (
  SELECT
    location_id,
    opportunity_id,
    MAX(message_timestamp)                                       AS last_activity_at,
    MIN(message_timestamp) FILTER (WHERE message_direction = 'outbound')
                                                                 AS first_outbound_at,
    COUNT(*)                                                     AS message_count,
    COUNT(*) FILTER (WHERE message_direction = 'inbound')        AS inbound_count,
    COUNT(*) FILTER (WHERE message_direction = 'outbound')       AS outbound_count,
    bool_or(is_call)                                             AS has_call
  FROM messages
  GROUP BY location_id, opportunity_id
) msg
  ON msg.location_id    = o.location_id
 AND msg.opportunity_id = o.opportunity_id

WHERE o.is_deleted = false
  AND o.is_ghost   = false;

COMMENT ON VIEW vw_opportunity_flat IS
  'One row per opportunity. All facts a sales analytics query needs (source, product, stage, value, timing, message activity) pre-joined. Excludes deleted and ghost opps. See migration 012 for column semantics.';


-- ─────────────────────────────────────────────────────────────────────────
-- View 2: vw_opportunity_messages_json — full conversation per opportunity
-- ─────────────────────────────────────────────────────────────────────────
--
-- Heavy. Pull only when you actually want the conversation (LLM feed,
-- one-off "what did the customer say" lookups). Always join on the same
-- (location_id, opportunity_id) key as vw_opportunity_flat.

DROP VIEW IF EXISTS vw_opportunity_messages_json;
CREATE VIEW vw_opportunity_messages_json AS
SELECT
  m.location_id,
  m.opportunity_id,
  COUNT(*) AS message_count,
  jsonb_agg(
    jsonb_build_object(
      'message_id', m.message_id,
      'timestamp',  m.message_timestamp,
      'direction',  m.message_direction,
      'channel',    m.message_channel,
      'body',       m.message_body
    )
    ORDER BY m.message_timestamp
  ) AS messages_json
FROM messages m
WHERE m.opportunity_id IS NOT NULL
GROUP BY m.location_id, m.opportunity_id;

COMMENT ON VIEW vw_opportunity_messages_json IS
  'One row per opportunity. Full ordered conversation (both directions) as a single JSONB blob, ready to feed to an LLM. Keep separate from vw_opportunity_flat — heavy. Join on (location_id, opportunity_id).';
