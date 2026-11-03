-- 103_vw_response_time_by_rep.sql
--
-- "How fast does each rep reply?" — for every customer message, how long
-- until a named person answered, grouped by who answered. Built to be exposed
-- to the AI as a skill (see 083).
--
-- Companion to 100 (vw_response_time_win_rate): that asks whether speed wins
-- deals, this asks who is fast. One is a strategy question, the other a
-- management one.
--
-- ── NAMES COME FROM THE users TABLE, NOT A HARDCODED LIST ────────────
-- The source query carried a VALUES map of fourteen GHL user ids to names,
-- with a note to keep it in step with a ClickUp doc by hand.
--
-- users (migration 014) already holds exactly this, synced from GHL and
-- scoped per location. Using it means:
--   - a new rep appears without anyone editing SQL
--   - a renamed rep is renamed here too
--   - a rep who works in two sub-accounts is not silently merged, because
--     the table is keyed (location_id, user_id) and so is the join
--
-- The hardcoded list had three ids mapping to "Charlie Stoyle" and three to
-- "EGJ" — deliberate merging of separate accounts. That is lost here, and
-- should be: this view reports per GHL ACCOUNT, and merging two accounts into
-- one name hides that a rep is answering from one and ignoring the other.
-- COALESCE falls back to the raw id so an unsynced user still appears rather
-- than vanishing from the report.
--
-- ── WHAT IS MEASURED ─────────────────────────────────────────────────
-- Every inbound customer message paired with the NEXT outbound message from a
-- named user on the same contact. Not the first reply per contact — a rep who
-- answers quickly once and slowly nine times should not look fast.
--
-- Replies more than 30 days later are excluded, as in the source: past that
-- point it is a new conversation, not a slow answer, and a handful of them
-- would drag every median.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_response_time_by_rep
  WITH (security_invoker = true) AS
WITH msgs AS (
  SELECT location_id, contact_id, message_timestamp, message_direction,
         sender_type, sender_user_id
    FROM messages
   WHERE deleted_at IS NULL
     AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
),
reply AS (
  SELECT i.location_id,
         o.sender_user_id AS out_user,
         EXTRACT(EPOCH FROM o.message_timestamp - i.message_timestamp) / 3600 AS hours
    FROM msgs i
    LEFT JOIN LATERAL (
      SELECT message_timestamp, sender_user_id
        FROM msgs o
       WHERE o.contact_id  = i.contact_id
         AND o.location_id = i.location_id
         AND o.message_direction = 'outbound'
         -- sender_type = 'user' is an equality test on purpose: this view is
         -- specifically about NAMED people, so automation and provider sends
         -- are excluded by not matching, rather than by a NOT LIKE.
         AND o.sender_type = 'user'
         AND o.message_timestamp > i.message_timestamp
       ORDER BY o.message_timestamp
       LIMIT 1
    ) o ON true
   WHERE i.message_direction = 'inbound'
     AND o.message_timestamp IS NOT NULL
     -- Past a month it is a new conversation, not a slow reply.
     AND o.message_timestamp - i.message_timestamp < interval '30 days'
)
SELECT r.location_id,
       COALESCE(u.name, r.out_user)                          AS rep,
       count(*)                                              AS replies,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 1)
                                                             AS median_hours,
       -- The tail. A median of 2h with a p90 of 90h means most messages are
       -- answered fast and some are forgotten entirely.
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours)::numeric, 1)
                                                             AS p90_hours,
       round(100.0 * count(*) FILTER (WHERE hours <= 1)  / NULLIF(count(*), 0))
                                                             AS pct_within_1h,
       round(100.0 * count(*) FILTER (WHERE hours <= 24) / NULLIF(count(*), 0))
                                                             AS pct_within_24h,
       -- Named separately because it is the failure people care about: not
       -- slow, but effectively unanswered that day.
       count(*) FILTER (WHERE hours > 72)                    AS over_3_days
  FROM reply r
  LEFT JOIN users u
    ON u.user_id = r.out_user
   -- Keyed on location too: the users table is (location_id, user_id), and a
   -- rep working in two sub-accounts must stay two rows, not be merged.
   AND u.location_id = r.location_id
 GROUP BY r.location_id, COALESCE(u.name, r.out_user);

COMMENT ON VIEW vw_response_time_by_rep IS
  'How long each named rep takes to answer a customer message — typical, worst tenth, and the share answered within an hour or a day. Every customer message is counted, not just the first per contact. Names come from the synced users table, per sub-account, so reps are never merged across accounts.';

COMMENT ON COLUMN vw_response_time_by_rep.rep IS
  'The GHL user account that replied, named from the users table. Falls back to the raw user id when a user has not synced — an unfamiliar id means a rep missing from the user sync, not a rep with no name.';
COMMENT ON COLUMN vw_response_time_by_rep.replies IS
  'How many customer messages this rep answered. Every message, not one per contact — answering quickly once and slowly nine times should not read as fast.';
COMMENT ON COLUMN vw_response_time_by_rep.median_hours IS
  'Hours the typical reply took. Compare reps on this; a single rep''s figure means little alone.';
COMMENT ON COLUMN vw_response_time_by_rep.p90_hours IS
  'Nine in ten replies were faster than this. A big gap from the median means most messages are answered quickly and some are forgotten.';
COMMENT ON COLUMN vw_response_time_by_rep.over_3_days IS
  'Replies that took more than three days — effectively unanswered at the time the customer was waiting.';
