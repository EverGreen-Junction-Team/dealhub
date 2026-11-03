-- 108_vw_product_type_conversion.sql
--
-- Conversion and won value per product type. product_type is a JSONB array
-- (promoted from TEXT in 027), so a deal ticked with two products is counted
-- under both. Built to be exposed to the AI as a skill (see 083).
--
-- ── THE COUNTS DO NOT ADD UP, AND THAT IS CORRECT ────────────────────
-- Unnesting means the rows double-count by design: one deal worth £40k with
-- Bifold Door and Casement Window ticked contributes £40k to each. Summing
-- won_value down the column gives a figure larger than the business took, and
-- summing deals gives more deals than exist.
--
-- This is the right shape for "which products convert" and the wrong shape
-- for "what did we sell" — and nothing in a table of numbers says which you
-- are looking at. So the view carries the account's real totals on every row
-- (account_deals, account_won_value) and the skill tells the AI to answer
-- totals from those and per-product questions from the unnested rows. Without
-- that, the obvious reading of the column is wrong.
--
-- ── COVERAGE IS NOT OPTIONAL HERE ────────────────────────────────────
-- The source made coverage a separate Part A, and it cannot be separate. Deals
-- with no product ticked are dropped by the unnest entirely — silently. If
-- 30% of deals carry no product type, every rate below describes the 70% that
-- do, and a reader has no way to tell.
--
-- Worse, the missing ones are not random: reps tick products on deals they
-- work properly. So the deals that vanish skew toward the neglected ones, and
-- every win rate here reads slightly high. pct_deals_with_product sits on
-- every row and the skill requires it to be quoted.
--
-- ── jsonb_typeof GUARD, KEPT ─────────────────────────────────────────
-- The source's `jsonb_typeof(product_type) = 'array'` test is not defensive
-- padding: 027 backfilled these columns by wrapping legacy TEXT values with
-- to_jsonb(ARRAY[...]), but nothing constrains what the live sync writes, and
-- jsonb_array_elements_text raises a hard error on a scalar rather than
-- returning nothing. One malformed row would take out the whole view. Kept,
-- and non-array values are counted as malformed_product_type rather than
-- passed over in silence.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped products with fewer than five deals. Inside a view that
-- is a floor nobody can see or change, and here it removes the newest
-- products — exactly the ones someone asks about. deals is returned; the skill
-- exposes min_deals.
--
-- ── lower(), KEPT — AND WHAT IT COSTS ────────────────────────────────
-- Folding case merges 'Bifold Door' with 'bifold door', which is right. It
-- also means the label shown is whatever casing lower() produces, so the AI is
-- told to present these as product names rather than quoting them as written.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

CREATE OR REPLACE VIEW vw_product_type_conversion
  WITH (security_invoker = true) AS
