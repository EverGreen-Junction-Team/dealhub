-- 099_vw_close_without_win_abandoned_pct.sql
--
-- Adds pct_abandoned to vw_close_without_win_by_stage.
--
-- WHY A NEW MIGRATION RATHER THAN EDITING 087. The runner tracks applied
-- filenames in schema_migrations and skips anything already there, so a change
-- made inside 087 would never run on a server where 087 has been applied —
-- and would run on a fresh one, leaving the two environments with different
-- views and nothing to show why.
--
-- WHY THE COLUMN. pct_abandoned is the inverse of pct_lost_in_stage; they sum
-- to 100. That is not new information, but "68% of the deals that die at this
-- stage were abandoned rather than lost" is the sentence a rep actually wants,
-- and asking the AI to compute 100 minus a column is how it ends up quoting
-- the wrong one. The distinction matters: abandoned means dropped, lost means
-- pursued and beaten, and they call for different responses.
--
-- This is also why the "Lost vs abandoned, by stage" report does NOT get its
-- own skill. Its base is identical to the drop-off view's; a second,
-- near-identical skill would give the AI two tools it cannot reliably choose
-- between, and it would pick wrong some of the time.

-- CREATE OR REPLACE cannot INSERT a column into the middle of a view's column
-- list — it may only append. 087 ends with the three total_* columns, so
-- adding pct_abandoned beside pct_lost_in_stage, where it belongs, is a column
-- rename as far as Postgres is concerned and fails with 42P16. DROP first.
--
-- Safe here: nothing depends on this view (skills read it through runSkill by
-- name, resolved at query time), and both statements run inside the migration
-- runner's single transaction, so a failure rolls back the drop as well.
DROP VIEW IF EXISTS vw_close_without_win_by_stage;

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
       round(100.0 * lost / NULLIF(closed_without_win, 0))      AS pct_lost_in_stage,
       round(100.0 * abandoned / NULLIF(closed_without_win, 0)) AS pct_abandoned,
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
