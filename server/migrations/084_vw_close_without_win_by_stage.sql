-- 084_vw_close_without_win_by_stage.sql
--
-- "Where do deals die?" — the stage a deal was sitting in when it was marked
-- lost or abandoned, counted and ranked. Built to be exposed to the AI as a
-- skill (see migration 083).
--
-- ── WHAT CHANGED FROM THE ORIGINAL QUERY, AND WHY ────────────────────
--
-- The query this comes from grouped by location_id across four hardcoded
-- sub-accounts and mapped each to a brand name in a CASE. Neither survives
-- here, for reasons that are the point of the design rather than a limitation
-- of it:
--
--   1. NO CROSS-SUB-ACCOUNT GROUPING. Every AI query runs inside
--      withTenant(locationId), which sets app.location_id and lets row-level
--      security filter to that one sub-account. A view that tries to report
--      four brands at once returns one brand's rows and a misleading
--      percentage — the `pct_of_brand` window would be computed over a
--      partition that RLS has already emptied. Worse, it would LOOK correct.
--      So the view reports one sub-account and says so in its name.
--
--   2. NO location_id -> brand CASE. A brand name hardcoded in a view goes
--      stale the day a fifth location is added, and it puts customer names in
--      schema. The caller already knows which sub-account it is in.
--
--   3. pct_of_stage is computed WITHIN the sub-account, which is what the
--      original intended anyway — `partition by location_id` over a single
--      location is just "of the total".
--
-- If a genuine cross-brand comparison is wanted, that is a separate, deliberate
-- feature: an agency-level endpoint that runs outside withTenant with its own
-- authorisation. It must not arrive by way of a view that quietly sidesteps
-- tenant isolation.
--
-- ── security_invoker ─────────────────────────────────────────────────
-- Mandatory. Without it the view runs as its OWNER and ignores RLS entirely —
-- one sub-account's deals inside another's answer. Migration 042 exists
-- because this was missed once. skillValidator.js refuses to register a view
-- that lacks it, so a skill cannot be built on an unsafe one.

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
  -- The stage row flagged current is where the deal stood when it closed.
  SELECT sh.opportunity_id, sh.stage_name, sh.location_id
    FROM stage_history sh
   WHERE sh.current_stage
     AND NOT sh.deleted
     AND NOT sh.ghost_opportunity
),
grouped AS (
  SELECT c.location_id,
         -- A deal can close without ever having a stage row — imported, or
         -- created and lost before any stage change synced. Naming that case
         -- keeps it visible instead of dropping those deals from the totals.
         COALESCE(initcap(lower(f.stage_name)), '(no stage recorded)') AS stage_name,
         count(*)                                          AS closed_without_win,
         count(*) FILTER (WHERE c.status = 'lost')         AS lost,
         count(*) FILTER (WHERE c.status = 'abandoned')    AS abandoned
    FROM closed c
    LEFT JOIN final_stage f
      ON f.opportunity_id = c.opportunity_id
     -- Joined on location too: opportunity_id is unique per sub-account, not
     -- globally, and a cross-tenant join here would be silent.
     AND f.location_id = c.location_id
   GROUP BY c.location_id, 2
)
SELECT location_id,
       stage_name,
       closed_without_win,
       lost,
       abandoned,
       round(100.0 * closed_without_win
             / NULLIF(sum(closed_without_win) OVER (), 0), 1) AS pct_of_closed
  FROM grouped;

COMMENT ON VIEW vw_close_without_win_by_stage IS
  'Stage each lost/abandoned deal was in when it closed, with counts and share of all closed-without-win deals. One sub-account only — RLS scopes it. Exposed to the AI via an ai_skills row.';
