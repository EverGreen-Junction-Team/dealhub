-- 116_pipeline_snapshots.sql
--
-- A daily record of what the pipeline LOOKED LIKE, so "has this improved?" can
-- be answered at all.
--
-- ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────
-- opportunities holds CURRENT STATE. When a rep books a task on a deal, the
-- row changes and the fact that the deal had nothing booked yesterday is gone
-- — not archived, gone. Same for an empty field being filled, a stale note
-- being added, a stagnant deal waking up.
--
-- So questions like "is our no-task rate better than last month?" are not hard
-- to answer, they are IMPOSSIBLE to answer, and no view can fix it. The
-- history was never written down.
--
-- Event-shaped questions are different and do NOT belong here: "won value by
-- month", "deals created last quarter", "response times since August" all have
-- a timestamp on the row already (won_at, created_at_ghl, message_timestamp).
-- Those are answered by grouping the existing views by period — see 117 — and
-- putting them in a snapshot as well would mean two sources for one number,
-- which is how they end up disagreeing.
--
-- The rule: a snapshot row answers "how many deals were in state X on day D".
-- If the question can be answered from a timestamp already on the data, it is
-- not a snapshot question.
--
-- ── WHY ONE WIDE ROW PER DAY, NOT A METRICS KEY/VALUE TABLE ──────────
-- A (location_id, snapshot_date, metric_name, value) table would take new
-- metrics without a migration. It would also let a typo silently create a new
-- metric, make every comparison a self-join, and give the AI no column
-- comments to read. A wide row is a schema change per metric, which is the
-- right amount of friction for a number people will make decisions from.
--
-- ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────
-- No per-rep or per-stage breakdown. Those multiply the row count by the
-- number of reps or stages and answer a question nobody has asked yet
-- ("was Liam's no-task rate worse in August?"). Account-level totals first;
-- a per-rep snapshot can be added later if someone actually wants it. Deleting
-- a dimension is easy, un-collecting a year of rows is not — but neither is
-- collecting a dimension nobody reads.
--
-- ── BACKFILL IS IMPOSSIBLE, AND THAT IS THE POINT ────────────────────
-- There is no historical data to seed this from. The first row lands the day
-- the job first runs and the first month-over-month comparison is possible a
-- month later. Nothing here is retroactive. That is the cost of not having
-- started earlier, and it is also the reason to start now rather than after
-- the period-grouped views are finished.

CREATE TABLE IF NOT EXISTS pipeline_snapshots (
  location_id           TEXT        NOT NULL,
  -- A date, not a timestamp: one row per account per day. The job is
  -- idempotent on this key, so re-running it recomputes today rather than
  -- appending a second reading.
  snapshot_date         DATE        NOT NULL,

  -- ── Pipeline shape ────────────────────────────────────────────────
  open_deals            INT         NOT NULL DEFAULT 0,
  open_value            NUMERIC(14, 2),
  won_deals_total       INT         NOT NULL DEFAULT 0,
  lost_deals_total      INT         NOT NULL DEFAULT 0,
  abandoned_deals_total INT         NOT NULL DEFAULT 0,

  -- ── Hygiene: the state-based figures that are otherwise unrecoverable ──
  open_no_task          INT         NOT NULL DEFAULT 0,
  open_no_task_anywhere INT         NOT NULL DEFAULT 0,
  open_no_notes         INT         NOT NULL DEFAULT 0,
  open_no_reply         INT         NOT NULL DEFAULT 0,
  open_stagnant_30d     INT         NOT NULL DEFAULT 0,
  value_no_task         NUMERIC(14, 2),

  -- ── Field completeness, same four stand-ins as vw_rep_field_completeness ──
  open_missing_value    INT         NOT NULL DEFAULT 0,
  open_missing_source   INT         NOT NULL DEFAULT 0,
  open_missing_buyer    INT         NOT NULL DEFAULT 0,
  open_missing_product  INT         NOT NULL DEFAULT 0,

  -- ── Coverage: how much of the data is usable at all ───────────────
  deals_with_postcode   INT         NOT NULL DEFAULT 0,
  notes_total           INT         NOT NULL DEFAULT 0,
  note_authors          INT         NOT NULL DEFAULT 0,

  -- When the job ran. Distinct from snapshot_date: a job that runs at 02:00
  -- on the 5th writes snapshot_date = the 5th, and this says when.
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (location_id, snapshot_date)
);

COMMENT ON TABLE pipeline_snapshots IS
  'One row per sub-account per day recording pipeline STATE — counts that cannot be reconstructed later because the underlying rows change in place. Event-based figures (won value by month, deals created) are NOT here; they come from timestamps on the data itself. Nothing in this table can be backfilled.';

COMMENT ON COLUMN pipeline_snapshots.snapshot_date IS
  'The day this describes. One row per account per day; re-running the job recomputes the row rather than adding one.';
