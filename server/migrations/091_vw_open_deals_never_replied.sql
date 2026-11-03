-- 091_vw_open_deals_never_replied.sql
--
-- "Which open deals has nobody written back to?" — open deals where no human
-- has sent the customer anything, counted by how bad the silence is. Built to
-- be exposed to the AI as a skill (see 083).
--
-- Fourth of the pipeline-health family:
--   084  where a deal WAS when it closed
--   088  where it spent the most TIME
--   089  which OPEN deals have gone quiet
--   091  this one — which open deals were never answered AT ALL
--
-- 089 asks "has anything happened lately"; a workflow firing counts. This
-- asks the harder question: did a PERSON ever write back. A deal can look
-- active in 089 because automation has been touching it for weeks while no
-- human has typed a word.
--
-- ── A BUG IN THE SOURCE QUERY, FIXED HERE ────────────────────────────
-- The original filtered automated sends with
--
--     coalesce(sender_type,'') <> 'automation'
--
-- but 'automation' is not a value this column holds. messageSource.js emits
-- automation_workflow, automation_campaign, automation_bulk and
-- automation_ai — so the filter matched every one of them, and a deal whose
-- only outbound messages were workflow sends counted as replied-to.
--
-- That inverts the report: the deals most likely to have been handled by
-- automation alone are exactly the ones it was built to surface, and they
-- were the ones being filtered out. Now matched on the prefix.
--
-- ── SCOPE ────────────────────────────────────────────────────────────
-- Matched on contact_id within the sub-account — every message to that
-- customer, not just ones tied to this deal. A rep who replied about one deal
-- has spoken to the customer, which is what "never replied to" means.
--
-- Activity rows are excluded: they are CRM log lines, not somebody writing.

CREATE OR REPLACE VIEW vw_open_deals_never_replied
  WITH (security_invoker = true) AS
WITH open_deals AS (
  SELECT o.opportunity_id, o.contact_id, o.location_id, o.created_at_ghl,
         o.monetary_value, o.current_stage_name
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
),
msg AS (
  SELECT location_id, contact_id,
         -- A named person typed this.
         count(*) FILTER (
           WHERE message_direction = 'outbound' AND sender_type = 'user'
         ) AS human_out,
         -- Anything outbound that was not automation. Note the LIKE: the
         -- values are automation_workflow / _campaign / _bulk / _ai, and an
         -- equality test against 'automation' matches none of them.
         count(*) FILTER (
           WHERE message_direction = 'outbound'
             AND COALESCE(sender_type, '') NOT LIKE 'automation%'
             AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
         ) AS any_out,
         count(*) FILTER (
           WHERE message_direction = 'inbound'
             AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
         ) AS inbound,
         max(message_timestamp) FILTER (WHERE message_direction = 'inbound')
           AS last_customer_msg
    FROM messages
   WHERE deleted_at IS NULL
   GROUP BY location_id, contact_id
)
SELECT d.location_id,
       count(*)                                                    AS open_deals,
       -- Nobody has written to this customer at all.
       count(*) FILTER (WHERE COALESCE(m.any_out, 0) = 0)          AS no_written_reply_ever,
       -- The worst case: the customer wrote first and got nothing back.
       count(*) FILTER (WHERE COALESCE(m.any_out, 0) = 0
                          AND COALESCE(m.inbound, 0) > 0)          AS customer_wrote_no_reply,
       -- Old enough that "we have not got to it yet" no longer holds.
       count(*) FILTER (WHERE COALESCE(m.any_out, 0) = 0
                          AND d.created_at_ghl < now() - interval '7 days')
                                                                   AS no_reply_7d_plus,
       -- Automation may have sent something, but no named person has.
       count(*) FILTER (WHERE COALESCE(m.human_out, 0) = 0)        AS no_named_user_reply,
       -- What is at stake in the unanswered ones.
       sum(d.monetary_value) FILTER (WHERE COALESCE(m.any_out, 0) = 0)
                                                                   AS value_never_replied,
       round(100.0 * count(*) FILTER (WHERE COALESCE(m.any_out, 0) = 0)
             / NULLIF(count(*), 0))                                AS pct_never_replied
  FROM open_deals d
  LEFT JOIN msg m
    ON m.contact_id = d.contact_id
   -- contact_id is unique per sub-account, not globally
   -- (PRIMARY KEY (location_id, contact_id) — 001_schema), so without this
   -- one brand's messages would mark another brand's deal as answered.
   AND m.location_id = d.location_id
 GROUP BY d.location_id;

COMMENT ON VIEW vw_open_deals_never_replied IS
  'Open deals where nobody has written back to the customer — counted by how long they have waited, whether they wrote first, and how much value is unanswered. Counts a human reply only: a workflow or campaign send does not count as having replied.';

COMMENT ON COLUMN vw_open_deals_never_replied.no_written_reply_ever IS
  'Open deals where no person has sent the customer anything. Automated sends do not count.';
COMMENT ON COLUMN vw_open_deals_never_replied.customer_wrote_no_reply IS
  'Of those, the ones where the customer wrote first and got no answer. The worst case — they are waiting.';
COMMENT ON COLUMN vw_open_deals_never_replied.no_reply_7d_plus IS
  'Unanswered deals created more than a week ago, where "we have not got to it yet" no longer holds.';
COMMENT ON COLUMN vw_open_deals_never_replied.no_named_user_reply IS
  'Deals no NAMED user has replied to. Larger than no_written_reply_ever when automation has been sending on the team''s behalf.';
COMMENT ON COLUMN vw_open_deals_never_replied.value_never_replied IS
  'Total value of the open deals nobody has replied to.';
