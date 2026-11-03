-- 087_vw_close_without_win_partition.sql
--
-- Fixes the window functions in 086, which summed across EVERY sub-account.
--
-- 086 wrote `sum(closed_without_win) OVER ()` — an empty OVER() is the whole
-- result set, not the current location. Under row-level security the result
-- set IS one sub-account, so it looked correct in testing. It is wrong the
-- moment RLS does not apply, which is exactly the situation this database is
-- in: the app connects as a role with rolbypassrls = true (see 002's header),
-- so every policy is skipped and the window saw all three brands.
--
-- Observed: BGD's nine stages sum to 160, but the view reported
-- total_closed_without_win = 305 — that is 160 + 122 + 23, every account
-- added together. Every percentage was then computed against that: the top
-- stage read 17% of losses when within BGD it is 33%. Wrong by a factor of
-- two, in a figure a manager would act on.
--
-- PARTITION BY location_id makes the window mean "this sub-account", which is
-- what the column names claim. That is correct under RLS and correct without
-- it — the fix does not depend on which role is connected, which is the point:
-- a number should not change meaning based on how you are authenticated.

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
       -- PARTITION BY location_id, not a bare OVER(): the share is of THIS
       -- sub-account's losses, which is what the column name says.
       round(100.0 * closed_without_win
             / NULLIF(sum(closed_without_win) OVER (PARTITION BY location_id), 0))
         AS pct_of_closed,
       round(100.0 * lost / NULLIF(closed_without_win, 0)) AS pct_lost_in_stage,
       sum(closed_without_win) OVER (PARTITION BY location_id) AS total_closed_without_win,
       sum(lost)               OVER (PARTITION BY location_id) AS total_lost,
       sum(abandoned)          OVER (PARTITION BY location_id) AS total_abandoned
  FROM grouped;

COMMENT ON VIEW vw_close_without_win_by_stage IS
  'Which pipeline stage deals were in when they stopped progressing — marked lost or abandoned — with how many, the lost/abandoned split, each stage''s share of all deals that closed without a win, and the account totals.';
COMMENT ON COLUMN vw_close_without_win_by_stage.pct_of_closed IS
  'This stage as a percentage of every deal THIS sub-account closed without a win. Not a percentage of deals that ENTERED the stage — a high figure means many deals die here, not that this stage has a poor conversion rate.';
COMMENT ON COLUMN vw_close_without_win_by_stage.total_closed_without_win IS
  'Every deal this sub-account closed without a win. The same on every row of that account — use it for a summary line rather than adding the column up.';
