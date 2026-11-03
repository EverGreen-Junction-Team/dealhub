-- 041_vw_opportunity_flat_metrics.sql
--
-- Closes vw_opportunity_flat to 100% of James's CSV spec (Stage 3 · Table 23).
--
-- Adds the 7 remaining metric columns:
--   • whys_present                    Discipline: all 3 whys filled
--   • whys_fresh                      Discipline: whys updated since latest stage entry
--   • has_live_task                   Discipline: at least one open task
--   • overdue_task_count              Discipline: open tasks past due
--   • first_response_sender_type      Attribution: who answered first
--   • first_human_response_minutes    Speed-to-lead (human only)
--   • mapping_coverage_pct            Attribution: % of contact messages mapped
--   • unmapped_message_count          Attribution: ambiguous/unassigned/excluded count
--
-- Also switches the message-activity aggregates to use the current approved
-- message_opportunity_map (spec's "change required" note on rows 32-35).
-- Previously counted via messages.opportunity_id which was materialised —
-- now driven directly by the mapping table for a single source of truth.
--
-- SECURITY INVOKER — base-table RLS applies for anon-key reads.

DROP VIEW IF EXISTS vw_opportunity_flat;

CREATE VIEW vw_opportunity_flat
  WITH (security_invoker = true) AS
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

  CASE o.location_id
    WHEN 'fJNuIdxGgchGpJ9OoBbk' THEN 'Crittall'
    WHEN 'IFcSg4YvuVlx56msjbdf' THEN 'Bespoke Glazing Design'
    WHEN 'kHcvavc8fEeqkEPTK2T8' THEN 'Veritas Glazing Solutions'
    WHEN 'E0nGtwuWd1cmeoc6ilD1' THEN 'Omnia Glazing'
    ELSE o.location_id
  END                            AS business_name,

  -- source attribution
  o.lead_source_opportunity,
  o.opportunity_source,
  o.first_contact_method,
  c.utm_source,
  c.utm_medium,
  c.utm_campaign,
  c.gad_source,
  (c.gclid IS NOT NULL)          AS contact_has_gclid,
  (o.gclid IS NOT NULL)          AS opportunity_has_gclid,
  o.gclid                        AS opportunity_gclid,

  -- product / classification
  o.product_system,
  o.product_type,
  o.client_type,
  o.postcode,

  -- rep-authored qualification
  o.why_want,
  o.why_buy,
  o.why_blocker,

  -- Three Whys discipline (NEW — spec row 38-39)
  (o.why_want IS NOT NULL AND o.why_buy IS NOT NULL AND o.why_blocker IS NOT NULL)
                                 AS whys_present,
  -- whys_fresh = whys updated after the CURRENT stage was entered.
  -- Proxy: whys columns are non-null AND opp updated_at is after cur.entered_at
  -- (any opp update touches updated_at). More precise definition would need
  -- opportunity_field_history — Stage 2 has it, we can refine later.
  (
    o.why_want IS NOT NULL AND o.why_buy IS NOT NULL AND o.why_blocker IS NOT NULL
    AND (cur.entered_at IS NULL OR o.updated_at >= cur.entered_at)
  )                              AS whys_fresh,

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

  -- Speed-to-lead: any outbound (spec-existing)
  ROUND(EXTRACT(EPOCH FROM (msg.first_outbound_at - COALESCE(o.created_at_ghl, o.imported_at))) / 60.0, 1)
                                 AS first_response_minutes,

  -- Speed-to-lead: who answered first (NEW — spec row 43)
  msg.first_outbound_sender_type AS first_response_sender_type,

  -- Speed-to-lead: HUMAN outbound only (NEW — spec row 44)
  ROUND(EXTRACT(EPOCH FROM (msg.first_human_outbound_at - COALESCE(o.created_at_ghl, o.imported_at))) / 60.0, 1)
                                 AS first_human_response_minutes,

  -- Activity aggregates — now driven by message_opportunity_map (spec change
  -- required on rows 32-35). "Mapped" only — excludes ambiguous/unassigned.
  COALESCE(msg.message_count, 0)  AS message_count,
  COALESCE(msg.inbound_count, 0)  AS inbound_count,
  COALESCE(msg.outbound_count, 0) AS outbound_count,
  COALESCE(msg.has_call, false)   AS has_call,

  -- Attribution coverage (NEW — spec rows 36-37)
  -- mapping_coverage_pct = mapped msgs on this opp ÷ contact's total msgs
  ROUND(
    100.0 * COALESCE(msg.message_count, 0)
    / NULLIF(contact_msg.contact_total, 0)
  , 1)                            AS mapping_coverage_pct,
  COALESCE(contact_msg.contact_total, 0) - COALESCE(msg.message_count, 0)
                                 AS unmapped_message_count,

  -- Discipline: tasks (NEW — spec rows 40-41)
  EXISTS (
    SELECT 1 FROM tasks t
     WHERE t.location_id     = o.location_id
       AND t.opportunity_id  = o.opportunity_id
       AND t.status          = 'open'
  )                              AS has_live_task,
  (
    SELECT COUNT(*) FROM tasks t
     WHERE t.location_id     = o.location_id
       AND t.opportunity_id  = o.opportunity_id
       AND t.status          = 'open'
       AND t.due_at IS NOT NULL
       AND t.due_at          < now()
  )::integer                     AS overdue_task_count

FROM opportunities o

LEFT JOIN contacts c
  ON c.location_id = o.location_id
 AND c.contact_id  = o.contact_id

-- Current open stage row for the opp
LEFT JOIN stage_history cur
  ON cur.location_id    = o.location_id
 AND cur.opportunity_id = o.opportunity_id
 AND cur.current_stage  = true

-- Per-opp message aggregates via CURRENT approved mapping (message_opportunity_map)
LEFT JOIN (
  SELECT
    mom.location_id,
    mom.opportunity_id,
    MAX(m.message_timestamp)                                          AS last_activity_at,
    MIN(m.message_timestamp) FILTER (WHERE m.message_direction = 'outbound')
                                                                      AS first_outbound_at,
    MIN(m.message_timestamp) FILTER (
      WHERE m.message_direction = 'outbound' AND m.sender_type = 'user'
    )                                                                 AS first_human_outbound_at,
    -- sender_type of the earliest outbound message
    (
      SELECT m2.sender_type
        FROM message_opportunity_map mom2
        JOIN messages m2
          ON m2.location_id = mom2.location_id
         AND m2.message_id  = mom2.message_id
       WHERE mom2.superseded_at IS NULL
         AND mom2.mapping_status = 'mapped'
         AND mom2.location_id    = mom.location_id
         AND mom2.opportunity_id = mom.opportunity_id
         AND m2.message_direction = 'outbound'
         AND m2.deleted_at IS NULL
       ORDER BY m2.message_timestamp
       LIMIT 1
    )                                                                 AS first_outbound_sender_type,
    COUNT(*)                                                          AS message_count,
    COUNT(*) FILTER (WHERE m.message_direction = 'inbound')           AS inbound_count,
    COUNT(*) FILTER (WHERE m.message_direction = 'outbound')          AS outbound_count,
    bool_or(m.is_call)                                                AS has_call
    FROM message_opportunity_map mom
    JOIN messages m
      ON m.location_id = mom.location_id
     AND m.message_id  = mom.message_id
   WHERE mom.superseded_at IS NULL
     AND mom.mapping_status = 'mapped'
     AND mom.opportunity_id IS NOT NULL
     AND m.deleted_at IS NULL
   GROUP BY mom.location_id, mom.opportunity_id
) msg
  ON msg.location_id    = o.location_id
 AND msg.opportunity_id = o.opportunity_id

-- Contact-total message counts (for coverage %)
LEFT JOIN (
  SELECT
    location_id,
    contact_id,
    COUNT(*) AS contact_total
    FROM messages
   WHERE deleted_at IS NULL
   GROUP BY location_id, contact_id
) contact_msg
  ON contact_msg.location_id = o.location_id
 AND contact_msg.contact_id  = o.contact_id

WHERE o.is_deleted = false
  AND o.deleted_at IS NULL
  AND o.is_ghost   = false;

COMMENT ON VIEW vw_opportunity_flat IS
  'One row per opportunity — 100% of James''s Stage 3 · Table 23 spec. Includes discipline (whys, tasks), attribution coverage, and speed-to-lead metrics (any outbound + human only). Aggregates driven by message_opportunity_map (current approved mapping). SECURITY INVOKER. See migrations 012 + 027 + 029 + 041 for evolution.';
