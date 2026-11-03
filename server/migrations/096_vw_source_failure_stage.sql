-- 096_vw_source_failure_stage.sql
--
-- "Which lead sources fail, and where in the pipeline?" — deals grouped by
-- source and by the furthest stage they reached before closing without a win.
-- Built to be exposed to the AI as a skill (see 083).
--
-- ── TWO SPLITS, DELIBERATELY NOT COMBINED ────────────────────────────
-- A lead has two different "sources" and they answer different questions:
--
--   by system route          which enquiry field the CRM filled — website
--                            form, webchat, enquiries@ inbox, Crittall email
--                            upload, or created by hand. What the SYSTEM saw.
--   by rep-recorded source   whatever a rep put in lead_source_opportunity.
--                            What a PERSON said.
--
-- They disagree often, and the disagreement is itself the finding: a deal the
-- system logged as "created by hand" that a rep labelled "Google Search
-- Organic" was probably a phone call from an ad.
--
-- The two are stacked with a `split` column rather than joined, because a
-- deal appears once in EACH — summing `deals` across the whole view
-- double-counts every deal. The skill tells the AI to report one split at a
-- time and never to total across them, and `split` is exposed as a filter so
-- it can ask for one.
--
-- ── FAILURE POINT ────────────────────────────────────────────────────
-- The furthest stage a deal reached before closing, bucketed:
--   pre_qualification   never got past Initial Contact Made
--   pre_quote           qualified but no quote went out
--   at_quote            quote sent, no sale
--   at_negotiation      got to negotiation or contract and still died
--
-- Stage order is a literal map, as the source query has it. Unlike the funnel
-- (093) this cannot come from pipeline position, because the BUCKETS are
-- business judgements — "pre-quote" means something specific that no position
-- number encodes. Same treatment as 094 and 095: the view returns which stage
-- names it matched, so a rename shows as a visibly empty column rather than
-- every deal silently landing in pre_qualification.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

CREATE OR REPLACE VIEW vw_source_failure_stage
  WITH (security_invoker = true) AS
WITH so(stage_name, ord) AS (VALUES
  ('new lead', 0), ('marketing qualified', 1), ('initial contact made', 2),
  ('sales qualified', 3), ('waiting on details', 4), ('quote sent', 5),
  ('negotiation', 6), ('deposit & sales contract', 7)
),
norm AS (
  SELECT o.opportunity_id, o.location_id, o.contact_id, o.status,
         -- lead_source_opportunity is a Postgres array literal in a TEXT
         -- column ({"Google Search","Referral"}), so it is unwrapped, split,
         -- normalised and re-joined. Multi-value sources become "A + B"
         -- rather than being counted twice.
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
            ORDER BY 1), ' + '), ''), '(lead source blank)') AS rep_source
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
d AS (
  SELECT n.opportunity_id, n.location_id, n.status, n.rep_source,
         CASE
           WHEN NULLIF(c.leadform_enquiry_text, '')        IS NOT NULL THEN 'website form'
           WHEN NULLIF(c.webchat_inquiry_text, '')         IS NOT NULL THEN 'webchat'
           WHEN NULLIF(c.enquiries_email_inquiry_text, '') IS NOT NULL THEN 'enquiries@ inbox'
           WHEN NULLIF(c.crittall_email_inquiry_text, '')  IS NOT NULL THEN 'crittall email upload'
           ELSE 'created by hand'
         END AS route
    FROM norm n
    LEFT JOIN contacts c
      ON c.contact_id = n.contact_id AND c.location_id = n.location_id
),
mx AS (
  SELECT d.*,
         (SELECT max(so.ord)
            FROM stage_history s
            JOIN so ON so.stage_name = lower(s.stage_name)
           WHERE s.opportunity_id = d.opportunity_id
             AND s.location_id    = d.location_id
             AND NOT s.deleted
             AND NOT s.ghost_opportunity
             AND COALESCE(s.closed_reason, '') <> 'correction') AS max_ord
    FROM d
),
agg AS (
  -- Columns listed explicitly. `SELECT x, y, *` would re-emit location_id and
  -- route from the subquery, so the view would carry duplicate column names
  -- and the UNION halves would not line up.
  SELECT location_id, 'by system route' AS split, route AS source,
         deals, closed_no_win, died_pre_qualification, died_pre_quote,
         died_at_quote, died_at_negotiation, won
    FROM (
    SELECT location_id, route,
           count(*)                                                       AS deals,
           count(*) FILTER (WHERE status IN ('lost','abandoned'))         AS closed_no_win,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) <= 2)
                                                                          AS died_pre_qualification,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) IN (3,4))
                                                                          AS died_pre_quote,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) = 5)
                                                                          AS died_at_quote,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) >= 6)
                                                                          AS died_at_negotiation,
           count(*) FILTER (WHERE status = 'won')                         AS won
      FROM mx GROUP BY location_id, route
  ) x
  UNION ALL
  SELECT location_id, 'by rep-recorded source', rep_source,
         deals, closed_no_win, died_pre_qualification, died_pre_quote,
         died_at_quote, died_at_negotiation, won
    FROM (
    SELECT location_id, rep_source,
           count(*)                                                       AS deals,
           count(*) FILTER (WHERE status IN ('lost','abandoned'))         AS closed_no_win,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) <= 2)
                                                                          AS died_pre_qualification,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) IN (3,4))
                                                                          AS died_pre_quote,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) = 5)
                                                                          AS died_at_quote,
           count(*) FILTER (WHERE status IN ('lost','abandoned') AND COALESCE(max_ord,0) >= 6)
                                                                          AS died_at_negotiation,
           count(*) FILTER (WHERE status = 'won')                         AS won
      FROM mx GROUP BY location_id, rep_source
  ) y
)
SELECT location_id, split, source,
       deals, closed_no_win,
       died_pre_qualification, died_pre_quote, died_at_quote, died_at_negotiation,
       won,
       round(100.0 * won / NULLIF(deals, 0), 1)           AS won_pct,
       round(100.0 * closed_no_win / NULLIF(deals, 0), 1) AS lost_pct
  FROM agg;

COMMENT ON VIEW vw_source_failure_stage IS
  'Deals by lead source and how far they got before dying. Two splits stacked and tagged by `split`: what the SYSTEM recorded (which enquiry field was filled) and what a REP recorded (lead_source_opportunity). A deal appears once in each — never total across both splits.';

COMMENT ON COLUMN vw_source_failure_stage.split IS
  'Which grouping this row belongs to: "by system route" or "by rep-recorded source". The two cover the same deals from different angles — report one at a time.';
COMMENT ON COLUMN vw_source_failure_stage.source IS
  'The source itself: an enquiry route for system rows, a rep-entered lead source for the others.';
COMMENT ON COLUMN vw_source_failure_stage.died_pre_qualification IS
  'Lost or abandoned without getting past Initial Contact Made — nobody really engaged.';
COMMENT ON COLUMN vw_source_failure_stage.died_pre_quote IS
  'Qualified, but died before a quote went out. Usually the most actionable band.';
COMMENT ON COLUMN vw_source_failure_stage.died_at_quote IS
  'Quote sent and then lost. A pricing or follow-up problem rather than a lead-quality one.';
COMMENT ON COLUMN vw_source_failure_stage.died_at_negotiation IS
  'Reached negotiation or contract and still died. The most expensive failures.';