WITH live AS (
  SELECT o.location_id, o.status, o.monetary_value, o.product_type
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
-- The account's real figures, computed BEFORE the unnest, so they survive the
-- double-counting intact.
totals AS (
  SELECT location_id,
         count(*)                                             AS account_deals,
         count(*) FILTER (WHERE status = 'won')               AS account_won,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS account_won_value,
         count(*) FILTER (WHERE jsonb_typeof(product_type) = 'array'
                            AND jsonb_array_length(product_type) > 0)
                                                              AS deals_with_product,
         count(*) FILTER (WHERE product_type IS NOT NULL
                            AND jsonb_typeof(product_type) <> 'array')
                                                              AS malformed_product_type
    FROM live
   GROUP BY location_id
),
d AS (
  SELECT l.location_id, l.status, l.monetary_value,
         lower(btrim(jsonb_array_elements_text(l.product_type))) AS pt
    FROM live l
   WHERE jsonb_typeof(l.product_type) = 'array'
     AND jsonb_array_length(l.product_type) > 0
),
per_product AS (
  SELECT location_id,
         NULLIF(pt, '')                                       AS product_type,
         count(*)                                             AS deals,
         count(*) FILTER (WHERE status = 'won')               AS won,
         count(*) FILTER (WHERE status IN ('lost','abandoned')) AS lost_abandoned,
         count(*) FILTER (WHERE status = 'open')              AS open_deals,
         round(100.0 * count(*) FILTER (WHERE status = 'won')
               / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                              AS won_per_closed_pct,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS won_value,
         round(avg(monetary_value) FILTER (WHERE status = 'won'
                                             AND monetary_value > 0))
                                                              AS avg_won_value,
         count(*) FILTER (WHERE status = 'won'
                            AND COALESCE(monetary_value, 0) = 0)
                                                              AS won_value_missing
    FROM d
   GROUP BY location_id, NULLIF(pt, '')
)
SELECT p.location_id,
       COALESCE(p.product_type, '(blank product)')            AS product_type,
       p.deals, p.won, p.lost_abandoned, p.open_deals,
       p.won_per_closed_pct, p.won_value, p.avg_won_value, p.won_value_missing,
       -- Account totals, the same on every row. Answer "how much did we sell"
       -- from these, never by adding won_value down the column.
       t.account_deals,
       t.account_won,
       t.account_won_value,
       t.deals_with_product,
       round(100.0 * t.deals_with_product / NULLIF(t.account_deals, 0))
                                                              AS pct_deals_with_product,
       t.malformed_product_type
  FROM per_product p
  JOIN totals t
    ON t.location_id = p.location_id;

COMMENT ON VIEW vw_product_type_conversion IS
  'Deals, win rate and won value per product type. A deal ticked with several products is counted under each, so these rows deliberately do not sum to the business total — use account_deals and account_won_value for totals, and these rows only for comparing products. Deals with no product ticked are absent entirely; pct_deals_with_product says how much of the pipeline that leaves out.';

COMMENT ON COLUMN vw_product_type_conversion.deals IS
  'Deals with this product ticked. A deal with several products appears under each, so adding this column up gives more deals than exist — account_deals is the real figure.';
COMMENT ON COLUMN vw_product_type_conversion.won_value IS
  'Won value of deals with this product ticked. A deal ticked with two products contributes its full value to both rows, so this column does not sum to revenue — account_won_value does.';
COMMENT ON COLUMN vw_product_type_conversion.pct_deals_with_product IS
  'Share of the account''s deals that have any product ticked. Every rate in this view describes only those deals. Quote it — and note that products tend to be ticked on deals that were worked properly, so the deals left out skew toward neglected ones and these win rates read a little high.';
COMMENT ON COLUMN vw_product_type_conversion.malformed_product_type IS
  'Deals whose product_type is set but is not a JSON array — a sync writing an unexpected shape. They are excluded from every row here. Non-zero means the data needs looking at.';
COMMENT ON COLUMN vw_product_type_conversion.won_value_missing IS
  'Won deals carrying this product with no value recorded. Excluded from avg_won_value so a missing figure does not read as a free job, but present in the win count.';

-- ─────────────────────────────────────────────────────────────────────
-- Sibling: the same shape over product_system — the brand or material
-- (Crittall, Cortizo, Genosal) rather than the product (Bifold Door,
-- Casement Window). 001_schema keeps them as separate fields and the source's
-- Part A measured coverage of both, so both get a view.
--
-- Two views rather than one with a dimension column, deliberately: a single
-- view would need the two fields unnested together, which multiplies the
-- double-counting — a deal with two products and two systems would produce
-- four rows. Kept apart, each view double-counts along one axis only, which
-- is explicable.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_product_system_conversion
  WITH (security_invoker = true) AS
WITH live AS (
  SELECT o.location_id, o.status, o.monetary_value, o.product_system
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
totals AS (
  SELECT location_id,
         count(*)                                             AS account_deals,
         count(*) FILTER (WHERE status = 'won')               AS account_won,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS account_won_value,
         count(*) FILTER (WHERE jsonb_typeof(product_system) = 'array'
                            AND jsonb_array_length(product_system) > 0)
                                                              AS deals_with_system,
         count(*) FILTER (WHERE product_system IS NOT NULL
                            AND jsonb_typeof(product_system) <> 'array')
                                                              AS malformed_product_system
    FROM live
   GROUP BY location_id
),
d AS (
  SELECT l.location_id, l.status, l.monetary_value,
         lower(btrim(jsonb_array_elements_text(l.product_system))) AS ps
    FROM live l
   WHERE jsonb_typeof(l.product_system) = 'array'
     AND jsonb_array_length(l.product_system) > 0
),
per_system AS (
  SELECT location_id,
         NULLIF(ps, '')                                       AS product_system,
         count(*)                                             AS deals,
         count(*) FILTER (WHERE status = 'won')               AS won,
         count(*) FILTER (WHERE status IN ('lost','abandoned')) AS lost_abandoned,
         count(*) FILTER (WHERE status = 'open')              AS open_deals,
         round(100.0 * count(*) FILTER (WHERE status = 'won')
               / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                              AS won_per_closed_pct,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS won_value,
         round(avg(monetary_value) FILTER (WHERE status = 'won'
                                             AND monetary_value > 0))
                                                              AS avg_won_value,
         count(*) FILTER (WHERE status = 'won'
                            AND COALESCE(monetary_value, 0) = 0)
                                                              AS won_value_missing
    FROM d
   GROUP BY location_id, NULLIF(ps, '')
)
SELECT p.location_id,
       COALESCE(p.product_system, '(blank system)')           AS product_system,
       p.deals, p.won, p.lost_abandoned, p.open_deals,
       p.won_per_closed_pct, p.won_value, p.avg_won_value, p.won_value_missing,
       t.account_deals,
       t.account_won,
       t.account_won_value,
       t.deals_with_system,
       round(100.0 * t.deals_with_system / NULLIF(t.account_deals, 0))
                                                              AS pct_deals_with_system,
       t.malformed_product_system
  FROM per_system p
  JOIN totals t
    ON t.location_id = p.location_id;

COMMENT ON VIEW vw_product_system_conversion IS
  'Deals, win rate and won value per product system — the brand or material (Crittall, Cortizo, Genosal), not the product shape. A deal ticked with several systems is counted under each, so these rows do not sum to the business total; use account_deals and account_won_value for that. Deals with no system ticked are absent entirely — pct_deals_with_system says how many.';

COMMENT ON COLUMN vw_product_system_conversion.pct_deals_with_system IS
  'Share of the account''s deals that have any product system ticked. Every rate here describes only those deals — quote it alongside.';
COMMENT ON COLUMN vw_product_system_conversion.won_value IS
  'Won value of deals carrying this system. A deal ticked with two systems contributes its full value to both rows, so this column does not sum to revenue — account_won_value does.';
