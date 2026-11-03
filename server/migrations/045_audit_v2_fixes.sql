-- 045_audit_v2_fixes.sql
--
-- Applies the fixable findings from the 12–13 Aug 2026 Supabase Audit v2:
--
--   FIX #2 (D2) — first_response_minutes wrongly anchored to deal creation.
--     Deals are typically created from an existing conversation, so
--     created_at_ghl sits after the first inbound. 49% of values were 0,
--     17 were negative, median 0.0 min. Re-anchor to first inbound on the
--     CONTACT (the actual enquiry).
--
--   FIX #3 (D4) — meddic_9 = "9. Deal Lost reason", meddic_10 = "10. Deal
--     Won Reason". Expose them as deal_lost_reason / deal_won_reason with
--     a lostReasonId fallback from raw_opportunity for the 55 lost deals
--     that have an id but no free-text reason.
--
--   FIX #4 (D3) — vw_opportunity_flat and analytics_clean_deals report
--     different deal universes (753 vs 661). Align by adopting the eligible
--     filter here: exclude the Crittall test location, test / marketing
--     pipelines, and any opp whose name marks it as a test.
--
--   FIX #6 (D7) — whys_fresh was computed against o.updated_at, which the
--     sync touches on every write. Re-implement using opportunity_field_history
--     (now populated, 5,263 rows) — only counts freshness when the actual
--     why_* field was edited after the current stage was entered.
--     Also tighten the presence test (empty string no longer counts).
--
-- Adds:
--   • lost_reason_labels lookup table (populate manually from GHL settings)
--   • deal_lost_reason, deal_won_reason, deal_lost_reason_id columns in view
--   • is_eligible flag on the view for downstream filtering
--
-- Non-destructive — rebuilds vw_opportunity_flat with the new definitions.
-- SECURITY INVOKER preserved.

-- ─────────────────────────────────────────────────────────────────────────
-- Lookup table for lostReasonId → human label. GHL doesn't expose a public
-- endpoint for the picklist; populate manually from Settings → Opportunities
-- → Lost Reasons per location. Empty is fine — the view degrades to showing
-- the raw id when the label isn't mapped.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lost_reason_labels (
  location_id     TEXT NOT NULL,
  reason_id       TEXT NOT NULL,
  label           TEXT NOT NULL,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, reason_id)
);

COMMENT ON TABLE lost_reason_labels IS
  'Manual mapping of GHL lostReasonId picklist → human label. No public GHL endpoint exposes this — populate per location from Settings → Opportunities → Lost Reasons. Empty rows are fine; the view degrades to the raw id.';

ALTER TABLE lost_reason_labels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON lost_reason_labels;
CREATE POLICY tenant_iso ON lost_reason_labels
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- FIX #5 — Call capture. is_call was false on 11 of 14 call messages
-- because we compared channel strictly against 'CALL' after uppercasing
-- messageType, missing 'TYPE_CALL' variants. Writer already fixed; here we
-- add the missing recording_url column and one-time backfill flip for the
-- 11 mis-flagged rows.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS recording_url TEXT;

COMMENT ON COLUMN messages.recording_url IS
  'GHL call recording URL when the payload carries it. Fetch on-demand via GET /conversations/messages/{id}/locations/{id}/recording when NULL and is_call=true.';