COMMENT ON COLUMN pipeline_snapshots.open_no_task_anywhere IS
  'Open deals with nothing booked against the deal OR the customer. The genuine chase number — see vw_open_deals_no_task_by_stage for why the plain no-task count is different.';
COMMENT ON COLUMN pipeline_snapshots.open_stagnant_30d IS
  'Open deals with no message in either direction for 30 days, as of that day.';
COMMENT ON COLUMN pipeline_snapshots.open_missing_source IS
  'Open deals with no lead source. The stored value is a Postgres array literal, so an empty source is the string "{}" — stripped before testing, or every source-less deal would count as filled.';
COMMENT ON COLUMN pipeline_snapshots.captured_at IS
  'When the job actually ran, as opposed to the day it describes. A gap between the two means the job ran late or was re-run.';

ALTER TABLE pipeline_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON pipeline_snapshots;
CREATE POLICY tenant_iso ON pipeline_snapshots
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));

CREATE INDEX IF NOT EXISTS pipeline_snapshots_loc_date
  ON pipeline_snapshots (location_id, snapshot_date DESC);

-- ─────────────────────────────────────────────────────────────────────
-- The trend view. Each row is a day, with the change since the previous
-- snapshot alongside, so "is it getting better" is a column rather than
-- something the model has to work out by subtracting two rows it fetched
-- separately — which is where it makes arithmetic mistakes.
--
-- LAG over the PREVIOUS SNAPSHOT, not "yesterday": if the job misses a day the
-- comparison is against the last reading that exists, and days_since_previous
-- says how far back that was. A silent comparison across a four-day gap
-- labelled "daily change" would be worse than no column at all.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_pipeline_trend
  WITH (security_invoker = true) AS
SELECT location_id,
       snapshot_date,
       open_deals,
       open_value,
       won_deals_total,
       open_no_task,
       open_no_task_anywhere,
       open_no_notes,
       open_no_reply,
       open_stagnant_30d,
       value_no_task,
       open_missing_value,
       open_missing_source,
       open_missing_buyer,
       open_missing_product,
       deals_with_postcode,
       notes_total,
       note_authors,

       -- Rates, so a change in the pipeline's size is not read as a change in
       -- how well it is kept. 20 untouched deals out of 50 is worse than 30
       -- out of 200, and the raw counts say the opposite.
       round(100.0 * open_no_task_anywhere / NULLIF(open_deals, 0)) AS pct_no_task,
       round(100.0 * open_no_notes         / NULLIF(open_deals, 0)) AS pct_no_notes,
       round(100.0 * open_stagnant_30d     / NULLIF(open_deals, 0)) AS pct_stagnant,

       -- Change since the previous reading. PARTITION BY location_id, or the
       -- window walks from one sub-account into the next.
       snapshot_date - lag(snapshot_date)
         OVER (PARTITION BY location_id ORDER BY snapshot_date)     AS days_since_previous,
       open_deals - lag(open_deals)
         OVER (PARTITION BY location_id ORDER BY snapshot_date)     AS open_deals_change,
       open_no_task_anywhere - lag(open_no_task_anywhere)
         OVER (PARTITION BY location_id ORDER BY snapshot_date)     AS no_task_change,
       open_no_notes - lag(open_no_notes)
         OVER (PARTITION BY location_id ORDER BY snapshot_date)     AS no_notes_change,
       open_stagnant_30d - lag(open_stagnant_30d)
         OVER (PARTITION BY location_id ORDER BY snapshot_date)     AS stagnant_change,
       round(100.0 * open_no_task_anywhere / NULLIF(open_deals, 0))
         - lag(round(100.0 * open_no_task_anywhere / NULLIF(open_deals, 0)))
           OVER (PARTITION BY location_id ORDER BY snapshot_date)   AS pct_no_task_change,

       captured_at
  FROM pipeline_snapshots;

COMMENT ON VIEW vw_pipeline_trend IS
  'Daily pipeline state with the change since the previous reading. Compare RATES rather than counts — a pipeline that grew will show more untouched deals while being better kept. Only covers days the snapshot job has run: there is no history before its first run and none can be reconstructed.';

COMMENT ON COLUMN vw_pipeline_trend.days_since_previous IS
  'Days between this reading and the one it is compared against. Normally 1. A larger number means the job missed days, and the change columns then span that whole gap — say so rather than calling it a daily change.';
COMMENT ON COLUMN vw_pipeline_trend.pct_no_task_change IS
  'Change in the share of open deals with nothing booked, in percentage points. NEGATIVE IS AN IMPROVEMENT — fewer deals untouched. Say "improved by 4 points", not "fell by 4".';
COMMENT ON COLUMN vw_pipeline_trend.no_task_change IS
  'Change in the COUNT of untouched deals. Moves with pipeline size, so read pct_no_task_change alongside before calling it better or worse.';
