-- 095_vw_paid_campaign_performance.sql
--
-- "Which paid campaigns and search terms actually produce revenue?" — closed-
-- won value grouped by UTM campaign and term, for paid-tagged deals only.
-- Built to be exposed to the AI as a skill (see 083).
--
-- ── WHAT "PAID" MEANS HERE ───────────────────────────────────────────
-- A deal counts as paid if any Google click identifier is present, on either
-- the deal or its contact: gclid (standard), gbraid (iOS app campaigns) or
-- wbraid (iOS web). Three identifiers rather than one because Google splits
-- them by consent and platform — checking gclid alone silently drops every
-- iOS-sourced deal, which on a consumer glazing business is a large share.
--
-- opportunities.gclid is workflow-copied from the contact (migration 027), so
-- it can be set where the contact's is not, and vice versa. Both are checked.
--
-- ── CAMPAIGN IDS ARE NOT NAMES ───────────────────────────────────────
-- contacts.utm_campaign holds Google's campaign ID, not its name. This view
-- returns the raw id; decoding it needs the Windsor google_ads campaign map,
-- which is not in this database. The skill's description tells the AI to
-- present ids as ids rather than inventing names for them — a plausible-
-- looking campaign name that nobody can find in Google Ads is worse than an
-- id somebody has to look up.
--
-- ── reached_quote ────────────────────────────────────────────────────
-- Hardcoded stage names, as the source query has them. Unlike the funnel
-- (093) this cannot use pipeline position: "got as far as a quote" is a
-- business milestone, not a position, and the stages that represent it differ
-- by brand. Same treatment as 094 — the view returns which stage names it
-- matched, so a renamed stage shows as a visibly empty column rather than a
-- silent zero.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

CREATE OR REPLACE VIEW vw_paid_campaign_performance
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.opportunity_id, o.location_id, o.status, o.monetary_value,
         NULLIF(c.utm_campaign, '') AS camp,
         NULLIF(c.utm_term, '')     AS term,
         (NULLIF(o.gclid, '')  IS NOT NULL
          OR NULLIF(c.gclid, '')  IS NOT NULL
          OR NULLIF(c.gbraid, '') IS NOT NULL
          OR NULLIF(c.wbraid, '') IS NOT NULL) AS paid,
         EXISTS (
           SELECT 1 FROM stage_history s
            WHERE s.opportunity_id = o.opportunity_id
              AND s.location_id    = o.location_id
              AND NOT s.deleted
              AND NOT s.ghost_opportunity
              AND lower(s.stage_name) IN ('quote sent', 'negotiation', 'deposit & sales contract')
         ) AS reached_quote
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id
     -- contact_id is unique per sub-account, not globally
     -- (PRIMARY KEY (location_id, contact_id) — 001_schema).
     AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
)
SELECT location_id,
       COALESCE(camp, '(no campaign)') AS campaign_id,
       COALESCE(term, '(no term)')     AS search_term,
       count(*)                                                  AS deals,
       count(*) FILTER (WHERE reached_quote)                      AS reached_quote,
       count(*) FILTER (WHERE status = 'won')                     AS won,
       count(*) FILTER (WHERE status IN ('lost','abandoned'))     AS lost_or_abandoned,
       count(*) FILTER (WHERE status = 'open')                    AS still_open,
       sum(monetary_value) FILTER (WHERE status = 'won')          AS won_value,
       sum(monetary_value) FILTER (WHERE status = 'open')         AS open_value,
       -- The number the spend decision turns on: what a deal from this
       -- campaign is worth on average once won.
       round(avg(monetary_value) FILTER (WHERE status = 'won' AND monetary_value > 0))
                                                                  AS avg_won_value,
       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*), 0), 1)                            AS won_pct
  FROM d
 WHERE paid
 GROUP BY location_id, camp, term;

COMMENT ON VIEW vw_paid_campaign_performance IS
  'Closed-won value by Google campaign ID and search term, for paid-tagged deals only — those carrying a gclid, gbraid or wbraid. campaign_id is Google''s ID, not a name: decoding it needs the Windsor campaign map, which is not in this database.';

COMMENT ON COLUMN vw_paid_campaign_performance.campaign_id IS
  'Google''s campaign ID from utm_campaign, NOT a campaign name. Present it as an id — decoding needs the Windsor google_ads map.';
COMMENT ON COLUMN vw_paid_campaign_performance.search_term IS
  'The search term from utm_term, where one was captured.';
COMMENT ON COLUMN vw_paid_campaign_performance.reached_quote IS
  'Deals from this campaign that got as far as a quote, negotiation or contract — progress short of a win, and the earliest sign a campaign produces real enquiries.';
COMMENT ON COLUMN vw_paid_campaign_performance.won_value IS
  'Total value of deals won from this campaign and term. The figure to weigh against spend.';
COMMENT ON COLUMN vw_paid_campaign_performance.avg_won_value IS
  'Average value of a won deal from this campaign, counting only deals that carry a value.';
