-- 035_stage_history_one_open_repair.sql
--
-- Fixes QA finding C2 — "91 opportunities have two current_stage=true rows."
--
-- Root cause: race in stageHistoryWriter when two opp events land near-
-- simultaneously (live webhook + sync). Both readers see the same open row,
-- both open a new one, second close never runs.
--
-- Two parts here:
--   1. One-time repair — for every (location_id, opportunity_id) that has
--      more than one current_stage=true row, keep the NEWEST row open and
--      close the older ones with closed_reason='correction'.
--   2. Partial unique index — enforces one-open-per-opp at the DB layer.
--      After repair completes, any future race attempt fails with a unique
--      violation. Writer catches that + retries (or logs).
--
-- Repair MUST run before the index creation — the index would reject the
-- existing duplicate rows.

-- ─── Part 1: One-time repair ─────────────────────────────────────────────

WITH duplicates AS (
  SELECT id,
         location_id,
         opportunity_id,
         entered_at,
         ROW_NUMBER() OVER (
           PARTITION BY location_id, opportunity_id
           ORDER BY entered_at DESC, imported_at DESC
         ) AS rn
    FROM stage_history
   WHERE current_stage = true
),
newer_for_older AS (
  -- Pair each "older" (rn > 1) row with the newest row's entered_at so
  -- we can set left_at coherently.
  SELECT d.id            AS old_id,
         d.location_id,
         d.opportunity_id,
         d.entered_at    AS old_entered_at,
         newest.entered_at AS newest_entered_at
    FROM duplicates d
    JOIN duplicates newest
      ON newest.location_id = d.location_id
     AND newest.opportunity_id = d.opportunity_id
     AND newest.rn = 1
   WHERE d.rn > 1
)
UPDATE stage_history sh
   SET current_stage             = false,
       left_at                   = COALESCE(sh.left_at, nfo.newest_entered_at),
       in_stage_duration_seconds = GREATEST(
         0,
         EXTRACT(EPOCH FROM (COALESCE(sh.left_at, nfo.newest_entered_at) - sh.entered_at))::INTEGER
       ),
       closed_reason             = COALESCE(sh.closed_reason, 'correction')
  FROM newer_for_older nfo
 WHERE sh.id = nfo.old_id
   AND sh.current_stage = true;

-- ─── Part 2: Partial unique index — belt-and-braces ─────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS stage_history_one_open_per_opp
  ON stage_history (location_id, opportunity_id)
  WHERE current_stage = true;
