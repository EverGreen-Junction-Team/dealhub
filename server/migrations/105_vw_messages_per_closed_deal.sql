-- 105_vw_messages_per_closed_deal.sql
--
-- "How much conversation does a won deal take, compared with one we lost?"
-- Message counts per closed deal, split by outcome. Built to be exposed to
-- the AI as a skill (see 083).
--
-- The useful shape of the answer is a comparison, not a number: if won deals
-- carry a median of 14 customer messages and lost ones 3, the deals that die
-- were never really conversations. If they are close, message volume is not
-- what separates them and the answer is elsewhere.
--
-- ── BUG IN THE SOURCE QUERY: 'automation' NEVER MATCHES ──────────────
-- The source filtered automated sends with
--
--     coalesce(sender_type,'') <> 'automation'
--
-- and counted them with `sender_type = 'automation'`. That value does not
-- exist in the column. messageSource.js emits automation_workflow,
-- automation_campaign, automation_bulk and automation_ai — so the first test
-- passed for every one of them and outbound_human silently included every
-- workflow blast, while outbound_auto was always 0.
--
-- It matters more here than almost anywhere: automation volume is not evenly
-- spread across outcomes. Lost and abandoned deals attract the most nurture
-- sequences, precisely because nobody is talking to them. Counting those as
-- human replies makes the neglected deals look attended to, which is the
-- opposite of what this view is for. Matched on the prefix now, and the two
-- are reported as separate columns rather than one blended total.
--
-- ── BUG: contact_id JOINED WITHOUT location_id ───────────────────────
-- `on m.contact_id = c.contact_id` alone can match across sub-accounts —
-- contacts is keyed (location_id, contact_id) (001_schema), so the id is
-- unique per account, not globally. A collision inflates one account's counts
-- with another's messages, silently. Scoped here.
--
-- Also: the source's msg CTE groups by contact_id with no location in the key,
-- so two accounts' rows for a colliding id would already be merged before the
-- join ever happened.
--
-- ── COUNTED PER CONTACT, AND WHAT THAT MEANS ─────────────────────────
-- Kept from the source: messages are counted on the contact, so every message
-- with that customer counts, not only those tagged to this deal. That is
-- deliberate — GHL ties a message to an opportunity inconsistently, and a
-- conversation about one deal is still a conversation with that customer.
--
-- The cost is real and worth stating: a customer with three deals has the same
-- message count attributed to all three. The view exposes deals_for_contact so
-- the AI can say so instead of the reader assuming otherwise.
--
-- ── WHY inbound > 0 GATES THE AVERAGES ───────────────────────────────
-- Kept from the source, and it is the right call. A deal where the customer
-- never said anything is not a short conversation, it is a non-conversation —
-- usually a bad lead or a bad number. Leaving those in drags every median
-- toward zero and makes lost deals look like they had fewer messages when
-- really they had no customer at all. Counted separately as
-- deals_without_customer_msg, which is its own finding.
--
-- percentile_cont, not median(): Postgres has no median function.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

CREATE OR REPLACE VIEW vw_messages_per_closed_deal
  WITH (security_invoker = true) AS
WITH closed AS (
  SELECT o.opportunity_id, o.contact_id, o.location_id, o.status
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status IN ('won', 'lost', 'abandoned')
),
msg AS (
  SELECT m.location_id,
         m.contact_id,
         count(*) FILTER (WHERE m.message_direction = 'inbound') AS inbound,
         -- Prefix match: automation_workflow / _campaign / _bulk / _ai.
         count(*) FILTER (
           WHERE m.message_direction = 'outbound'
             AND COALESCE(m.sender_type, '') NOT LIKE 'automation%'
         ) AS outbound_human,
         count(*) FILTER (
           WHERE m.message_direction = 'outbound'
             AND m.sender_type LIKE 'automation%'
         ) AS outbound_auto
    FROM messages m
   WHERE m.deleted_at IS NULL
     -- Activity rows are system log entries, not messages anyone sent.
     AND COALESCE(m.message_channel, '') NOT ILIKE '%ACTIVITY%'
   GROUP BY m.location_id, m.contact_id
),
j AS (
  SELECT c.location_id,
         c.status,
         COALESCE(m.inbound, 0)        AS inbound,
         COALESCE(m.outbound_human, 0) AS outbound_human,
         COALESCE(m.outbound_auto, 0)  AS outbound_auto,
         -- How many closed deals share this contact's message count. >1 means
         -- the counts on those rows are the customer's total, not this deal's.
         count(*) OVER (PARTITION BY c.location_id, c.contact_id) AS deals_for_contact
    FROM closed c
    LEFT JOIN msg m
      ON m.contact_id = c.contact_id
     AND m.location_id = c.location_id
)
SELECT location_id,
       status,
       count(*)                                        AS deals,
       count(*) FILTER (WHERE inbound > 0)             AS with_customer_msg,
       count(*) FILTER (WHERE inbound = 0)             AS without_customer_msg,
       round(100.0 * count(*) FILTER (WHERE inbound = 0)
             / NULLIF(count(*), 0))                    AS pct_without_customer_msg,

       -- Medians and means over deals the customer actually spoke on.
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY inbound)
             FILTER (WHERE inbound > 0)::numeric, 0)   AS median_inbound,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY outbound_human)
             FILTER (WHERE inbound > 0)::numeric, 0)   AS median_outbound_human,
       round(avg(inbound)        FILTER (WHERE inbound > 0), 1) AS mean_inbound,
       round(avg(outbound_human) FILTER (WHERE inbound > 0), 1) AS mean_outbound_human,

       -- Reported separately, never folded into the human figures.
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY outbound_auto)
             FILTER (WHERE inbound > 0)::numeric, 0)   AS median_outbound_auto,
       round(avg(outbound_auto)  FILTER (WHERE inbound > 0), 1) AS mean_outbound_auto,

       round(avg(deals_for_contact), 2)                AS avg_deals_per_contact
  FROM j
 GROUP BY location_id, status;

COMMENT ON VIEW vw_messages_per_closed_deal IS
  'Message volume per closed deal, split by won / lost / abandoned: how many the customer sent, how many a person sent back, and how many automation sent. Read as a comparison between outcomes — the gap is the finding, not any single number. Messages are counted per customer, so a customer with several deals contributes the same count to each.';

COMMENT ON COLUMN vw_messages_per_closed_deal.median_inbound IS
  'Typical number of messages the customer sent, over deals where they sent at least one. The median, not the mean — a handful of very long threads pull the mean well above what a normal deal looks like.';
COMMENT ON COLUMN vw_messages_per_closed_deal.median_outbound_human IS
  'Typical number of messages a person sent, over deals where the customer spoke. Excludes automation entirely.';
COMMENT ON COLUMN vw_messages_per_closed_deal.median_outbound_auto IS
  'Typical number of automated sends. High automation against low human volume on lost deals means those customers were sequenced, not talked to.';
COMMENT ON COLUMN vw_messages_per_closed_deal.without_customer_msg IS
  'Deals the customer never sent a single message on. Excluded from every median and mean here, because a deal with no customer in it is not a short conversation — it is usually a bad lead or a bad number. Worth reporting on its own.';
COMMENT ON COLUMN vw_messages_per_closed_deal.avg_deals_per_contact IS
  'Average number of closed deals sharing one customer. Above 1 means message counts are per customer rather than per deal, and are somewhat overstated for repeat customers.';
