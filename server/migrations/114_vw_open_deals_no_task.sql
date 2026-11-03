-- 114_vw_open_deals_no_task.sql
--
-- Open deals with nothing booked on them, by stage — and the sweeper list of
-- the deals themselves. Built to be exposed to the AI as two skills (see 083).
--
-- ── WHAT THIS ADDS OVER 109 ──────────────────────────────────────────
-- 109 answers "which REP leaves deals unbooked". This answers "which STAGE
-- leaves deals unbooked", and hands back the list to act on. Same underlying
-- fact, two questions that lead to different actions: 109 points at a person,
-- this points at a step in the process where deals go quiet regardless of who
-- owns them. Both are worth having; neither substitutes for the other.
--
-- ── BUG: THREE JOINS ON BARE IDs ─────────────────────────────────────
-- The source's t and tc CTEs group by opportunity_id / contact_id with no
-- location in the key, then join on the bare id. Both are unique per
-- sub-account, not globally — tasks is keyed (location_id, task_id) with
-- FKs on (location_id, contact_id) and (location_id, opportunity_id)
-- (015_tasks). Two accounts sharing an id merge their tasks before the join
-- happens, and a deal is credited with another account's work.
--
-- The failure is one-directional and quiet: a deal wrongly credited with a
-- task disappears from no_open_task, so the report says the pipeline is
-- better covered than it is. Scoped on both columns throughout.
--
-- ── tc IS THE INTERESTING COLUMN AND THE SOURCE IS RIGHT TO HAVE IT ──
-- A deal can have nothing booked while the CUSTOMER has an open task — the
-- rep booked a call against the contact rather than the deal. That is not a
-- forgotten deal; it is a linkage gap, and treating it as neglect sends
-- someone chasing work that is already scheduled.
--
-- So no_open_task_on_contact_either is the number that matters for chasing,
-- and the plain no_open_task is the number that matters for CRM hygiene. Both
-- are returned, and the skill says which is which. Note the contact-level
-- count deliberately does NOT filter on opportunity_id: a task against the
-- contact with no deal linked is exactly the case being detected.
--
-- ── next_due < now() MISSES DEALS WITH NO DUE DATE ───────────────────
-- Kept, but named. A task with a NULL due_at is never overdue by this test and
-- never will be — it is booked with no date, which is its own kind of not
-- being scheduled. Counted separately as open_task_no_due_date rather than
-- folded into either side.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped stages under five open deals. Inside a view that is a
-- floor nobody can see, and a small stage where every deal is unbooked is a
-- finding, not noise. open_deals is returned; the skill exposes min_deals.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_open_deals_no_task_by_stage
  WITH (security_invoker = true) AS
