-- 029_rebuild_opportunity_flat_view.sql
--
-- Re-creates vw_opportunity_flat after migration 027 dropped it to allow
-- the checkbox columns (client_type, product_system, product_type,
-- first_contact_method) to change from TEXT to JSONB.
--
-- Same shape as 012 with 3 upgrades:
--   1. Checkbox columns now surface as JSONB (their real type)
--   2. New lifecycle fields exposed: won_at, lost_at, abandoned_at,
--      lost_reason, opportunity_source, forecast_close_date,
--      forecast_probability, why_want / why_buy / why_blocker, currency
--   3. WHERE now uses deleted_at IS NULL alongside is_deleted for consistency

CREATE OR REPLACE VIEW vw_opportunity_flat AS
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

  -- Business label. Extend the CASE as James adds sub-accounts.
  CASE o.location_id
    WHEN 'fJNuIdxGgchGpJ9OoBbk' THEN 'Crittall'
    WHEN 'IFcSg4YvuVlx56msjbdf' THEN 'Bespoke Glazing Design'
    WHEN 'kHcvavc8fEeqkEPTK2T8' THEN 'Veritas Glazing Solutions'
    WHEN 'E0nGtwuWd1cmeoc6ilD1' THEN 'Omnia Glazing'
    ELSE o.location_id
  END                            AS business_name,

  -- source
  o.lead_source_opportunity,
  o.opportunity_source,
  o.first_contact_method,        -- JSONB array
  c.utm_source,
  c.utm_medium,
  c.utm_campaign,
  c.gad_source,
  (c.gclid IS NOT NULL)          AS contact_has_gclid,
  (o.gclid IS NOT NULL)          AS opportunity_has_gclid,
  o.gclid                        AS opportunity_gclid,

  -- product / classification
  o.product_system,              -- JSONB array
  o.product_type,                -- JSONB array
  o.client_type,                 -- JSONB array
  o.postcode,

  -- rep-authored qualification
  o.why_want,
  o.why_buy,
  o.why_blocker,

  -- forecast
  o.forecast_close_date,
  o.forecast_probability,

  -- inquiry
  o.inquiry,
  o.upload_from_enquiry,

  -- stage & conversion
  o.first_stage_name,
  o.current_stage_name,
  o.status,
  cur.entered_at                 AS current_stage_entered_at,
  ROUND(EXTRACT(EPOCH FROM (now() - cur.entered_at)) / 86400.0, 1)
                                 AS days_in_current_stage,
  ROUND(
    EXTRACT(EPOCH FROM (
      CASE WHEN o.status = 'open' THEN now() ELSE o.updated_at END
      - COALESCE(o.created_at_ghl, o.imported_at)
    )) / 86400.0
  , 1)                            AS total_pipeline_age_days,

  -- lifecycle outcomes
  o.won_at,
  o.lost_at,
  o.abandoned_at,
  o.lost_reason,

  -- value
  o.monetary_value,
  o.currency,

  -- timing
  o.created_at_ghl,
  o.updated_at_ghl,
  o.updated_at,
  msg.last_activity_at,
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

LEFT JOIN stage_history cur
  ON cur.location_id    = o.location_id
 AND cur.opportunity_id = o.opportunity_id
 AND cur.current_stage  = true

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
  AND o.deleted_at IS NULL
  AND o.is_ghost   = false;

COMMENT ON VIEW vw_opportunity_flat IS
  'One row per opportunity. All facts a sales analytics query needs (source, product, stage, value, lifecycle, timing, message activity) pre-joined. Checkbox fields are JSONB arrays. Excludes deleted and ghost opps. See migrations 012 + 027 + 029 for evolution.';
