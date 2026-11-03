-- 112_vw_rep_field_completeness.sql
--
-- Four fields left empty on open deals, per rep. Built to be exposed to the
-- AI as a skill (see 083).
--
-- ── THESE ARE NOT THE MANDATORY FIELDS ───────────────────────────────
-- The source says so plainly: "four fields as a stand-in until Charlie
-- supplies the mandatory list". That caveat is the most important thing about
-- this view and the easiest thing to lose — once a number is on a dashboard,
-- nobody remembers it was a placeholder, and "82% complete" gets read as 82%
-- of what the business requires rather than 82% of four fields somebody
-- picked provisionally.
--
-- It cannot be fixed in SQL, so it is carried in three places: this header,
-- the view comment, and the skill description, which instructs the AI to say
-- these are four stand-in fields every time it reports the figure. When the
-- real list arrives, this view changes and the caveat goes.
--
-- ── BUG: AN EMPTY SOURCE COUNTS AS FILLED ────────────────────────────
-- The source tests lead_source_opportunity with nullif(...,''). That column is
-- TEXT holding a POSTGRES ARRAY LITERAL (096 documents this:
-- {"Google Search","Referral"}), so a deal with no source recorded holds the
-- two-character string '{}' — which is not empty, passes the test, and counts
-- as filled.
--
-- The effect is one-directional: missing_source is understated and
-- pct_of_4_filled reads high, so the report says reps are more diligent than
-- they are. Every source-less deal is invisible in the column built to find
-- them. Stripped of braces and quotes before testing here.
--
-- ── pct_of_4_filled IS KEPT, UNLIKE 109's REFUSAL TO COMBINE ─────────
-- 109 refuses to average its three habits because they measure different
-- skills. This is the opposite case and the difference is worth stating: four
-- fields on one form are the same act — filling in the deal record — so "how
-- much of the record is filled" is a real quantity, not an average of unlike
-- things. The per-field counts sit beside it so a single weak field cannot
-- hide inside the total.
--
-- ── value_missing_buyer, KEPT AND EXTENDED ───────────────────────────
-- The source weights the buyer-type gap by money, which is the right instinct:
-- a missing field on a GBP 90k deal matters more than on a GBP 900 one. Kept, and
-- the same figure added for the other three fields, since the argument is not
-- specific to buyer type.
--
-- Note these sum monetary_value where the field is missing — on deals whose
-- own value may itself be missing. value_missing_value is therefore always
-- 0 or NULL by construction and is not reported; missing_value carries that.
--
-- ── NAMES FROM users, PER ACCOUNT ────────────────────────────────────
-- As 104 and 109: names come from the synced users table, so rows are per GHL
-- user ACCOUNT. The source's map collapsed several ids to one person; GHL
-- records no link between a person's accounts, so that is not reproduced.
--
-- assigned_to IS NOT NULL is kept — an unowned deal has no rep whose
-- diligence is in question — and the excluded deals are reported as
-- unassigned_open_deals, because a deal with no owner is the likeliest of all
-- to have empty fields.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped accounts under five open deals. Inside a view that is a
-- floor nobody can see; open_deals is returned and the skill exposes
-- min_open_deals.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_rep_field_completeness
  WITH (security_invoker = true) AS