WITH od AS (
  SELECT o.opportunity_id, o.location_id, o.contact_id, o.monetary_value,
         COALESCE(initcap(lower(s.stage_name)), '(no stage recorded)') AS stage
    FROM opportunities o
    LEFT JOIN stage_history s
      ON s.opportunity_id = o.opportunity_id
     AND s.location_id = o.location_id
     AND s.current_stage
     AND NOT s.deleted
     AND NOT s.ghost_opportunity
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
),
t AS (
  SELECT location_id, opportunity_id,
         count(*) FILTER (WHERE status = 'open')              AS open_tasks,
         count(*)                                             AS tasks_any,
         min(due_at) FILTER (WHERE status = 'open')           AS next_due,
         count(*) FILTER (WHERE status = 'open'
                            AND due_at IS NULL)               AS open_no_due_date
    FROM tasks
   WHERE deleted_at IS NULL
     AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
tc AS (
  -- Deliberately NOT filtered on opportunity_id: a task booked against the
  -- contact with no deal linked is the case this column exists to find.
  SELECT location_id, contact_id,
         count(*) FILTER (WHERE status = 'open')              AS open_tasks_contact
    FROM tasks
   WHERE deleted_at IS NULL
     AND contact_id IS NOT NULL
   GROUP BY location_id, contact_id
),
j AS (
  SELECT d.location_id, d.stage, d.monetary_value,
         COALESCE(t.open_tasks, 0)       AS open_tasks,
         COALESCE(t.tasks_any, 0)        AS tasks_any,
         COALESCE(t.open_no_due_date, 0) AS open_no_due_date,
         t.next_due,
         COALESCE(tc.open_tasks_contact, 0) AS open_tasks_contact
    FROM od d
    LEFT JOIN t  ON t.opportunity_id = d.opportunity_id
                AND t.location_id    = d.location_id
    LEFT JOIN tc ON tc.contact_id    = d.contact_id
                AND tc.location_id   = d.location_id
)
SELECT location_id,
       stage,
       count(*)                                               AS open_deals,
       count(*) FILTER (WHERE open_tasks = 0)                 AS no_open_task,
       -- The chase list: nothing booked on the deal OR on the customer.
       count(*) FILTER (WHERE open_tasks = 0
                          AND open_tasks_contact = 0)         AS no_open_task_anywhere,
       -- Booked against the customer but not the deal — a linkage gap, not
       -- neglect. The difference between the two counts above.
       count(*) FILTER (WHERE open_tasks = 0
                          AND open_tasks_contact > 0)         AS task_on_contact_only,
       count(*) FILTER (WHERE tasks_any = 0)                  AS never_had_a_task,
       count(*) FILTER (WHERE next_due < now())               AS overdue_task,
       -- Booked with no date: never overdue by the test above, and never will
       -- be. Its own kind of unscheduled.
       count(*) FILTER (WHERE open_no_due_date > 0)           AS open_task_no_due_date,

       round(100.0 * count(*) FILTER (WHERE open_tasks = 0)
             / NULLIF(count(*), 0))                           AS pct_no_open_task,
       sum(monetary_value) FILTER (WHERE open_tasks = 0)      AS value_no_task,
       sum(monetary_value) FILTER (WHERE open_tasks = 0
                                     AND open_tasks_contact = 0)
                                                              AS value_no_task_anywhere
  FROM j
 GROUP BY location_id, stage;

COMMENT ON VIEW vw_open_deals_no_task_by_stage IS
  'Open deals with no next action booked, grouped by the stage they sit in, with the value at stake. Use no_open_task_anywhere for chasing — a deal whose customer has an open task is already scheduled, just not linked to the deal — and no_open_task for CRM hygiene. For the deals themselves rather than the counts, use the sweeper list view.';

COMMENT ON COLUMN vw_open_deals_no_task_by_stage.no_open_task IS
  'Open deals with no task still open against the deal itself. A completed task is work done, not a next action booked, so it does not count here.';
COMMENT ON COLUMN vw_open_deals_no_task_by_stage.no_open_task_anywhere IS
  'Open deals with nothing booked against the deal OR the customer. This is the genuine chase list — the deals where nobody has anything scheduled at all.';
COMMENT ON COLUMN vw_open_deals_no_task_by_stage.task_on_contact_only IS
  'Deals with nothing booked on them, but with an open task on the customer. The work is scheduled; it is just not linked to this deal. A linkage problem, not neglect — do not chase these as forgotten.';
COMMENT ON COLUMN vw_open_deals_no_task_by_stage.open_task_no_due_date IS
  'Deals whose open task carries no due date. Never counted as overdue, and never will be — booked but unscheduled, which is worth seeing separately.';
COMMENT ON COLUMN vw_open_deals_no_task_by_stage.value_no_task_anywhere IS
  'Total value of deals with nothing booked anywhere. Usually the number worth acting on — it is money sitting still with nobody due to touch it.';

-- ─────────────────────────────────────────────────────────────────────
-- Companion: the sweeper list — the deals themselves, biggest first.
-- This is the source's Part B, which it left as a commented-out variant to be
-- edited by hand per brand. As a view the location filter is unnecessary:
-- runSkill scopes every query to the caller's sub-account.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_open_deals_no_task_list
  WITH (security_invoker = true) AS
WITH od AS (
  SELECT o.opportunity_id, o.location_id, o.contact_id, o.name AS deal_name,
         o.monetary_value, o.assigned_to, o.assigned_to_name, o.created_at_ghl,
         COALESCE(initcap(lower(s.stage_name)), '(no stage recorded)') AS stage
    FROM opportunities o
    LEFT JOIN stage_history s
      ON s.opportunity_id = o.opportunity_id
     AND s.location_id = o.location_id
     AND s.current_stage
     AND NOT s.deleted
     AND NOT s.ghost_opportunity
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
),
t AS (
  SELECT location_id, opportunity_id,
         count(*) FILTER (WHERE status = 'open') AS open_tasks
    FROM tasks
   WHERE deleted_at IS NULL
     AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
tc AS (
  SELECT location_id, contact_id,
         count(*) FILTER (WHERE status = 'open') AS open_tasks_contact
    FROM tasks
   WHERE deleted_at IS NULL
     AND contact_id IS NOT NULL
   GROUP BY location_id, contact_id
)
SELECT d.location_id,
       d.opportunity_id,
       d.deal_name,
       d.stage,
       COALESCE(d.assigned_to_name, d.assigned_to, '(unassigned)') AS owner,
       c.first_name,
       c.last_name,
       c.company_name,
       d.monetary_value                                       AS value,
       d.created_at_ghl::date                                 AS created,
       (now()::date - d.created_at_ghl::date)                 AS days_open,
       COALESCE(tc.open_tasks_contact, 0)                     AS open_tasks_on_contact
  FROM od d
  LEFT JOIN t  ON t.opportunity_id = d.opportunity_id
              AND t.location_id    = d.location_id
  LEFT JOIN tc ON tc.contact_id    = d.contact_id
              AND tc.location_id   = d.location_id
  LEFT JOIN contacts c ON c.contact_id = d.contact_id
                      AND c.location_id = d.location_id
 WHERE COALESCE(t.open_tasks, 0) = 0;

COMMENT ON VIEW vw_open_deals_no_task_list IS
  'Individual open deals with no next action booked, for chasing. Biggest value first. open_tasks_on_contact above zero means the work IS scheduled, just against the customer rather than this deal — those are a linkage fix, not a chase.';

COMMENT ON COLUMN vw_open_deals_no_task_list.open_tasks_on_contact IS
  'Open tasks booked against this customer but not against this deal. Above zero means somebody has scheduled something — do not present the deal as forgotten.';
COMMENT ON COLUMN vw_open_deals_no_task_list.days_open IS
  'Days since the deal was created. A deal open a long time with nothing booked is the strongest case for chasing.';
