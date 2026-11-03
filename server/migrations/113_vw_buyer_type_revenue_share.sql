-- 113_vw_buyer_type_revenue_share.sql
--
-- Buyer type: share of leads against share of revenue. The gap between the
-- two is the whole point — a buyer type that is 40% of enquiries and 12% of
-- revenue is taking most of the effort and returning least of the money, and
-- neither figure alone says that. Built to be exposed to the AI as a skill
-- (see 083).
--
-- ── THE SOURCE QUERY IS SOUND ────────────────────────────────────────
-- Worth stating, since most of this set needed correcting. The windows are
-- PARTITION BY location_id rather than a bare OVER(); the totals CTE is
-- computed BEFORE the unnest so the account figures survive double-counting;
-- the jsonb_typeof guard is present; and the header names the one thing that
-- would otherwise mislead — that shares are of TYPED deals only, with the
-- account totals carried through so the gap stays visible. The changes below
-- are the house rules plus two additions, not fixes.
--
-- ── SHARES ARE OF TYPED DEALS, AND THE UNTYPED REST IS REAL ──────────
-- client_type is a JSONB array (027), unnested, so a deal marked both
-- Homeowner and Developer counts under each. Two consequences, both carried
-- into the skill text rather than left for the reader to infer:
--
--   1. The rows do not sum to the account. account_deals and account_won_value
--      carry the real figures; adding the columns up overstates both.
--   2. Deals with NO buyer type are absent entirely. If a third of deals are
--      untyped, every share here describes the other two thirds. The source
--      carried the totals through for exactly this reason; this view also
--      computes pct_deals_typed so the shortfall is a number rather than a
--      subtraction the reader has to do.
--
-- ── WON VALUE SHARE EXCLUDES OPEN PIPELINE, DELIBERATELY ─────────────
-- pct_of_typed_won_value is a share of money actually won. A buyer type
-- carrying a large open pipeline that has not closed yet will look weak here
-- and may not be. open_value is added so that case is visible instead of
-- being mistaken for poor performance.
--
-- ── STAGE PROGRESSION IS PART OF THIS VIEW, NOT A SECOND ONE ────────
-- The "lowest drop-off at Deposit Paid" report groups the same unnested
-- client_type by the same key and asks how far each buyer type gets. Its only
-- new columns are reached_quote and reached_deposit, so it is those two
-- columns here rather than a second view.
--
-- Registering both would hand the AI two skills over one base differing only
-- in whether stage counts are present — the pair it picks wrong between, and
-- the pair that drifts apart the first time one is amended. Same call as 104
-- (which absorbed the narrower rep view) and 099.
--
-- max_ord is the FURTHEST stage the deal ever reached, not where it sits now:
-- a deal that reached Deposit and was moved back still reached it. Computed in
-- the join rather than the source's correlated subquery — one pass instead of
-- one per row, and it lets the stage join be scoped on location_id, which a
-- correlated subquery on opportunity_id alone cannot be.
--
-- Stage order is a literal map, not pipeline_stages.position: "reached a
-- quote" and "reached deposit" are business milestones that mean the same
-- thing across pipelines of different lengths. Same reasoning as 104 and 096.
--
-- ── WHY NOT FOLDED INTO 108 ──────────────────────────────────────────
-- 108 answers "which products convert". This answers "which buyers are worth
-- having", and the lead-share-vs-revenue-share comparison is its own question
-- — a product with a low win rate may still be worth selling, whereas a buyer
-- type consuming 40% of enquiries for 12% of revenue is a routing decision.
-- Same base table, different question, and merging them would need
-- client_type and product_type unnested together, which multiplies the
-- double-counting into rows nobody can read.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source filtered g.deals >= 5. Inside a view that is a floor nobody can
-- see or change, and here it would hide a small buyer type that happens to
-- carry large deals — which is precisely the finding this view exists for.
-- deals is returned; the skill exposes min_deals.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

CREATE OR REPLACE VIEW vw_buyer_type_revenue_share
  WITH (security_invoker = true) AS
