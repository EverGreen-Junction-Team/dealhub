-- 093_vw_stage_conversion.sql
--
-- "What proportion of deals get from each stage to the next?" — the funnel,
-- per pipeline. Built to be exposed to the AI as a skill (see 083).
--
-- ── STAGE ORDER COMES FROM GHL, NOT A HARDCODED LIST ─────────────────
-- The source query ordered stages with a literal VALUES map:
--
--     ('marketing qualified',1),('initial contact made',2), ...
--
-- That works until any of: a stage is renamed in GHL, a brand uses a stage
-- the list does not contain, two brands order their stages differently, or a
-- sub-account runs more than one pipeline. All four are ordinary events, and
-- each one silently drops stages out of the funnel rather than failing —
-- a conversion report missing a stage still looks like a conversion report.
--
-- pipeline_stages.position is GHL's own ordering, synced per location and per
-- pipeline (migration 024). Using it means the funnel matches what a rep sees
-- on their board, in every brand, without anyone maintaining a list.
--
-- Consequence worth knowing: the view is PER PIPELINE. A sub-account with two
-- pipelines gets two funnels, which is correct — their stages are not
-- comparable and averaging them would be meaningless.
--
-- ── REACHED ──────────────────────────────────────────────────────────
-- A deal has "reached" a stage if it ever sat at that stage OR any later one.
-- Measured from the furthest stage it got to, so a deal that skipped a stage
-- still counts as having passed it — which is what a funnel means.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, windows partitioned (087).

CREATE OR REPLACE VIEW vw_stage_conversion
  WITH (security_invoker = true) AS
WITH live_deals AS (
  SELECT o.opportunity_id, o.status, o.location_id, o.pipeline_id
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
-- Every stage GHL knows about, in GHL's own order.
stages AS (
  SELECT ps.location_id, ps.pipeline_id, ps.stage_id,
         ps.name AS stage_name, ps.position AS ord
    FROM pipeline_stages ps
   WHERE ps.is_active
     AND ps.position IS NOT NULL
),
-- How far each deal actually got.
deal_max AS (
  SELECT s.opportunity_id, d.status, d.location_id, d.pipeline_id,
         max(st.ord) AS max_ord
    FROM stage_history s
    JOIN live_deals d
      ON d.opportunity_id = s.opportunity_id
     AND d.location_id    = s.location_id
    JOIN stages st
      ON st.location_id = s.location_id
     AND st.stage_id    = s.stage_id
   WHERE NOT s.deleted
     AND NOT s.ghost_opportunity
     -- A correction row records a mistake being undone, not a deal moving.
     AND COALESCE(s.closed_reason, '') <> 'correction'
   GROUP BY s.opportunity_id, d.status, d.location_id, d.pipeline_id
),
funnel AS (
  SELECT st.location_id, st.pipeline_id, st.ord, st.stage_name,
         count(m.opportunity_id) FILTER (WHERE m.max_ord >= st.ord)
           AS reached,
         count(m.opportunity_id) FILTER (WHERE m.max_ord >= st.ord AND m.status = 'won')
           AS won,
         count(m.opportunity_id) FILTER (WHERE m.max_ord >= st.ord AND m.status = 'open')
           AS still_open,
         -- Died AT this stage, not past it: the deal got no further.
         count(m.opportunity_id) FILTER (
           WHERE m.max_ord = st.ord AND m.status IN ('lost', 'abandoned')
         ) AS died_here
    FROM stages st
    LEFT JOIN deal_max m
      ON m.location_id = st.location_id
     AND m.pipeline_id = st.pipeline_id
   GROUP BY st.location_id, st.pipeline_id, st.ord, st.stage_name
)
SELECT f.location_id,
       p.name                                    AS pipeline,
       f.ord                                     AS stage_position,
       initcap(lower(f.stage_name))              AS stage,
       f.reached,
       f.won,
       f.still_open,
       f.died_here,
       -- Partitioned by pipeline as well as location: the next stage of one
       -- pipeline is not the next stage of another.
       round(100.0 * lead(f.reached) OVER (PARTITION BY f.location_id, f.pipeline_id ORDER BY f.ord)
             / NULLIF(f.reached, 0), 1)          AS pct_to_next,
       round(100.0 * f.won / NULLIF(f.reached, 0), 1)
                                                 AS pct_won_from_here
  FROM funnel f
  LEFT JOIN pipelines p
    ON p.location_id = f.location_id AND p.pipeline_id = f.pipeline_id;

COMMENT ON VIEW vw_stage_conversion IS
  'The funnel: how many deals reached each pipeline stage, how many were won from there, and what proportion carried on to the next stage. Stage order comes from GHL, so it matches the board a rep sees. One funnel per pipeline.';

COMMENT ON COLUMN vw_stage_conversion.reached IS
  'Deals that ever sat at this stage or any later one. A deal that skipped a stage still counts as having passed it.';
COMMENT ON COLUMN vw_stage_conversion.pct_to_next IS
  'Percentage of deals reaching this stage that went on to the next. The drop-off between the two. NULL on the last stage of a pipeline, which has no next.';
COMMENT ON COLUMN vw_stage_conversion.pct_won_from_here IS
  'Percentage of deals reaching this stage that were eventually won. Rises through the funnel — a deal at Negotiation is likelier to close than one at New Lead.';
COMMENT ON COLUMN vw_stage_conversion.died_here IS
  'Deals that got no further than this stage and were marked lost or abandoned.';
