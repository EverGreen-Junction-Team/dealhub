-- 101_vw_source_won_value.sql
--
-- "Which lead sources actually make money?" — won value and win rate by
-- source, with paid separated from free. Built to be exposed to the AI as a
-- skill (see 083).
--
-- Companion to 096 (vw_source_failure_stage): that one shows where a source's
-- deals DIED, this shows what they EARNED. Same population, different
-- measure — the same relationship as 095 and 098. A source can look terrible
-- in 096 (most deals die pre-quote) and still be the best earner, because the
-- few that survive are large.
--
-- ── TWO SPLITS, STACKED ──────────────────────────────────────────────
--   by system route          which enquiry-text field GHL filled — website
--                            form, webchat, enquiries@ inbox, Crittall email
--                            upload, or none. Also carries paid/free, since
--                            "free website form" and "paid website form" are
--                            different businesses.
--   by rep-recorded source   lead_source_opportunity, the picklist a rep
--                            ticks. Multi-value deals become "A + B" rather
--                            than being counted twice.
--
-- A deal appears once in EACH split, so totalling across them double-counts.
-- The skill says so and exposes `split` as a filter.
--
-- ── PAID/FREE ────────────────────────────────────────────────────────
-- Only on the system-route half, as in the source query. A rep-recorded
-- source is what a person said, and cross-cutting it by click id would answer
-- neither question cleanly.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_source_won_value
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.opportunity_id, o.location_id, o.status, o.monetary_value,
         o.lead_source_opportunity,
         (NULLIF(o.gclid, '')  IS NOT NULL
          OR NULLIF(c.gclid, '')  IS NOT NULL
          OR NULLIF(c.gbraid, '') IS NOT NULL
          OR NULLIF(c.wbraid, '') IS NOT NULL) AS paid,
         CASE
           WHEN NULLIF(c.leadform_enquiry_text, '')        IS NOT NULL THEN 'website form'
           WHEN NULLIF(c.webchat_inquiry_text, '')         IS NOT NULL THEN 'webchat'
           WHEN NULLIF(c.enquiries_email_inquiry_text, '') IS NOT NULL THEN 'enquiries@ inbox'
           WHEN NULLIF(c.crittall_email_inquiry_text, '')  IS NOT NULL THEN 'crittall email upload'
           ELSE '(no intake text)'
         END AS route
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
by_route AS (
  SELECT location_id,
         'by system route' AS split,
         route || CASE WHEN paid THEN ' (paid)' ELSE ' (free)' END AS source,
         count(*)                                                  AS deals,
         count(*) FILTER (WHERE status = 'won')                     AS won,
         count(*) FILTER (WHERE status IN ('lost','abandoned'))     AS lost_or_abandoned,
         count(*) FILTER (WHERE status = 'open')                    AS still_open,
         sum(monetary_value) FILTER (WHERE status = 'won')          AS won_value,
         round(100.0 * count(*) FILTER (WHERE status = 'won')
               / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                                    AS won_per_closed_pct
    FROM d GROUP BY location_id, route, paid
),
by_rep_source AS (
  SELECT location_id,
         'by rep-recorded source' AS split,
         -- lead_source_opportunity is a Postgres array literal in a TEXT
         -- column ({"A","B"}), so braces and quotes are stripped, the value
         -- split on comma, each normalised, sorted and re-joined — a
         -- two-source deal becomes one "A + B" row rather than two.
         COALESCE(NULLIF(array_to_string(ARRAY(
           SELECT CASE
                    WHEN v ILIKE 'email - enqui%' THEN 'Email - Enquiries@ (brand inbox)'
                    WHEN v ILIKE 'google search%' THEN 'Google Search Organic'
                    WHEN v = 'Website'            THEN 'Website (retired option)'
                    ELSE v
                  END
             FROM unnest(string_to_array(
                    regexp_replace(
                      regexp_replace(COALESCE(lead_source_opportunity, ''), '[{}"]', '', 'g'),
                      ',\s*', ',', 'g'),
                    ',')) v
            WHERE v <> ''
            ORDER BY 1), ' + '), ''), '(lead source blank)')        AS source,
         count(*)                                                  AS deals,
         count(*) FILTER (WHERE status = 'won')                     AS won,
         count(*) FILTER (WHERE status IN ('lost','abandoned'))     AS lost_or_abandoned,
         count(*) FILTER (WHERE status = 'open')                    AS still_open,
         sum(monetary_value) FILTER (WHERE status = 'won')          AS won_value,
         round(100.0 * count(*) FILTER (WHERE status = 'won')
               / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                                    AS won_per_closed_pct
    FROM d GROUP BY location_id, 3
)
SELECT * FROM by_route
UNION ALL
SELECT * FROM by_rep_source;

COMMENT ON VIEW vw_source_won_value IS
  'Won value and win rate by lead source, in two stacked splits: what the system recorded (enquiry route, with paid and free separated) and what a rep recorded. Companion to vw_source_failure_stage, which shows where a source''s deals died rather than what they earned. A deal appears once in each split — never total across both.';

COMMENT ON COLUMN vw_source_won_value.split IS
  'Which grouping this row belongs to: "by system route" or "by rep-recorded source". Report one at a time.';
COMMENT ON COLUMN vw_source_won_value.source IS
  'The source. System-route rows carry (paid) or (free) — a website form from an ad and one from organic search are different businesses.';
COMMENT ON COLUMN vw_source_won_value.won_value IS
  'Total value won from this source. The figure that decides where to spend attention.';
COMMENT ON COLUMN vw_source_won_value.won_per_closed_pct IS
  'Wins as a share of deals that FINISHED, ignoring still-open ones. A source with many open deals is not penalised for deals that have not concluded.';