-- One-time backfill: flip is_call for existing rows that came through with
-- messageType=TYPE_CALL and got missed. Safe re-run — idempotent.
-- (messages has no updated_at column; last_synced_at reflects sync activity
-- and would be misleading to touch here.)
UPDATE messages
   SET is_call = true
 WHERE is_call = false
   AND (
        upper(message_channel) IN ('TYPE_CALL', 'CALL', 'VOICEMAIL')
     OR raw_message->>'messageTypeString' = 'TYPE_CALL'
   );



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

  -- FIX #4 — eligibility flag (matches analytics_clean_deals scope).
  -- Test / marketing / Crittall are STORED (needed for audit), but the flag
  -- lets downstream views scope to real revenue-generating pipeline.
  (
        o.location_id <> 'fJNuIdxGgchGpJ9OoBbk'   -- exclude Crittall (test location)
    AND COALESCE(o.pipeline_name, '') NOT ILIKE '%(Test)%'
    AND COALESCE(o.pipeline_name, '') NOT ILIKE '%James Test%'
    AND COALESCE(o.pipeline_name, '') NOT ILIKE 'Marketing%'
    AND COALESCE(o.name, '')          NOT ILIKE 'test%'
    AND COALESCE(o.name, '')          NOT ILIKE '%test test%'
  )                              AS is_eligible,

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

  -- FIX #6 — Three Whys discipline.
  -- Presence: tighten empty-string check (previous version accepted "").
  (
        o.why_want    IS NOT NULL AND length(btrim(o.why_want))    > 0
    AND o.why_buy     IS NOT NULL AND length(btrim(o.why_buy))     > 0
    AND o.why_blocker IS NOT NULL AND length(btrim(o.why_blocker)) > 0
  )                              AS whys_present,

  -- FIX #6 — whys_fresh derived from opportunity_field_history, not
  -- opportunities.updated_at. A "fresh" why = the field was last edited AFTER
  -- the current stage was entered. Prior version used o.updated_at which the
  -- sync touches on every write — every row looked fresh.
  (
    SELECT
      COUNT(DISTINCT h.field_key) = 3
    FROM opportunity_field_history h
    WHERE h.location_id     = o.location_id
      AND h.opportunity_id  = o.opportunity_id
      AND h.field_key IN ('why_want', 'why_buy', 'why_blocker')
      AND (cur.entered_at IS NULL OR h.changed_at >= cur.entered_at)
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

  -- FIX #3 — Loss / win reasons.
  --   deal_lost_reason: meddic_9 free text if present, else the label from
  --     lost_reason_labels (looked up by raw_opportunity->>'lostReasonId'),
  --     else the raw id itself.
  --   deal_won_reason:  meddic_10.
  --   deal_lost_reason_id: exposed for downstream label reconciliation.
  COALESCE(
    NULLIF(btrim(o.meddic_9), ''),
    lrl.label,
    NULLIF(o.raw_opportunity->>'lostReasonId', '')
  )                                                              AS deal_lost_reason,
  NULLIF(btrim(o.meddic_10), '')                                 AS deal_won_reason,
  NULLIF(o.raw_opportunity->>'lostReasonId', '')                 AS deal_lost_reason_id,

  -- value
  o.monetary_value,
  o.currency,

  -- timing
  o.created_at_ghl,
  o.updated_at_ghl,
  o.updated_at,
  msg.last_activity_at,

  -- FIX #2 — Speed-to-lead: anchor on first INBOUND (enquiry), not deal
  -- creation. Deals are typically created from an existing conversation so
  -- the previous anchor (o.created_at_ghl) sat at or after the enquiry —
  -- 49% zeros, 17 negatives, median 0. See audit v2, D2.
  ROUND(EXTRACT(EPOCH FROM (msg.first_outbound_at - contact_msg.first_inbound_at)) / 60.0, 1)
                                 AS first_response_minutes,

  msg.first_outbound_sender_type AS first_response_sender_type,

  ROUND(EXTRACT(EPOCH FROM (msg.first_human_outbound_at - contact_msg.first_inbound_at)) / 60.0, 1)
                                 AS first_human_response_minutes,

  -- Activity aggregates (via message_opportunity_map)
  COALESCE(msg.message_count, 0)  AS message_count,
  COALESCE(msg.inbound_count, 0)  AS inbound_count,
  COALESCE(msg.outbound_count, 0) AS outbound_count,
  COALESCE(msg.has_call, false)   AS has_call,

  -- Attribution coverage
  ROUND(
    100.0 * COALESCE(msg.message_count, 0)
    / NULLIF(contact_msg.contact_total, 0)
  , 1)                            AS mapping_coverage_pct,
  COALESCE(contact_msg.contact_total, 0) - COALESCE(msg.message_count, 0)
                                 AS unmapped_message_count,

  -- Discipline: tasks
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

-- FIX #3 — Lost reason label lookup (raw id → human label)
LEFT JOIN lost_reason_labels lrl
  ON lrl.location_id = o.location_id
 AND lrl.reason_id   = o.raw_opportunity->>'lostReasonId'

-- Per-opp message aggregates via CURRENT approved mapping
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

-- Contact-total message counts + FIRST INBOUND per contact (for FIX #2)
LEFT JOIN (
  SELECT
    location_id,
    contact_id,
    COUNT(*)                                                                 AS contact_total,
    MIN(message_timestamp) FILTER (WHERE message_direction = 'inbound')     AS first_inbound_at
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
  'One row per opportunity — spec Table 23 + audit v2 fixes (migration 045). Includes is_eligible flag (matches analytics_clean_deals scope), first_response anchored on contact''s first inbound (not deal creation), deal_lost_reason with lost_reason_labels fallback, whys_fresh derived from opportunity_field_history. SECURITY INVOKER — base-table RLS applies. See migrations 012 / 027 / 029 / 041 / 045 for evolution.';
