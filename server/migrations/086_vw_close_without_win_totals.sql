-- 086_vw_close_without_win_totals.sql
--
-- Adds the figures the write-up needs but the view made the model derive:
--
--   pct_lost_in_stage  — of the deals that died at THIS stage, what share was
--                        marked lost rather than abandoned. The existing
--                        pct_of_closed answers "how much of our loss is here";
--                        this answers "and what kind of loss is it". Both are
--                        needed to read a stage: "Waiting On Details 48 (34%)
--                        — 13 lost / 35 abandoned" is a different problem from
--                        "Negotiation 12 (8%) — 12 lost / 0 abandoned".
--
--   total_*            — the sub-account's own totals, repeated on every row.
--                        A window function, so no second query and no risk of
--                        the model adding up the column itself and getting it
--                        wrong when the list is truncated to 50 rows.
--
-- Rounded to whole numbers: a stage that is 33.6% of losses is "34%", and a
-- tenth of a percent on a base of 150 deals is noise presented as precision.

CREATE OR REPLACE VIEW vw_close_without_win_by_stage
  WITH (security_invoker = true) AS
WITH closed AS (
  SELECT o.opportunity_id, o.status, o.location_id
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status IN ('lost', 'abandoned')
),
final_stage AS (
  SELECT sh.opportunity_id, sh.stage_name, sh.location_id
    FROM stage_history sh
   WHERE sh.current_stage
     AND NOT sh.deleted
     AND NOT sh.ghost_opportunity
),
grouped AS (
  SELECT c.location_id,
         COALESCE(initcap(lower(f.stage_name)), '(no stage recorded)') AS stage_name,
         count(*)                                          AS closed_without_win,
         count(*) FILTER (WHERE c.status = 'lost')         AS lost,
         count(*) FILTER (WHERE c.status = 'abandoned')    AS abandoned
    FROM closed c
    LEFT JOIN final_stage f
      ON f.opportunity_id = c.opportunity_id
     AND f.location_id = c.location_id
   GROUP BY c.location_id, 2
)
SELECT location_id,
       stage_name,
       closed_without_win,
       lost,
       abandoned,
       round(100.0 * closed_without_win
             / NULLIF(sum(closed_without_win) OVER (), 0)) AS pct_of_closed,
       -- Of the deals that died HERE, how many were lost rather than
       -- abandoned. NULLIF guards a stage with no rows, which cannot happen
       -- given the GROUP BY but costs nothing to be safe about.
       round(100.0 * lost / NULLIF(closed_without_win, 0)) AS pct_lost_in_stage,
       -- The sub-account's totals, so a summary line needs no arithmetic.
       sum(closed_without_win) OVER () AS total_closed_without_win,
       sum(lost)               OVER () AS total_lost,
       sum(abandoned)          OVER () AS total_abandoned
  FROM grouped;

COMMENT ON VIEW vw_close_without_win_by_stage IS
  'Which pipeline stage deals were in when they stopped progressing — marked lost or abandoned — with how many, the lost/abandoned split, each stage''s share of all deals that closed without a win, and the account totals.';

COMMENT ON COLUMN vw_close_without_win_by_stage.pct_of_closed IS
  'This stage as a percentage of every deal this sub-account closed without a win. Not a percentage of deals that ENTERED the stage — a high figure means many deals die here, not that this stage has a poor conversion rate.';
COMMENT ON COLUMN vw_close_without_win_by_stage.pct_lost_in_stage IS
  'Of the deals that died at this stage, the percentage marked lost rather than abandoned. A high figure means deals were pursued and did not close; a low one means they were dropped.';
COMMENT ON COLUMN vw_close_without_win_by_stage.total_closed_without_win IS
  'Every deal this sub-account closed without a win. The same on every row — use it for a summary line rather than adding the column up.';
COMMENT ON COLUMN vw_close_without_win_by_stage.total_lost IS
  'Of the account total, how many were marked lost. The same on every row.';
COMMENT ON COLUMN vw_close_without_win_by_stage.total_abandoned IS
  'Of the account total, how many were marked abandoned. The same on every row.';