WITH so(stage_name, ord) AS (VALUES
  ('marketing qualified', 1), ('initial contact made', 2), ('sales qualified', 3),
  ('waiting on details', 4), ('quote sent', 5), ('negotiation', 6),
  ('deposit & sales contract', 7)
),
live AS (
  SELECT o.opportunity_id, o.location_id, o.status, o.monetary_value, o.client_type
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
-- Account figures, computed BEFORE the unnest so they survive it intact.
tot AS (
  SELECT location_id,
         count(*)                                             AS account_deals,
         count(*) FILTER (WHERE status = 'won')               AS account_won,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS account_won_value,
         count(*) FILTER (WHERE jsonb_typeof(client_type) = 'array'
                            AND jsonb_array_length(client_type) > 0)
                                                              AS deals_typed,
         count(*) FILTER (WHERE client_type IS NOT NULL
                            AND jsonb_typeof(client_type) <> 'array')
                                                              AS malformed_client_type
    FROM live
   GROUP BY location_id
),
typed AS (
  SELECT l.opportunity_id, l.location_id, l.status, l.monetary_value,
         lower(btrim(jsonb_array_elements_text(l.client_type))) AS ct
    FROM live l
   -- Guard is load-bearing: jsonb_array_elements_text raises a hard error on a
   -- scalar rather than returning nothing, so one malformed row would take out
   -- the whole view.
   WHERE jsonb_typeof(l.client_type) = 'array'
     AND jsonb_array_length(l.client_type) > 0
),
-- Furthest stage each deal ever reached. Grouped once, not once per row.
mx AS (
  SELECT t.opportunity_id, t.location_id, t.status, t.monetary_value, t.ct,
         max(so.ord) AS max_ord
    FROM typed t
    LEFT JOIN stage_history s
      ON s.opportunity_id = t.opportunity_id
     -- Scoped on location: opportunity_id is unique per sub-account, not
     -- globally (001_schema). The source's correlated subquery matched on the
     -- bare id, so a colliding id in another account could raise max_ord.
     AND s.location_id = t.location_id
     AND NOT s.deleted
     AND NOT s.ghost_opportunity
     AND COALESCE(s.closed_reason, '') <> 'correction'
    LEFT JOIN so ON so.stage_name = lower(s.stage_name)
   GROUP BY t.opportunity_id, t.location_id, t.status, t.monetary_value, t.ct
),
g AS (
  SELECT location_id,
         NULLIF(ct, '')                                       AS bt,
         count(*)                                             AS deals,
         count(*) FILTER (WHERE status = 'won')               AS won,
         count(*) FILTER (WHERE status IN ('lost','abandoned')) AS lost_abandoned,
         count(*) FILTER (WHERE status = 'open')              AS open_deals,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS won_value,
         sum(monetary_value) FILTER (WHERE status = 'open')   AS open_value,
         round(avg(monetary_value) FILTER (WHERE status = 'won'
                                             AND monetary_value > 0))
                                                              AS avg_won_value,
         round(100.0 * count(*) FILTER (WHERE status = 'won')
               / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                              AS won_per_closed_pct,
         count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5)    AS reached_quote,
         count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 7)    AS reached_deposit,
         round(100.0 * count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5)
               / NULLIF(count(*), 0))                         AS pct_reach_quote,
         round(100.0 * count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 7)
               / NULLIF(count(*), 0))                         AS pct_reach_deposit,
         -- Of those that got as far as a quote, how many went on to deposit.
         -- This is the drop-off the question is about.
         round(100.0 * count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 7)
               / NULLIF(count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5), 0))
                                                              AS pct_quote_to_deposit
    FROM mx
   GROUP BY location_id, NULLIF(ct, '')
)
SELECT g.location_id,
       COALESCE(g.bt, '(blank buyer type)')                   AS buyer_type,
       g.deals, g.won, g.lost_abandoned, g.open_deals,
       g.won_value, g.open_value, g.avg_won_value, g.won_per_closed_pct,
       g.reached_quote, g.reached_deposit,
       g.pct_reach_quote, g.pct_reach_deposit, g.pct_quote_to_deposit,

       -- Shares of TYPED deals, partitioned per sub-account.
       round(100.0 * g.deals
             / NULLIF(sum(g.deals) OVER (PARTITION BY g.location_id), 0))
                                                              AS pct_of_typed_leads,
       round(100.0 * g.won_value
             / NULLIF(sum(g.won_value) OVER (PARTITION BY g.location_id), 0))
                                                              AS pct_of_typed_won_value,
       -- The gap, stated rather than left to be worked out. Positive means
       -- this buyer type returns more revenue than its share of enquiries;
       -- negative means it consumes more effort than it returns.
       round(100.0 * g.won_value
             / NULLIF(sum(g.won_value) OVER (PARTITION BY g.location_id), 0))
       - round(100.0 * g.deals
             / NULLIF(sum(g.deals) OVER (PARTITION BY g.location_id), 0))
                                                              AS revenue_minus_lead_share,

       -- Account totals, the same on every row. Use these for "how many deals"
       -- and "how much did we win", never by adding the columns above.
       t.account_deals,
       t.account_won,
       t.account_won_value,
       t.deals_typed,
       round(100.0 * t.deals_typed / NULLIF(t.account_deals, 0)) AS pct_deals_typed,
       t.malformed_client_type
  FROM g
  JOIN tot t
    ON t.location_id = g.location_id;

