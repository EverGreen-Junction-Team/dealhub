-- 107_vw_conversion_by_area.sql
--
-- Conversion and won value by postcode area — the outward-code letters, so
-- SW1A 1AA groups as SW. Built to be exposed to the AI as a skill (see 083).
--
-- ── WHICH POSTCODE. THE SOURCE USED THE WRONG ONE ────────────────────
-- The source read contacts.postal_code. There are two postcodes here and they
-- mean different things (001_schema, line 13):
--
--   opportunities.postcode   the JOB — where the work is. The client's own
--                            opportunity-level field.
--   contacts.postal_code     the CUSTOMER's address, promoted in 026.
--
-- 001 states the client uses the opportunity-level one and that contact
-- addresses were left in custom_fields deliberately. For a glazing business
-- the two diverge exactly where it matters: a landlord, a builder, an
-- architect or a second-home owner is billed at one address and has the work
-- done at another. Grouped by billing address, a London builder's twelve jobs
-- across the south-east all land in one area, and the map of where work
-- actually happens is wrong in a way nothing on screen reveals.
--
-- This view prefers opportunities.postcode and falls back to the contact's
-- only when the deal has none, because a deal with no job postcode still
-- belongs somewhere and dropping it would silently shrink the totals. Which
-- was used is reported per row as pct_from_job_postcode: at a high value the
-- areas are job sites, at a low one they are mostly billing addresses, and the
-- reader should be told which they are looking at.
--
-- ── AREA IS THE LETTERS ONLY, AND THAT IS COARSE ─────────────────────
-- Kept from the source: substring '^[A-Z]{1,2}' takes SW from SW1A, B from
-- B15. That is a sound grouping for counting — the full outward code would
-- scatter deals across hundreds of thin buckets — but the areas are wildly
-- unequal in size and population, so a high deal count is partly just a
-- bigger area. Fine for "where do we win", misleading as "our best area"
-- without that caveat, which the skill text carries.
--
-- Rejects anything whose first characters are not letters, so a malformed or
-- foreign code becomes NULL rather than a junk bucket. Those deals are
-- counted as no_area rather than vanishing.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped areas with fewer than six deals. Right instinct — a win
-- rate from three deals is noise — but inside a view it is a floor nobody can
-- see or change, and small areas are worth seeing when the question is
-- coverage rather than performance. deals is returned; the skill exposes
-- min_deals as a filter.
--
-- ── avg_won_value EXCLUDES ZEROS, sum DOES NOT ───────────────────────
-- Kept from the source, and worth stating because it looks inconsistent.
-- A won deal with no value recorded should not drag the average toward zero —
-- it is a missing figure, not a free job. But it belongs in the total, which
-- is a sum of what was recorded. won_value_missing says how many are in that
-- gap, so a small total against many wins is explicable rather than puzzling.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_conversion_by_area
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id,
         o.status,
         o.monetary_value,
         -- Job postcode first; the customer's address only as a fallback.
         upper(regexp_replace(
           COALESCE(NULLIF(btrim(o.postcode), ''), NULLIF(btrim(c.postal_code), ''), ''),
           '[^A-Za-z0-9]', '', 'g'))                          AS pcc,
         (NULLIF(btrim(o.postcode), '') IS NOT NULL)          AS from_job_postcode
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
  SELECT d.*,
         -- Letters only, and only where the code actually starts with letters.
         substring(pcc FROM '^[A-Z]{1,2}') AS area
    FROM d
)
SELECT location_id,
       COALESCE(area, '(no postcode)')                        AS area,
       count(*)                                               AS deals,
       count(*) FILTER (WHERE status <> 'open')               AS closed,
       count(*) FILTER (WHERE status = 'open')                AS open_deals,
       count(*) FILTER (WHERE status = 'won')                 AS won,
       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
                                                              AS won_per_closed_pct,
       sum(monetary_value) FILTER (WHERE status = 'won')      AS won_value,
       round(avg(monetary_value) FILTER (WHERE status = 'won'
                                           AND monetary_value > 0))
                                                              AS avg_won_value,
       -- Won deals with no value recorded: excluded from the average, present
       -- in the sum. Explains a total that looks low against the win count.
       count(*) FILTER (WHERE status = 'won'
                          AND COALESCE(monetary_value, 0) = 0) AS won_value_missing,
       -- Whether these areas are job sites or billing addresses.
       round(100.0 * count(*) FILTER (WHERE from_job_postcode)
             / NULLIF(count(*), 0))                           AS pct_from_job_postcode
  FROM a
 GROUP BY location_id, COALESCE(area, '(no postcode)');

COMMENT ON VIEW vw_conversion_by_area IS
  'Deals, win rate and won value grouped by UK postcode area (the leading letters — SW, B, M). Uses the job postcode from the opportunity where there is one, falling back to the customer''s address; pct_from_job_postcode says which. Postcode areas differ enormously in size and population, so deal counts partly reflect how big an area is, not only how well it performs.';

COMMENT ON COLUMN vw_conversion_by_area.area IS
  'The letters at the start of the postcode — SW from SW1A 1AA, B from B15. A coarse grouping: areas vary hugely in size, so a high deal count is partly just a large area. "(no postcode)" means neither the deal nor the customer had a usable one.';
COMMENT ON COLUMN vw_conversion_by_area.pct_from_job_postcode IS
  'Share of these deals whose area came from the opportunity''s own job postcode rather than the customer''s billing address. Low means this row largely describes where customers are billed, not where the work is — say so, since builders, landlords and architects are billed somewhere other than the job.';
COMMENT ON COLUMN vw_conversion_by_area.won_per_closed_pct IS
  'Won as a share of closed deals. Open deals are excluded from the denominator — they have not had their chance yet.';
COMMENT ON COLUMN vw_conversion_by_area.won_value_missing IS
  'Won deals with no value recorded. Left out of avg_won_value so a missing figure does not read as a free job, but they are part of the win count — which is why won_value can look small against won.';
