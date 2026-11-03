-- 117_vw_by_period.sql
--
-- Month-by-month versions of the questions that HAVE a timestamp: won value,
-- deals created, deals closed. Built to be exposed to the AI as skills (083).
--
-- ── WHY THESE ARE NOT SNAPSHOTS ──────────────────────────────────────
-- 116 exists because pipeline STATE is unrecoverable: a deal that gets a task
-- booked simply changes, and yesterday's "no task" is gone.
--
-- These questions are the opposite. A deal that was won in August carries
-- won_at = August forever. The full history is already in the data and always
-- was — the existing views just aggregate over all time and throw the period
-- away. So these need no capture job, no waiting, and they cover every month
-- the CRM has ever held, including months before any snapshot existed.
--
-- The split matters when answering: "how has our win rate changed" is a real
-- question with a real answer going back years; "has our no-task rate improved"
-- can only be answered from the day 116's job first ran.
--
-- ── MONTHS, NOT WEEKS ────────────────────────────────────────────────
-- date_trunc('month'), because that is the unit people compare in and because
-- a glazing sales cycle is long enough that weekly buckets are mostly noise.
-- A month is also a unit everyone reads the same way, which "last 30 days"
-- is not.
--
-- ── GAPS ARE REAL AND MUST NOT BE FILLED ─────────────────────────────
-- A month with no won deals produces NO ROW, not a zero. Generating a zero row
-- for every empty month would make "we won nothing in July" and "July is
-- missing from this account's data" look identical, and they are not the same
-- finding. The skills tell the AI to say a month is absent rather than to
-- report it as zero.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Won value by month, with the prior month alongside.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_won_value_by_month
  WITH (security_invoker = true) AS
WITH m AS (
  SELECT o.location_id,
         date_trunc('month', o.won_at)::date                  AS month,
         count(*)                                             AS won_deals,
         sum(o.monetary_value)                                AS won_value,
         round(avg(o.monetary_value) FILTER (WHERE o.monetary_value > 0))
                                                              AS avg_won_value,
         count(*) FILTER (WHERE COALESCE(o.monetary_value, 0) = 0)
                                                              AS won_value_missing,
         -- How long these took, from creation to win. A month whose wins were
         -- all long-running deals is a different month from one that closed
         -- quickly, even at the same total.
         round(percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(epoch FROM o.won_at - o.created_at_ghl) / 86400
             )::numeric, 0)                                   AS median_days_to_win
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'won'
     AND o.won_at IS NOT NULL
   GROUP BY o.location_id, date_trunc('month', o.won_at)::date
)
SELECT location_id, month, won_deals, won_value, avg_won_value,
       won_value_missing, median_days_to_win,
       -- lag over the PREVIOUS ROW PRESENT, which is the previous month that
       -- had any wins — not necessarily last month. months_since_previous says
       -- which, so a comparison across a gap is never presented as consecutive.
       (EXTRACT(year FROM month) * 12 + EXTRACT(month FROM month))
       - (EXTRACT(year FROM lag(month) OVER w) * 12 + EXTRACT(month FROM lag(month) OVER w))
                                                              AS months_since_previous,
       won_deals - lag(won_deals) OVER w                      AS won_deals_change,
       won_value - lag(won_value) OVER w                      AS won_value_change,
       round(100.0 * (won_value - lag(won_value) OVER w)
             / NULLIF(lag(won_value) OVER w, 0))              AS won_value_change_pct
  FROM m
WINDOW w AS (PARTITION BY location_id ORDER BY month);

COMMENT ON VIEW vw_won_value_by_month IS
  'Won deals and value per calendar month, with the change from the previous month that had wins. Covers the full history — won_at is on the deal, so nothing had to be captured in advance. A month with no wins produces no row rather than a zero: absent means nothing was won OR nothing is recorded, and those differ.';

COMMENT ON COLUMN vw_won_value_by_month.months_since_previous IS
  'Months between this row and the one it is compared against. 1 is consecutive. Anything larger means intervening months had no won deals at all — say so rather than describing the change as month-on-month.';
COMMENT ON COLUMN vw_won_value_by_month.median_days_to_win IS
  'Typical days from deal creation to win, for deals won in this month. A rising figure with flat value means deals are taking longer for the same return.';
COMMENT ON COLUMN vw_won_value_by_month.won_value_missing IS
  'Won deals this month with no value recorded. They are in won_deals but contribute nothing to won_value, which is why a month can look weak on value and strong on count.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Enquiries created by month, with what became of them.
--
-- Grouped by CREATION month, so each row follows one intake cohort through to
-- its outcome. That is deliberately different from view 1, which groups by the
-- month a deal was WON: the same deal appears in different months in each, and
-- they answer different questions ("what did we bring in" vs "what did we
-- close"). The skills say which is which.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_enquiries_by_month
  WITH (security_invoker = true) AS
WITH m AS (
  SELECT o.location_id,
         date_trunc('month', o.created_at_ghl)::date          AS month,
         count(*)                                             AS enquiries,
         count(*) FILTER (WHERE o.status = 'won')             AS won,
         count(*) FILTER (WHERE o.status = 'lost')            AS lost,
         count(*) FILTER (WHERE o.status = 'abandoned')       AS abandoned,
         count(*) FILTER (WHERE o.status = 'open')            AS still_open,
         sum(o.monetary_value) FILTER (WHERE o.status = 'won') AS won_value,
         round(100.0 * count(*) FILTER (WHERE o.status = 'won')
               / NULLIF(count(*) FILTER (WHERE o.status <> 'open'), 0))
                                                              AS won_per_closed_pct
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.created_at_ghl IS NOT NULL
   GROUP BY o.location_id, date_trunc('month', o.created_at_ghl)::date
)
SELECT location_id, month, enquiries, won, lost, abandoned, still_open,
       won_value, won_per_closed_pct,
       (EXTRACT(year FROM month) * 12 + EXTRACT(month FROM month))
       - (EXTRACT(year FROM lag(month) OVER w) * 12 + EXTRACT(month FROM lag(month) OVER w))
                                                              AS months_since_previous,
       enquiries - lag(enquiries) OVER w                      AS enquiries_change,
       round(100.0 * (enquiries - lag(enquiries) OVER w)
             / NULLIF(lag(enquiries) OVER w, 0))              AS enquiries_change_pct,
       won_per_closed_pct - lag(won_per_closed_pct) OVER w    AS win_rate_change
  FROM m
WINDOW w AS (PARTITION BY location_id ORDER BY month);

COMMENT ON VIEW vw_enquiries_by_month IS
  'Enquiries by the month they arrived, and what became of them. Each row is one intake cohort followed through to outcome — NOT what closed in that month, which is vw_won_value_by_month. Recent months are incomplete by nature: their deals have not had time to close, so their win rates read low and should not be compared with older months.';

COMMENT ON COLUMN vw_enquiries_by_month.still_open IS
  'Enquiries from this month that are still open. High in recent months by definition — those deals have not had time to close, so that month''s win rate is not comparable with an older one.';
COMMENT ON COLUMN vw_enquiries_by_month.won_per_closed_pct IS
  'Won as a share of this cohort''s CLOSED deals. Open deals are excluded, which is why a recent month can show a high rate from very few closed deals — read still_open alongside.';
COMMENT ON COLUMN vw_enquiries_by_month.win_rate_change IS
  'Change in win rate from the previous month, in percentage points. Treat recent months with caution: their cohorts are unfinished.';
