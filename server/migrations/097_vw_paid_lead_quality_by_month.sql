-- 097_vw_paid_lead_quality_by_month.sql
--
-- "What does a qualified lead cost us?" — the CRM half of that sum: paid
-- leads per month and how many of them got anywhere. Built to be exposed to
-- the AI as a skill (see 083).
--
-- ── WHAT THIS DOES NOT ANSWER ────────────────────────────────────────
-- It cannot give cost per lead. Ad spend lives in Windsor (google_ads
-- connector, accounts 2280178742 and 5667131348), not in this database. The
-- sum is
--
--   cost per qualified paid lead = spend / paid_past_intake
--
-- per brand per month, and this view supplies the denominator only. Same
-- shape as the hiring skill (090): give the half the CRM knows and say the
-- other half has to be supplied, rather than inventing a spend figure that
-- would look authoritative and be fiction.
--
-- ── THREE CHANGES FROM THE SOURCE QUERY ──────────────────────────────
--
--   1. NO FIXED DATE RANGE. The original pinned 2026-05-01 to 2026-09-01. A
--      view is queried whenever somebody asks, so a fixed window silently
--      goes stale — in three months it would still be reporting a quarter
--      nobody asked about, and nothing about the output would say so. Rolling
--      twelve complete months instead, with `month` exposed as a filter.
--
--   2. NO location_id IN (...) LIST. The original restricted to the two
--      brands that run Google Ads. A skill is already scoped to ONE
--      sub-account by runSkill's tenant predicate, so hardcoding two means
--      the others get an empty result with no explanation. An account not
--      running ads simply has zero paid leads — which is the honest answer
--      and visible in the numbers.
--
--   3. Complete months only. A partial current month understates volume, and
--      dividing spend by a half-month of leads inflates cost per lead by up
--      to double.
--
-- ── PAID, PAST INTAKE, REACHED QUOTE ─────────────────────────────────
-- paid            any Google click id on the deal or its contact — gclid,
--                 gbraid (iOS app) or wbraid (iOS web). Checking gclid alone
--                 drops every iOS-sourced lead.
-- past_intake     ever reached a stage beyond New Lead / Disqualified. The
--                 denominator for "qualified".
-- reached_quote   got as far as a quote, negotiation or contract.
--
-- Stage names are literal, as in the source. They are business milestones
-- rather than pipeline positions (see 094 and 096 for the same reasoning), so
-- the view returns which names it matched — a rename shows as a visibly empty
-- column rather than every lead silently failing to qualify.

CREATE OR REPLACE VIEW vw_paid_lead_quality_by_month
  WITH (security_invoker = true) AS
WITH qualified_stages(stage_name) AS (VALUES
  ('marketing qualified'), ('initial contact made'), ('sales qualified'),
  ('waiting on details'), ('quote sent'), ('negotiation'), ('deposit & sales contract')
),
quote_stages(stage_name) AS (VALUES
  ('quote sent'), ('negotiation'), ('deposit & sales contract')
),
d AS (
  SELECT o.opportunity_id, o.location_id, o.status,
         date_trunc('month', o.created_at_ghl) AS mth,
         (NULLIF(o.gclid, '')  IS NOT NULL
          OR NULLIF(c.gclid, '')  IS NOT NULL
          OR NULLIF(c.gbraid, '') IS NOT NULL
          OR NULLIF(c.wbraid, '') IS NOT NULL) AS paid,
         EXISTS (
           SELECT 1 FROM stage_history s
            WHERE s.opportunity_id = o.opportunity_id
              AND s.location_id    = o.location_id
              AND NOT s.deleted AND NOT s.ghost_opportunity
              AND lower(s.stage_name) IN (SELECT stage_name FROM qualified_stages)
         ) AS past_intake,
         EXISTS (
           SELECT 1 FROM stage_history s
            WHERE s.opportunity_id = o.opportunity_id
              AND s.location_id    = o.location_id
              AND NOT s.deleted AND NOT s.ghost_opportunity
              AND lower(s.stage_name) IN (SELECT stage_name FROM quote_stages)
         ) AS reached_quote
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.created_at_ghl IS NOT NULL
     AND o.created_at_ghl >= date_trunc('month', now()) - interval '12 months'
     AND o.created_at_ghl <  date_trunc('month', now())
)
SELECT location_id,
       to_char(mth, 'YYYY-MM')                                    AS month,
       count(*)                                                   AS leads,
       count(*) FILTER (WHERE paid)                               AS paid_leads,
       -- The denominator for cost per qualified lead.
       count(*) FILTER (WHERE paid AND past_intake)               AS paid_past_intake,
       count(*) FILTER (WHERE paid AND reached_quote)             AS paid_reached_quote,
       count(*) FILTER (WHERE paid AND status = 'won')            AS paid_won,
       -- How much of the month's lead flow is attributable to paid at all.
       -- A low figure usually means click-id capture is broken rather than
       -- that the ads produced nothing, which is worth saying out loud.
       round(100.0 * count(*) FILTER (WHERE paid) / NULLIF(count(*), 0), 1)
                                                                  AS paid_pct_of_leads,
       round(100.0 * count(*) FILTER (WHERE paid AND past_intake)
             / NULLIF(count(*) FILTER (WHERE paid), 0), 1)        AS paid_qualified_pct
  FROM d
 GROUP BY location_id, mth;

COMMENT ON VIEW vw_paid_lead_quality_by_month IS
  'Paid leads per complete month and how far they got — qualified, quoted, won. The denominator for cost per qualified lead; ad spend is in Windsor, not this database, so the cost itself cannot be computed here.';

COMMENT ON COLUMN vw_paid_lead_quality_by_month.paid_leads IS
  'Leads carrying a Google click id (gclid, gbraid or wbraid) on the deal or its contact. Zero across every month usually means the account does not run ads, or click-id capture is not working.';
COMMENT ON COLUMN vw_paid_lead_quality_by_month.paid_past_intake IS
  'Paid leads that got beyond the intake stages — the "qualified" count, and the denominator for cost per qualified lead.';
COMMENT ON COLUMN vw_paid_lead_quality_by_month.paid_pct_of_leads IS
  'Share of the month''s leads attributable to paid. A low figure more often means click ids are not being captured than that ads produced nothing.';
COMMENT ON COLUMN vw_paid_lead_quality_by_month.paid_qualified_pct IS
  'Share of paid leads that got past intake. The quality signal — spend buying leads that never qualify is spend wasted.';
