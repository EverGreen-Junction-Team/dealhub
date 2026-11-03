-- 040_vw_opportunity_messages_json_enrich.sql
--
-- Closes the "change required" note on the CSV spec for
-- vw_opportunity_messages_json (Stage 3 · Table 24).
--
-- Adds to each message in the JSON blob:
--   • mapping_rule + mapping_confidence — from message_opportunity_map's
--     current (non-superseded) row. Reveals HOW attribution decided this
--     message belongs to this opportunity.
--   • sender_type — contact / user / automation / etc. Useful context for
--     downstream LLM prompts.
--   • subject — email subject (NULL for non-email channels).
--   • is_call + call_duration_seconds — call metadata.
--   • message_status — delivered / sent / failed / read.
--
-- WHERE clause changes: uses messages linked via CURRENT approved mapping
-- from message_opportunity_map (mapping_status = 'mapped', not superseded)
-- rather than the materialised messages.opportunity_id column. This is what
-- the spec calls the "approved" set — ambiguous/excluded/unassigned messages
-- correctly stay out.

DROP VIEW IF EXISTS vw_opportunity_messages_json;

CREATE VIEW vw_opportunity_messages_json
  WITH (security_invoker = true) AS
SELECT
  mom.location_id,
  mom.opportunity_id,
  COUNT(*)::integer AS message_count,
  jsonb_agg(
    jsonb_build_object(
      'message_id',            m.message_id,
      'timestamp',             m.message_timestamp,
      'direction',             m.message_direction,
      'channel',               m.message_channel,
      'status',                m.message_status,
      'body',                  m.message_body,
      'subject',               m.subject,
      'sender_type',           m.sender_type,
      'sender_name',           m.sender_name,
      'is_call',               m.is_call,
      'call_duration_seconds', m.call_duration_seconds,
      'mapping_rule',          mom.rule,
      'mapping_confidence',    mom.confidence
    )
    ORDER BY m.message_timestamp
  ) AS messages_json
FROM message_opportunity_map mom
JOIN messages m
  ON m.location_id = mom.location_id
 AND m.message_id  = mom.message_id
WHERE mom.superseded_at IS NULL
  AND mom.mapping_status = 'mapped'
  AND mom.opportunity_id IS NOT NULL
  AND m.deleted_at IS NULL
GROUP BY mom.location_id, mom.opportunity_id;

COMMENT ON VIEW vw_opportunity_messages_json IS
  'One row per opportunity. Full ordered conversation (both directions) as JSONB, ready to feed to an LLM. Includes attribution rule/confidence and sender type per message. SECURITY INVOKER — RLS on base tables applies to anon-key reads. Heavy — pull only when needed. Join on (location_id, opportunity_id).';
