-- 094_vw_lead_to_won_ratio.sql
--
-- "What proportion of our leads turn into wins?" — three ratios, because the
-- honest answer depends on what you count. Built to be exposed to the AI as a
-- skill (see 083).
--
--   won_per_lead_pct              wins / every lead created. The headline, and
--                                 the pessimistic one: it counts leads still
--                                 open as if they had already failed.
--   won_per_closed_pct            wins / deals that actually finished. Fairer,
--                                 but still counts junk as a loss.
--   won_per_closed_excl_junk_pct  the same, minus leads lost before anyone
--                                 engaged. The closest to "how good are we at
--                                 the deals we actually work".
--
-- All three are returned rather than one, because picking for the reader is
-- how a conversion rate gets quoted out of context.
--
-- ── WHAT COUNTS AS JUNK ──────────────────────────────────────────────
-- A deal lost while still sitting at "New Lead" or "Disqualified" — never
-- worked, so counting it as a lost sale flatters nobody and distorts the
-- ratio.
--
-- The stage names are matched literally, as the source query did. Unlike the
-- funnel (093), this cannot come from pipeline position: "junk" is a
-- judgement about which stages mean "never engaged", and Disqualified can sit
-- anywhere in a board's order.
--
-- So the view RETURNS WHICH STAGES IT MATCHED, in intake_stages_matched. A
-- brand that renames New Lead gets an empty column and a visibly wrong junk
-- count, rather than a silent zero that reads as "we have no junk leads".
-- That is the whole reason the column exists.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

CREATE OR REPLACE VIEW vw_lead_to_won_ratio
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id, o.status, o.created_at_ghl, o.monetary_value,
         -- The stage the deal is sitting at now, lower-cased for matching.
         (SELECT lower(s.stage_name)
            FROM stage_history s
           WHERE s.opportunity_id = o.opportunity_id
             AND s.location_id    = o.location_id
             AND s.current_stage
             AND NOT s.deleted
             AND NOT s.ghost_opportunity
           LIMIT 1) AS current_stage
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
flagged AS (
  SELECT *, current_stage IN ('new lead', 'disqualified') AS at_intake FROM d
)
SELECT location_id,
       count(*)                                              AS leads,
       count(*) FILTER (WHERE status = 'won')                AS won,
       count(*) FILTER (WHERE status = 'lost')               AS lost,
       count(*) FILTER (WHERE status = 'abandoned')          AS abandoned,
       count(*) FILTER (WHERE status = 'open')               AS still_open,
       count(*) FILTER (WHERE status = 'lost' AND at_intake) AS lost_at_intake,

       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*), 0), 1)                       AS won_per_lead_pct,

       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*) FILTER (WHERE status IN ('won','lost','abandoned')), 0), 1)
                                                             AS won_per_closed_pct,

       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*) FILTER (
                 WHERE status IN ('won','lost','abandoned')
                   AND NOT (status = 'lost' AND at_intake)
               ), 0), 1)                                     AS won_per_closed_excl_junk_pct,

       -- Which stage names the junk rule actually matched in THIS account.
       -- Empty means the rule matched nothing — read the junk figure as
       -- unknown rather than zero.
       (SELECT string_agg(DISTINCT initcap(f2.current_stage), ', ' ORDER BY initcap(f2.current_stage))
          FROM flagged f2
         WHERE f2.location_id = flagged.location_id
           AND f2.at_intake)                                 AS intake_stages_matched,

       min(created_at_ghl)::date                             AS first_lead,
       max(created_at_ghl)::date                             AS last_lead,
       sum(monetary_value) FILTER (WHERE status = 'won')     AS won_value
  FROM flagged
 GROUP BY location_id;

COMMENT ON VIEW vw_lead_to_won_ratio IS
  'Lead-to-won conversion, three ways: per lead created, per deal that finished, and per finished deal excluding leads lost before anyone engaged. All three are given because the right one depends on the question being asked.';

COMMENT ON COLUMN vw_lead_to_won_ratio.won_per_lead_pct IS
  'Wins as a percentage of every lead created. The most pessimistic figure — it counts deals still open as though they had already failed.';
COMMENT ON COLUMN vw_lead_to_won_ratio.won_per_closed_pct IS
  'Wins as a percentage of deals that actually finished. Excludes open deals, but still counts never-worked junk as a loss.';
COMMENT ON COLUMN vw_lead_to_won_ratio.won_per_closed_excl_junk_pct IS
  'Wins as a percentage of finished deals, ignoring leads lost while still at intake. The closest to how well the team converts the deals it genuinely works.';
COMMENT ON COLUMN vw_lead_to_won_ratio.lost_at_intake IS
  'Leads lost while still at New Lead or Disqualified — never worked, so not really lost sales.';
COMMENT ON COLUMN vw_lead_to_won_ratio.intake_stages_matched IS
  'Which stage names the junk rule matched in this sub-account. Empty means it matched nothing — the junk figure should then be read as unknown, not zero, because a stage has probably been renamed.';
