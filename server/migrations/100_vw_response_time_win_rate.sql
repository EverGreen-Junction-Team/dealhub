-- 100_vw_response_time_win_rate.sql
--
-- "Does replying fast actually win more?" — closed deals bucketed by how long
-- a person took to answer the customer's first message, with the win rate for
-- each band. Built to be exposed to the AI as a skill (see 083).
--
-- ── THE AUTOMATION BUG, FIXED ────────────────────────────────────────
-- The source query identified a human reply with
--
--     coalesce(sender_type,'') <> 'automation'
--
-- and 'automation' is not a value this column holds. messageSource.js emits
-- automation_workflow, automation_campaign, automation_bulk and
-- automation_ai, so the test matched all of them.
--
-- That does not just add noise here — it destroys the finding. An
-- auto-responder fires in seconds, so every deal with one would land in
-- "within 5 min" and the whole report would be measuring the bot's speed
-- against the win rate. The one answer nobody wants is a confident "fast
-- replies win" built entirely on autoresponders.
--
-- Matched on the prefix now. Same fix as 091 and 092.
--
-- ── WHY NOT vw_opportunity_flat.first_response_minutes ────────────────
-- It goes negative on many deals, as the source query notes. Computed here
-- from the messages themselves, with the outbound message constrained to
-- t1 >= t0 so a reply cannot predate the question it answers.
--
-- ── WHAT IS MEASURED ─────────────────────────────────────────────────
-- Customer's first written message to the first written reply from a PERSON,
-- on that contact within the sub-account — not per deal. A rep who answered
-- about one deal has answered the customer.
--
-- Only CLOSED deals: an open deal has no outcome, so including it would
-- dilute every win rate with deals that have not finished.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_response_time_win_rate
  WITH (security_invoker = true) AS
WITH closed AS (
  SELECT o.opportunity_id, o.contact_id, o.status, o.location_id, o.monetary_value
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status IN ('won', 'lost', 'abandoned')
),
first_in AS (
  SELECT location_id, contact_id, min(message_timestamp) AS t0
    FROM messages
   WHERE deleted_at IS NULL
     AND message_direction = 'inbound'
     AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
   GROUP BY 1, 2
),
first_out AS (
  SELECT m.location_id, m.contact_id, min(m.message_timestamp) AS t1
    FROM messages m
    JOIN first_in f
      ON f.contact_id = m.contact_id AND f.location_id = m.location_id
   WHERE m.deleted_at IS NULL
     AND m.message_direction = 'outbound'
     -- NOT LIKE, not <>. See the header: an equality test against
     -- 'automation' matches none of the four real values.
     AND COALESCE(m.sender_type, '') NOT LIKE 'automation%'
     AND COALESCE(m.message_channel, '') NOT ILIKE '%ACTIVITY%'
     -- A reply cannot come before the message it replies to.
     AND m.message_timestamp >= f.t0
   GROUP BY 1, 2
),
resp AS (
  SELECT c.*, EXTRACT(EPOCH FROM o.t1 - f.t0) / 60 AS mins
    FROM closed c
    JOIN first_in f
      ON f.contact_id = c.contact_id AND f.location_id = c.location_id
    LEFT JOIN first_out o
      ON o.contact_id = c.contact_id AND o.location_id = c.location_id
),
b AS (
  SELECT *,
         CASE WHEN mins IS NULL THEN 'f. never replied in writing'
              WHEN mins <= 5    THEN 'a. within 5 min'
              WHEN mins <= 60   THEN 'b. 5-60 min'
              WHEN mins <= 1440 THEN 'c. 1-24 hours'
              WHEN mins <= 4320 THEN 'd. 1-3 days'
              ELSE                   'e. over 3 days'
         END AS bucket
    FROM resp
)
SELECT location_id,
       bucket                                                  AS response_time,
       count(*)                                                AS deals,
       count(*) FILTER (WHERE status = 'won')                  AS won,
       count(*) FILTER (WHERE status = 'lost')                 AS lost,
       count(*) FILTER (WHERE status = 'abandoned')            AS abandoned,
       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*), 0), 1)                         AS win_rate_pct,
       sum(monetary_value) FILTER (WHERE status = 'won')       AS won_value,
       -- percentile_cont, not median(): Postgres has no median() function,
       -- and the view would have failed to create. Every other view in this
       -- family uses the same form.
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mins)::numeric, 1)
         AS median_minutes
  FROM b
 GROUP BY location_id, bucket;

COMMENT ON VIEW vw_response_time_win_rate IS
  'Closed deals bucketed by how long a PERSON took to answer the customer''s first message, with the win rate for each band. Automated replies are excluded — an autoresponder fires in seconds and would put every deal in the fastest bucket.';

COMMENT ON COLUMN vw_response_time_win_rate.response_time IS
  'How long until a person replied in writing. Sorts in order because each label is prefixed a. to f. — "f. never replied in writing" is the group nobody answered at all.';
COMMENT ON COLUMN vw_response_time_win_rate.win_rate_pct IS
  'Share of this band''s closed deals that were won. Comparing bands is the point; a single band''s figure means little on its own.';
COMMENT ON COLUMN vw_response_time_win_rate.deals IS
  'Closed deals in this band. Open deals are excluded — they have no outcome yet, and counting them would dilute every win rate.';
