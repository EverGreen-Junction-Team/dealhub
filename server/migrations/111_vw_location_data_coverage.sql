-- 111_vw_location_data_coverage.sql
--
-- How much location data actually exists, and how much of it is usable. The
-- source query calls this "the constraint" and says to run it first — this
-- view exists so that instruction survives into the AI.
--
-- ── WHY ONLY PART A ──────────────────────────────────────────────────
-- The source's Part B — deals, outcome and won value by postcode area — is
-- already vw_conversion_by_area (107), with the same base, the same letters
-- grouping, and won value included. Registering a second near-identical skill
-- would give the AI two tools it cannot choose between; it would pick wrong
-- some of the time, and the two would drift apart the first time one was
-- amended. Same reasoning as 099, where "lost vs abandoned by stage" became a
-- column rather than its own skill.
--
-- So this migration adds only what 107 does not answer: whether the map can
-- be trusted at all.
--
-- ── THE SOURCE READS THE CUSTOMER'S ADDRESS. BOTH ARE REPORTED ───────
-- 107 and 110 prefer opportunities.postcode (the JOB) over
-- contacts.postal_code (the CUSTOMER), per 001_schema line 13. This view
-- measures both separately and on purpose, because the question here is
-- coverage: knowing that job postcodes are filled on 30% of deals while
-- contact addresses are on 85% is what tells you which field a map should be
-- built from, and neither number is visible if they are merged.
--
-- combined_pct is what 107 and 110 actually achieve with their fallback.
--
-- ── FULL-FORMAT VALIDATION, KEPT ─────────────────────────────────────
-- The source's regex tests for a complete UK postcode (SW1A 1AA), not just an
-- outward code. That distinction matters: 'SW1A' alone is enough to place a
-- deal in an area, which is all 107 and 110 need, but not enough to plot a
-- pin on a map or post anything. Both counted, so "we have postcodes" is not
-- mistaken for "we can map these".
--
-- The pattern is UK-only. A foreign or malformed code counts as present but
-- not full-format, which is the honest reading — it is not necessarily wrong,
-- just not a UK postcode.
--
-- ── won_with_postcode, AND WHY IT IS NOT THE SAME AS OVERALL ─────────
-- Kept from the source. Coverage on won deals is usually higher than overall,
-- because a deal that closes has had an address taken for the work. So a
-- headline coverage figure understates what is known about customers who
-- bought, and overstates what is known about enquiries. Both reported.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_location_data_coverage
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id,
         o.status,
         NULLIF(btrim(o.postcode), '')        AS job_pc,
         NULLIF(btrim(c.postal_code), '')     AS contact_pc,
         NULLIF(btrim(c.city), '')            AS city,
         NULLIF(btrim(c.address1), '')        AS addr
    FROM opportunities o
    LEFT JOIN contacts c
      ON c.contact_id = o.contact_id
     -- Scoped on location: contacts is keyed (location_id, contact_id), so the
     -- id is unique per sub-account, not globally. The source had this right.
     AND c.location_id = o.location_id
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
flagged AS (
  SELECT d.*,
         COALESCE(job_pc, contact_pc)                         AS any_pc,
         -- A complete UK postcode, not merely an outward code.
         (COALESCE(job_pc, contact_pc)
            ~* '^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$')  AS is_full_uk
    FROM d
)
SELECT location_id,
       count(*)                                               AS deals,
       count(*) FILTER (WHERE status = 'won')                 AS won,

       -- The two fields, apart: which one a map should be built from.
       count(job_pc)                                          AS with_job_postcode,
       count(contact_pc)                                      AS with_contact_postcode,
       count(any_pc)                                          AS with_any_postcode,
       round(100.0 * count(job_pc)     / NULLIF(count(*), 0)) AS pct_job_postcode,
       round(100.0 * count(contact_pc) / NULLIF(count(*), 0)) AS pct_contact_postcode,
       -- What 107 and 110 achieve, job postcode with contact address as
       -- fallback. This is the figure their maps actually rest on.
       round(100.0 * count(any_pc)     / NULLIF(count(*), 0)) AS pct_any_postcode,

       count(city)                                            AS with_city,
       count(addr)                                            AS with_address,

       -- Coverage on deals that closed won, usually higher: an address gets
       -- taken when work is booked.
       count(any_pc) FILTER (WHERE status = 'won')            AS won_with_postcode,
       round(100.0 * count(any_pc) FILTER (WHERE status = 'won')
             / NULLIF(count(*) FILTER (WHERE status = 'won'), 0))
                                                              AS pct_won_with_postcode,

       -- Enough to place in an area vs enough to plot or post.
       count(*) FILTER (WHERE is_full_uk)                     AS valid_uk_full,
       count(*) FILTER (WHERE any_pc IS NOT NULL AND NOT is_full_uk)
                                                              AS pc_not_full_format,
       round(100.0 * count(*) FILTER (WHERE is_full_uk)
             / NULLIF(count(any_pc), 0))                      AS pct_of_postcodes_full_format
  FROM flagged
 GROUP BY location_id;

COMMENT ON VIEW vw_location_data_coverage IS
  'How complete the location data is: how many deals carry a job postcode, a customer postcode, a city or an address, and how many of those postcodes are complete UK codes rather than partial. Read this before trusting any map or area breakdown — it is the constraint on all of them. One row per sub-account.';

COMMENT ON COLUMN vw_location_data_coverage.pct_job_postcode IS
  'Share of deals with a postcode on the opportunity itself — where the work is. This is the field the area and map views prefer; a low figure means they are largely falling back to customer addresses.';
COMMENT ON COLUMN vw_location_data_coverage.pct_contact_postcode IS
  'Share of deals whose customer record has a postcode. This is a billing address, not a job address — the two differ for builders, landlords, architects and second homes.';
COMMENT ON COLUMN vw_location_data_coverage.pct_any_postcode IS
  'Share of deals placeable at all, job postcode first and customer address as fallback. This is the coverage the area and map views actually achieve, and the ceiling on how much of the business any map describes.';
COMMENT ON COLUMN vw_location_data_coverage.valid_uk_full IS
  'Deals whose postcode is a complete UK code (SW1A 1AA). Enough to plot or post. A partial code like SW1A still places a deal in an area, which is all the area breakdowns need — so this number is smaller than with_any_postcode without anything being wrong.';
COMMENT ON COLUMN vw_location_data_coverage.pc_not_full_format IS
  'Postcodes present but not a complete UK code — partial, foreign, or mistyped. Usable for grouping by area, not for plotting.';
COMMENT ON COLUMN vw_location_data_coverage.pct_won_with_postcode IS
  'Coverage on won deals only. Usually higher than overall, because an address gets taken once work is booked — so overall coverage understates what is known about customers who bought.';
