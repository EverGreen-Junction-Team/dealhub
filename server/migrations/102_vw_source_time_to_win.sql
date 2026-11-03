-- 102_vw_source_time_to_win.sql
--
-- "How long does a source take to turn into money?" — days from enquiry to
-- won, by lead source. Built to be exposed to the AI as a skill (see 083).
--
-- Third of the source family, and the three together are the useful set:
--   096  where a source's deals DIED
--   101  what a source EARNED
--   102  how LONG it took                 <- this one
--
-- A source can earn well and still be a problem: £200k that takes nine months
-- is a different cash-flow proposition from £200k in three weeks, and neither
-- of the other two views shows it.
--
-- ── WON DEALS ONLY ───────────────────────────────────────────────────
-- Time-to-win is undefined for a deal that has not been won. Including open
-- or lost deals would mean either counting time-so-far as if it were final,
-- or padding the average with deals that will never arrive.
--
-- won_at IS NOT NULL is required, not assumed: a deal can carry status 'won'
-- with no timestamp if it was set before that column synced, and
-- extract(epoch from NULL - created) is NULL, which would silently drop out
-- of the median rather than failing.
--
-- ── MEDIAN, MIN, MAX ─────────────────────────────────────────────────
-- Median rather than mean: one deal that sat for two years drags an average
-- into uselessness. min and max are kept because the SPREAD is the finding —
-- a source with a median of 30 days and a max of 400 has two different kinds
-- of customer in it.
--
-- ── TWO SPLITS, STACKED ──────────────────────────────────────────────
-- Same shape as 096 and 101: system route and rep-recorded source, tagged by
-- `split`. A deal appears once in EACH, so totalling across them
-- double-counts. The skill says so and exposes `split` as a filter.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_source_time_to_win
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id,
         EXTRACT(EPOCH FROM o.won_at - o.created_at_ghl) / 86400 AS days,
         -- lead_source_opportunity is a Postgres array literal in a TEXT
         -- column ({"A","B"}) — braces and quotes stripped, split on comma,
         -- each value normalised, sorted and re-joined, so a two-source deal
         -- is one "A + B" row rather than two.
         COALESCE(NULLIF(array_to_string(ARRAY(
           SELECT CASE
                    WHEN v ILIKE 'email - enqui%' THEN 'Email - Enquiries@ (brand inbox)'
                    WHEN v ILIKE 'google search%' THEN 'Google Search Organic'
                    WHEN v = 'Website'            THEN 'Website (retired option)'
                    ELSE v
                  END
             FROM unnest(string_to_array(
                    regexp_replace(
                      regexp_replace(COALESCE(o.lead_source_opportunity, ''), '[{}"]', '', 'g'),
                      ',\s*', ',', 'g'),
                    ',')) v
            WHERE v <> ''
            ORDER BY 1), ' + '), ''), '(lead source blank)') AS rep_source,
         CASE
           WHEN NULLIF(c.leadform_enquiry_text, '')        IS NOT NULL THEN 'website form'
           WHEN NULLIF(c.webchat_inquiry_text, '')         IS NOT NULL THEN 'webchat'
           WHEN NULLIF(c.enquiries_email_inquiry_text, '') IS NOT NULL THEN 'enquiries@ inbox'
           WHEN NULLIF(c.crittall_email_inquiry_text, '')  IS NOT NULL THEN 'crittall email upload'
           ELSE '(created by hand)'
         END AS route
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'won'
     AND o.won_at IS NOT NULL
     AND o.created_at_ghl IS NOT NULL
     -- A deal won before it was created is a data fault, not a fast sale.
     -- Left in the wrong bucket it would pull a median negative.
     AND o.won_at >= o.created_at_ghl
),
by_rep_source AS (
  SELECT location_id, 'by rep-recorded source' AS split, rep_source AS source,
         count(*)                                                        AS won,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::numeric, 0) AS median_days,
         round(min(days)::numeric, 0)                                    AS fastest_days,
         round(max(days)::numeric, 0)                                    AS slowest_days,
         count(*) FILTER (WHERE days < 1)                                AS same_day
    FROM d GROUP BY location_id, rep_source
),
by_route AS (
  SELECT location_id, 'by system route' AS split, route AS source,
         count(*),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::numeric, 0),
         round(min(days)::numeric, 0),
         round(max(days)::numeric, 0),
         count(*) FILTER (WHERE days < 1)
    FROM d GROUP BY location_id, route
)
SELECT * FROM by_rep_source
UNION ALL
SELECT * FROM by_route;

COMMENT ON VIEW vw_source_time_to_win IS
  'Days from enquiry to won deal, by lead source, in two stacked splits: rep-recorded source and system route. Won deals only — time-to-win is undefined for anything else. Completes the source family with vw_source_failure_stage (where deals died) and vw_source_won_value (what they earned).';

COMMENT ON COLUMN vw_source_time_to_win.median_days IS
  'Days the typical won deal from this source took. A median rather than an average, so one deal that sat for two years does not distort it.';
COMMENT ON COLUMN vw_source_time_to_win.fastest_days IS
  'The quickest win from this source. Read with slowest_days — a wide gap means the source brings two different kinds of customer.';
COMMENT ON COLUMN vw_source_time_to_win.same_day IS
  'Wins closed the same day the enquiry arrived. Usually small jobs or a customer who had already decided.';
COMMENT ON COLUMN vw_source_time_to_win.split IS
  'Which grouping this row belongs to. A deal appears once in each — report one at a time and never total across both.';
