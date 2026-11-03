-- 092_vw_unanswered_deals_list.sql
--
-- Part B of the never-replied report: the DEALS themselves, one per row, so a
-- rep can work through them. 091 answers "how bad is it"; this answers "which
-- ones, and who do I start with".
--
-- A separate view rather than more columns on 091, because they are different
-- shapes: 091 is one row per sub-account and charts as a summary, this is one
-- row per deal and reads as a worklist. Merging them would give the AI a
-- result it could only use half of.
--
-- Same automation fix as 091 — sender_type holds automation_workflow,
-- automation_campaign, automation_bulk and automation_ai, so a test against
-- 'automation' matches none of them and every automated send would count as
-- a human reply.
--
-- Ordered by how long the customer has been waiting: someone who wrote three
-- times a fortnight ago is a worse miss than a lead created yesterday.

CREATE OR REPLACE VIEW vw_unanswered_deals_list
  WITH (security_invoker = true) AS
WITH open_deals AS (
  SELECT o.opportunity_id, o.contact_id, o.location_id, o.created_at_ghl,
         o.assigned_to_name, o.monetary_value, o.name AS deal_name,
         o.current_stage_name
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
),
msg AS (
  SELECT location_id, contact_id,
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
       d.opportunity_id,
       d.deal_name,
       ct.first_name,
       ct.last_name,
       ct.company_name,
       ct.email,
       ct.phone,
       d.current_stage_name                              AS stage,
       d.assigned_to_name                                AS owner,
       d.monetary_value                                  AS value,
       d.created_at_ghl::date                            AS created,
       (now()::date - d.created_at_ghl::date)            AS days_open,
       COALESCE(m.inbound, 0)                            AS customer_messages,
       m.last_customer_msg::date                         AS last_customer_message,
       CASE WHEN m.last_customer_msg IS NOT NULL
            THEN (now()::date - m.last_customer_msg::date) END
                                                         AS days_since_customer_wrote
  FROM open_deals d
  LEFT JOIN msg m
    ON m.contact_id = d.contact_id AND m.location_id = d.location_id
  LEFT JOIN contacts ct
    ON ct.contact_id = d.contact_id AND ct.location_id = d.location_id
 WHERE COALESCE(m.any_out, 0) = 0;

COMMENT ON VIEW vw_unanswered_deals_list IS
  'The individual open deals nobody has written back to — with the contact, owner, value, and how long the customer has been waiting. The worklist behind the counts in vw_open_deals_never_replied.';

COMMENT ON COLUMN vw_unanswered_deals_list.customer_messages IS
  'How many times the customer has written. Above zero means they are actively waiting, not just an untouched lead.';
COMMENT ON COLUMN vw_unanswered_deals_list.days_since_customer_wrote IS
  'Days since the customer last wrote, where they have. NULL means they never did — an unworked lead rather than an ignored one.';
COMMENT ON COLUMN vw_unanswered_deals_list.days_open IS
  'Days since the deal was created.';
