-- 110_vw_lead_map_area_route.sql
--
-- The lead map: postcode area x intake route x outcome. Where enquiries come
-- from geographically, how they arrived, and whether they convert. Built to be
-- exposed to the AI as a skill (see 083).
--
-- ── JOB POSTCODE, NOT THE CUSTOMER'S ADDRESS ─────────────────────────
-- Same correction as 107, and it bites harder here because this view is
-- explicitly a map. The source read contacts.postal_code; 001_schema (line 13)
-- records that the client uses opportunities.postcode — the JOB — and that
-- contact addresses were left in custom_fields deliberately.
--
-- For a glazing business the two diverge exactly where a map is read: a
-- builder, landlord or architect is billed at one address and has the work
-- done at another. Grouped by billing address, a London builder's twelve jobs
-- across the south-east collapse into one area, and a map of where work
-- happens becomes a map of where invoices are sent, with nothing on screen
-- saying so.
--
-- Job postcode preferred, contact address as fallback so deals are not
-- dropped, and pct_from_job_postcode reports which was used.
--
-- ── ROUTE DEFINITION: COPIED FROM 096, NOT REWRITTEN ─────────────────
-- The same first-non-null ladder over the four intake-text fields (026),
-- identical to 096 and 102. Worth stating because the ladder is ORDERED, not
-- exclusive: a contact carrying both a webchat and an enquiries@ text is
-- counted as webchat, because the first branch that matches wins. Where a
-- customer came in twice by different means, only the first rung shows.
--
-- 'created by hand' is the else branch and therefore also catches every deal
-- whose contact row is missing entirely — phone calls, walk-ins, imports and
-- unlinked deals all land there. It is a residual bucket, not a route, and
-- the skill says so.
--
-- ── WHY THIS IS NOT FOLDED INTO 107 ──────────────────────────────────
-- 107 answers "which areas convert"; this answers "which routes work in which
-- areas". Same base, but a view grouped by area alone cannot produce the
-- cross-tab, and one grouped by area x route gives thin, noisy rows for the
-- simpler question. Both exist; the skills point at each other.
--
-- ── THE CROSS-TAB IS THIN, AND THAT IS THE MAIN RISK ─────────────────
-- Splitting deals two ways at once shrinks every cell. An area with 40 deals
-- across five routes averages eight per cell, and a win rate from eight deals
-- is noise. The view returns per-area totals alongside each cell so a cell can
-- be read against its area, and the skill instructs the AI to compare areas or
-- routes separately before quoting any single cell.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped cells under five deals. Inside a view that is an
-- invisible floor, and here it would hide whole areas wherever their deals
-- spread across routes. deals is returned; the skill exposes min_deals.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_lead_map_area_route
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id,
         o.status,
         o.monetary_value,
         upper(regexp_replace(
           COALESCE(NULLIF(btrim(o.postcode), ''), NULLIF(btrim(c.postal_code), ''), ''),
           '[^A-Za-z0-9]', '', 'g'))                          AS pcc,
         (NULLIF(btrim(o.postcode), '') IS NOT NULL)          AS from_job_postcode,
         -- Ordered ladder, identical to 096 and 102. First match wins.
         CASE
           WHEN NULLIF(c.leadform_enquiry_text, '')        IS NOT NULL THEN 'website form'
           WHEN NULLIF(c.webchat_inquiry_text, '')         IS NOT NULL THEN 'webchat'
           WHEN NULLIF(c.enquiries_email_inquiry_text, '') IS NOT NULL THEN 'enquiries@ inbox'
           WHEN NULLIF(c.crittall_email_inquiry_text, '')  IS NOT NULL THEN 'crittall email upload'
           ELSE 'created by hand'
         END                                                  AS route
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id
     -- Scoped on location: contacts is keyed (location_id, contact_id), so the
     -- id is unique per sub-account, not globally. The source had this right.
     AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
a AS (
  SELECT d.*, substring(pcc FROM '^[A-Z]{1,2}') AS area
    FROM d
),
cell AS (
  SELECT location_id,
         COALESCE(area, '(no postcode)')                      AS area,
         route,
         count(*)                                             AS deals,
         count(*) FILTER (WHERE status = 'won')               AS won,
         count(*) FILTER (WHERE status IN ('lost','abandoned')) AS lost_abandoned,
         count(*) FILTER (WHERE status = 'open')              AS open_deals,
         round(100.0 * count(*) FILTER (WHERE status = 'won')
               / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                              AS won_per_closed_pct,
         sum(monetary_value) FILTER (WHERE status = 'won')    AS won_value,
         round(100.0 * count(*) FILTER (WHERE from_job_postcode)
               / NULLIF(count(*), 0))                         AS pct_from_job_postcode
    FROM a
   GROUP BY location_id, COALESCE(area, '(no postcode)'), route
)
SELECT location_id, area, route,
       deals, won, lost_abandoned, open_deals,
       won_per_closed_pct, won_value, pct_from_job_postcode,
       -- The area's totals across all routes, so a thin cell can be read
       -- against the area it sits in rather than on its own.
       sum(deals) OVER (PARTITION BY location_id, area)       AS area_deals,
       sum(won)   OVER (PARTITION BY location_id, area)       AS area_won,
       round(100.0 * deals
             / NULLIF(sum(deals) OVER (PARTITION BY location_id, area), 0))
                                                              AS pct_of_area,
       -- The route's totals across all areas, for the same reason.
       sum(deals) OVER (PARTITION BY location_id, route)      AS route_deals,
       sum(won)   OVER (PARTITION BY location_id, route)      AS route_won
  FROM cell;

COMMENT ON VIEW vw_lead_map_area_route IS
  'Enquiries split by postcode area AND intake route together, with outcome. Cells are thin by nature — splitting twice shrinks every group — so read each against area_deals and route_deals rather than on its own. Areas come from the deal''s job postcode where there is one, the customer''s address otherwise; pct_from_job_postcode says which.';

COMMENT ON COLUMN vw_lead_map_area_route.route IS
  'How the enquiry arrived, from the first intake field the CRM filled. The ladder is ordered, not exclusive: a contact with both a webchat and an enquiries@ text counts as webchat. "created by hand" is the residual — phone calls, walk-ins, imports and deals with no contact record all land there, so it is not a route anyone chose.';
COMMENT ON COLUMN vw_lead_map_area_route.area IS
  'Leading letters of the postcode — SW from SW1A 1AA. Coarse: areas vary hugely in size and population, so deal counts partly measure how big an area is.';
COMMENT ON COLUMN vw_lead_map_area_route.area_deals IS
  'All deals in this area across every route. Use it to judge whether a cell is worth quoting — the same value repeats on each of the area''s rows, so do not add it up.';
COMMENT ON COLUMN vw_lead_map_area_route.route_deals IS
  'All deals on this route across every area. The same value repeats on each of the route''s rows.';
COMMENT ON COLUMN vw_lead_map_area_route.pct_from_job_postcode IS
  'Share of this cell''s deals whose area came from the deal''s own job postcode rather than the customer''s billing address. Low means this row describes where customers are billed, not where the work is.';