WITH od AS (
  SELECT o.location_id, o.assigned_to, o.monetary_value,
         CASE WHEN o.monetary_value IS NOT NULL AND o.monetary_value > 0
              THEN 1 ELSE 0 END                               AS has_value,
         -- Braces and quotes stripped first: '{}' is an EMPTY source, not a
         -- filled one.
         CASE WHEN NULLIF(btrim(regexp_replace(
                     COALESCE(o.lead_source_opportunity, ''), '[{}"]', '', 'g')), '')
                   IS NOT NULL
              THEN 1 ELSE 0 END                               AS has_source,
         CASE WHEN jsonb_typeof(o.client_type) = 'array'
               AND jsonb_array_length(o.client_type) > 0
              THEN 1 ELSE 0 END                               AS has_buyer,
         CASE WHEN jsonb_typeof(o.product_type) = 'array'
               AND jsonb_array_length(o.product_type) > 0
              THEN 1 ELSE 0 END                               AS has_product
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
     AND o.assigned_to IS NOT NULL
),
unassigned AS (
  SELECT o.location_id, count(*) AS unassigned_open_deals
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
     AND o.assigned_to IS NULL
   GROUP BY o.location_id
)
SELECT od.location_id,
       COALESCE(u.name, od.assigned_to)                       AS rep_account,
       count(*)                                               AS open_deals,

       count(*) - sum(has_value)                              AS missing_value,
       count(*) - sum(has_source)                             AS missing_source,
       count(*) - sum(has_buyer)                              AS missing_buyer,
       count(*) - sum(has_product)                            AS missing_product,

       round(100.0 * (count(*) - sum(has_value))  / NULLIF(count(*), 0)) AS pct_missing_value,
       round(100.0 * (count(*) - sum(has_source)) / NULLIF(count(*), 0)) AS pct_missing_source,
       round(100.0 * (count(*) - sum(has_buyer))  / NULLIF(count(*), 0)) AS pct_missing_buyer,
       round(100.0 * (count(*) - sum(has_product))/ NULLIF(count(*), 0)) AS pct_missing_product,

       -- Four fields on one form are one act, so a combined figure is a real
       -- quantity here — unlike 109's three habits, which are not.
       round(100.0 * sum(has_value + has_source + has_buyer + has_product)
             / NULLIF(4 * count(*), 0))                       AS pct_of_4_filled,
       -- The deals with nothing filled at all.
       count(*) FILTER (WHERE has_value + has_source + has_buyer + has_product = 0)
                                                              AS none_of_4_filled,

       -- Weighted by money: a gap on a large deal costs more.
       sum(monetary_value) FILTER (WHERE has_buyer = 0)       AS value_missing_buyer,
       sum(monetary_value) FILTER (WHERE has_source = 0)      AS value_missing_source,
       sum(monetary_value) FILTER (WHERE has_product = 0)     AS value_missing_product,

       COALESCE(ua.unassigned_open_deals, 0)                  AS unassigned_open_deals,
       bool_or(COALESCE(u.active, true) = false
               OR u.deleted_at IS NOT NULL)                   AS is_inactive_user
  FROM od
  LEFT JOIN users u
    ON u.user_id = od.assigned_to
   AND u.location_id = od.location_id
  LEFT JOIN unassigned ua
    ON ua.location_id = od.location_id
 GROUP BY od.location_id, COALESCE(u.name, od.assigned_to),
          COALESCE(ua.unassigned_open_deals, 0);

COMMENT ON VIEW vw_rep_field_completeness IS
  'How often four deal fields — value, lead source, buyer type, product type — are left empty on each rep''s open deals. THESE ARE NOT THE BUSINESS''S MANDATORY FIELDS: they are four stand-ins chosen until the real list is supplied, so never present the completeness figure as compliance with a requirement. One row per GHL user account within one sub-account.';

COMMENT ON COLUMN vw_rep_field_completeness.pct_of_4_filled IS
  'Share of the four stand-in fields filled across this account''s open deals. A combined figure is meaningful here because the four are one act — filling in the deal record — but it is four fields somebody picked provisionally, not a compliance score. Always report the per-field counts beside it, since one badly-kept field hides inside the total.';
COMMENT ON COLUMN vw_rep_field_completeness.missing_source IS
  'Open deals with no lead source. The stored value is a Postgres array literal in a text column, so a deal with no source holds "{}" — braces are stripped before testing, or every source-less deal would count as filled.';
COMMENT ON COLUMN vw_rep_field_completeness.value_missing_buyer IS
  'Total value of open deals missing a buyer type. A gap on a large deal costs more than the same gap on a small one, so this ranks differently from the plain count — and more usefully.';
COMMENT ON COLUMN vw_rep_field_completeness.none_of_4_filled IS
  'Open deals with all four fields empty. These are records that exist in name only.';
COMMENT ON COLUMN vw_rep_field_completeness.unassigned_open_deals IS
  'Open deals with no owner, excluded from the rates because no rep''s diligence is in question — but they are the likeliest of all to have empty fields. The same figure on every row.';