COMMENT ON VIEW vw_buyer_type_revenue_share IS
  'Each buyer type''s share of enquiries set against its share of won revenue. The gap between the two is the finding — a type that is 40% of leads and 12% of revenue costs more effort than it returns. Shares are of TYPED deals only; deals with no buyer type are absent, and pct_deals_typed says how many. A deal marked with two buyer types counts under each, so these rows do not sum to the account — account_deals and account_won_value carry the real figures.';

COMMENT ON COLUMN vw_buyer_type_revenue_share.pct_of_typed_leads IS
  'This buyer type''s share of all TYPED deals in the sub-account — not of all deals. Untyped deals are excluded entirely; check pct_deals_typed before treating this as a share of the business.';
COMMENT ON COLUMN vw_buyer_type_revenue_share.pct_of_typed_won_value IS
  'Share of won revenue across typed deals. Money already won — a buyer type with a large open pipeline that has not closed yet looks weak here without being weak, so read open_value beside it.';
COMMENT ON COLUMN vw_buyer_type_revenue_share.revenue_minus_lead_share IS
  'Revenue share minus lead share, in percentage points. Positive means this buyer type returns more than its share of enquiries; negative means it takes more effort than it returns. This is the number the question is actually asking for.';
COMMENT ON COLUMN vw_buyer_type_revenue_share.pct_deals_typed IS
  'Share of the sub-account''s deals that carry any buyer type. Every share in this view describes only those deals — quote it, since untyped deals are invisible here rather than counted as a category.';
COMMENT ON COLUMN vw_buyer_type_revenue_share.malformed_client_type IS
  'Deals whose client_type is set but is not a JSON array. Excluded from every row here. Non-zero means the sync is writing an unexpected shape and the data needs looking at.';

COMMENT ON COLUMN vw_buyer_type_revenue_share.pct_quote_to_deposit IS
  'Of this buyer type''s deals that reached Quote Sent, the share that went on to Deposit & Sales Contract. This is the drop-off figure: a buyer type that quotes well and rarely deposits is losing deals at the commitment step, which is a different problem from never getting quoted.';
COMMENT ON COLUMN vw_buyer_type_revenue_share.reached_deposit IS
  'Deals that ever reached Deposit & Sales Contract, whether or not they sit there now — a deal moved back a stage still reached it.';
COMMENT ON COLUMN vw_buyer_type_revenue_share.pct_reach_quote IS
  'Share of this buyer type''s deals, open ones included, that ever reached Quote Sent. Low means these buyers rarely get far enough to be worth quoting.';
