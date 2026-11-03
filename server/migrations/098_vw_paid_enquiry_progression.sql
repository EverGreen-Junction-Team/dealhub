-- 098_vw_paid_enquiry_progression.sql
--
-- "How far do paid enquiries actually get?" — paid-tagged deals by campaign
-- and by search term, bucketed by the furthest stage they reached. Built to
-- be exposed to the AI as a skill (see 083).
--
-- ── HOW THIS DIFFERS FROM 095 ────────────────────────────────────────
-- 095 (closed_won_value_by_campaign) asks what a campaign EARNED.
-- This asks how far its enquiries GOT.
--
-- They answer different questions and the pair is more useful than either:
-- a campaign with forty enquiries and no revenue looks identical in 095 to a
-- campaign with four. This one separates them — forty enquiries all dying
-- pre-qualification is a traffic problem, four enquiries dying at quote is a
-- pricing or follow-up problem. Same spend, opposite fix.
--
-- ── TWO GROUPINGS, STACKED ───────────────────────────────────────────
-- The source query grouped by campaign and left "swap camp for term" as a
-- note. Both are built here and tagged with `grouped_by`, because a rep asks
-- both questions and a note in a SQL file is not something the AI can act on.
--
-- Same warning as 096: a deal appears once in EACH grouping, so totalling
-- across them double-counts. The skill tells the AI to report one at a time,
-- and `grouped_by` is exposed as a filter.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

-- NOTE: the CTE is named `combined` and the column `group_value` because
-- `both` is a Postgres reserved word (it belongs to trim(both ...)) and
-- `grouping` is the name of a built-in aggregate. Either one unquoted is a
-- hard syntax error at parse time, so the view would never have been created.
CREATE OR REPLACE VIEW vw_paid_enquiry_progression
  WITH (security_invoker = true) AS
WITH so(stage_name, ord) AS (VALUES
  ('new lead', 0), ('marketing qualified', 1), ('initial contact made', 2),
  ('sales qualified', 3), ('waiting on details', 4), ('quote sent', 5),
  ('negotiation', 6), ('deposit & sales contract', 7)
),
d AS (
  SELECT o.opportunity_id, o.location_id, o.status, o.monetary_value,
         NULLIF(c.utm_campaign, '') AS camp,
         NULLIF(c.utm_term, '')     AS term,
         (NULLIF(o.gclid, '')  IS NOT NULL
          OR NULLIF(c.gclid, '')  IS NOT NULL
          OR NULLIF(c.gbraid, '') IS NOT NULL
          OR NULLIF(c.wbraid, '') IS NOT NULL) AS paid
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
mx AS (
  SELECT d.*,
         (SELECT max(so.ord)
            FROM stage_history s
            JOIN so ON so.stage_name = lower(s.stage_name)
           WHERE s.opportunity_id = d.opportunity_id
             AND s.location_id    = d.location_id
             AND NOT s.deleted AND NOT s.ghost_opportunity
             AND COALESCE(s.closed_reason, '') <> 'correction') AS max_ord
    FROM d
   WHERE paid
),
by_campaign AS (
  SELECT location_id, 'campaign' AS grouped_by,
         COALESCE(camp, '(no campaign)') AS group_value,
         count(*)                                                    AS paid_enquiries,
         count(*) FILTER (WHERE COALESCE(max_ord, 0) <= 2)           AS stuck_pre_qualification,
         count(*) FILTER (WHERE COALESCE(max_ord, 0) IN (3, 4))      AS reached_pre_quote,
         count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5)           AS reached_quote,
         count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 6)           AS reached_negotiation,
         count(*) FILTER (WHERE status = 'won')                      AS won,
         sum(monetary_value) FILTER (WHERE status = 'open')          AS open_value
    FROM mx GROUP BY location_id, camp
),
by_term AS (
  SELECT location_id, 'search term' AS grouped_by,
         COALESCE(term, '(no term)') AS group_value,
         count(*),
         count(*) FILTER (WHERE COALESCE(max_ord, 0) <= 2),
         count(*) FILTER (WHERE COALESCE(max_ord, 0) IN (3, 4)),
         count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5),
         count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 6),
         count(*) FILTER (WHERE status = 'won'),
         sum(monetary_value) FILTER (WHERE status = 'open')
    FROM mx GROUP BY location_id, term
),
combined AS (
  SELECT * FROM by_campaign UNION ALL SELECT * FROM by_term
)
SELECT location_id, grouped_by, group_value,
       paid_enquiries,
       stuck_pre_qualification, reached_pre_quote, reached_quote, reached_negotiation,
       won,
       open_value,
       round(100.0 * reached_quote / NULLIF(paid_enquiries, 0))
         AS pct_reached_quote,
       -- The traffic-quality signal. High here means the campaign is buying
       -- enquiries that never become conversations — a targeting problem, not
       -- a sales one.
       round(100.0 * stuck_pre_qualification / NULLIF(paid_enquiries, 0))
         AS pct_stuck_pre_qualification
  FROM combined;

COMMENT ON VIEW vw_paid_enquiry_progression IS
  'Paid enquiries by campaign and by search term, bucketed by the furthest stage they reached. Answers how far paid traffic gets, where the campaign-value view (vw_paid_campaign_performance) answers what it earned. A deal appears once per grouping — never total across both.';

COMMENT ON COLUMN vw_paid_enquiry_progression.grouped_by IS
  'Whether this row groups by "campaign" or by "search term". The two cover the same enquiries from different angles — report one at a time.';
COMMENT ON COLUMN vw_paid_enquiry_progression.group_value IS
  'The campaign ID or search term itself. A campaign ID is Google''s number, not a name — decoding needs the Windsor map.';
COMMENT ON COLUMN vw_paid_enquiry_progression.stuck_pre_qualification IS
  'Enquiries that never got past Initial Contact Made. A high share means the campaign is buying traffic that does not turn into conversations.';
COMMENT ON COLUMN vw_paid_enquiry_progression.pct_stuck_pre_qualification IS
  'Share of the campaign''s enquiries that never became a conversation. The clearest signal of a targeting problem as opposed to a sales one.';
COMMENT ON COLUMN vw_paid_enquiry_progression.pct_reached_quote IS
  'Share of the campaign''s enquiries that got as far as a quote. The clearest signal that its traffic is genuinely in-market.';
