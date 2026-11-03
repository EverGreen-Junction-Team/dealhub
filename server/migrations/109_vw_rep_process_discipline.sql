-- 109_vw_rep_process_discipline.sql
--
-- Three CRM habits on open deals, per rep: is a next action booked, has anyone
-- written a note, are the customer's messages linked to the deal. Built to be
-- exposed to the AI as a skill (see 083).
--
-- ── THREE COLUMNS, NEVER ONE SCORE ───────────────────────────────────
-- Carried from the source's own header. The three are not interchangeable and
-- averaging them produces a number that means nothing: a rep who books every
-- next action but writes no notes is organised and quiet, not 50% compliant.
-- The view exposes no combined figure and the skill text forbids computing
-- one, because a single "discipline score" is the form in which this data
-- would get used badly.
--
-- ── pct_with_assigned_msgs IS NOT A HABIT, AND THAT MATTERS MOST ─────
-- The source counts it beside two things a rep does, which reads as a third
-- thing a rep does. It mostly is not.
--
-- messages.opportunity_id is resolved by GHL's association API, not typed by
-- a rep (015, 017 describe the same mechanism for tasks and notes). A message
-- lands on a deal when GHL links the conversation — which depends on the
-- contact having exactly one open deal, on the association resolver having
-- fired, and on how the conversation started. A rep handling repeat customers
-- with several open deals each will score low here whatever they do.
--
-- So it is kept, because a low figure is still worth seeing, and renamed to
-- say what it measures. The skill tells the AI to read it as data linkage
-- rather than rep behaviour, and never to coach anyone on it.
--
-- ── BUG: THREE JOINS ON opportunity_id ALONE ─────────────────────────
-- The source's t, n and m CTEs each group by opportunity_id with no location
-- in the key, then join on the bare id. opportunity_id is unique per
-- sub-account, not globally (001_schema; every table here is keyed
-- (location_id, opportunity_id)). Two accounts sharing an id merge their
-- tasks, notes and messages before the join happens, and a rep is credited
-- with another account's work. Scoped on both columns throughout.
--
-- ── open_tasks COUNTS ONLY status='open' — KEPT, AND IT IS THE POINT ─
-- A completed task is work done, not a next action booked. The question is
-- whether the deal has somewhere to go next, so only open tasks count. Deals
-- whose only task is overdue still count as having one — booked but late is
-- a different failing, and overdue_next_action is exposed separately rather
-- than folded in.
--
-- ── NAMES FROM users, PER ACCOUNT ────────────────────────────────────
-- Same as 104: names come from the synced users table, so rows are per GHL
-- user ACCOUNT. The source's map collapsed several ids to one person; GHL
-- records no link between a person's accounts, so that cannot be reproduced
-- and is not faked. A person with three logins appears three times.
--
-- Note the source dropped '(unassigned)' here by filtering assigned_to IS NOT
-- NULL — correct for this report, unlike 104's. An unowned deal has nobody
-- whose habits are being measured. Kept, and the excluded count is reported
-- as unassigned_open_deals so the gap is visible.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped accounts with fewer than five open deals. Inside a view
-- that is a floor nobody can see or change; open_deals is returned and the
-- skill exposes min_open_deals.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_rep_process_discipline
  WITH (security_invoker = true) AS
WITH od AS (
  SELECT o.opportunity_id, o.location_id, o.assigned_to
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
     AND o.assigned_to IS NOT NULL
),
t AS (
  SELECT location_id, opportunity_id,
         count(*) FILTER (WHERE status = 'open')              AS open_tasks,
         count(*) FILTER (WHERE status = 'open'
                            AND due_at < now())               AS overdue_tasks
    FROM tasks
   WHERE deleted_at IS NULL
     AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
n AS (
  SELECT location_id, opportunity_id, count(*) AS notes
    FROM notes
   WHERE deleted_at IS NULL
     AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
m AS (
  SELECT location_id, opportunity_id, count(*) AS assigned_msgs
    FROM messages
   WHERE deleted_at IS NULL
     AND opportunity_id IS NOT NULL
     -- Activity rows are system log entries, not messages anyone sent.
     AND COALESCE(message_channel, '') NOT ILIKE '%ACTIVITY%'
   GROUP BY location_id, opportunity_id
),
j AS (
  SELECT od.location_id, od.assigned_to,
         COALESCE(t.open_tasks, 0)    AS open_tasks,
         COALESCE(t.overdue_tasks, 0) AS overdue_tasks,
         COALESCE(n.notes, 0)         AS notes,
         COALESCE(m.assigned_msgs, 0) AS msgs
    FROM od
    -- Every join scoped on location_id as well as opportunity_id.
    LEFT JOIN t ON t.opportunity_id = od.opportunity_id
               AND t.location_id    = od.location_id
    LEFT JOIN n ON n.opportunity_id = od.opportunity_id
               AND n.location_id    = od.location_id
    LEFT JOIN m ON m.opportunity_id = od.opportunity_id
               AND m.location_id    = od.location_id
),
unassigned AS (
  SELECT o.location_id, count(*) AS unassigned_open_deals
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status = 'open'
     AND o.assigned_to IS NULL
   GROUP BY o.location_id
)
SELECT j.location_id,
       COALESCE(u.name, j.assigned_to)                        AS rep_account,
       count(*)                                               AS open_deals,

       round(100.0 * count(*) FILTER (WHERE open_tasks > 0)
             / NULLIF(count(*), 0))                           AS pct_with_next_action,
       round(100.0 * count(*) FILTER (WHERE notes > 0)
             / NULLIF(count(*), 0))                           AS pct_with_a_note,
       round(100.0 * count(*) FILTER (WHERE msgs > 0)
             / NULLIF(count(*), 0))                           AS pct_with_linked_msgs,

       count(*) FILTER (WHERE open_tasks = 0)                 AS no_next_action,
       count(*) FILTER (WHERE notes = 0)                      AS no_note,
       count(*) FILTER (WHERE msgs = 0)                       AS no_linked_msgs,
       -- Booked but late is a different failing from never booked.
       count(*) FILTER (WHERE overdue_tasks > 0)              AS with_overdue_next_action,
       -- The worst case: nothing booked, nothing written.
       count(*) FILTER (WHERE open_tasks = 0 AND notes = 0)   AS no_action_and_no_note,

       COALESCE(ua.unassigned_open_deals, 0)                  AS unassigned_open_deals,
       bool_or(COALESCE(u.active, true) = false
               OR u.deleted_at IS NOT NULL)                   AS is_inactive_user
  FROM j
  LEFT JOIN users u
    ON u.user_id = j.assigned_to
   AND u.location_id = j.location_id
  LEFT JOIN unassigned ua
    ON ua.location_id = j.location_id
 GROUP BY j.location_id, COALESCE(u.name, j.assigned_to),
          COALESCE(ua.unassigned_open_deals, 0);

COMMENT ON VIEW vw_rep_process_discipline IS
  'Three separate CRM habits on each rep''s open deals: a next action booked, a note written, and the customer''s messages linked to the deal. Report the three apart — never average them into one score. One row per GHL user account within one sub-account; a person holding several accounts appears several times.';

COMMENT ON COLUMN vw_rep_process_discipline.pct_with_next_action IS
  'Share of this account''s open deals with at least one task still open. A completed task is work done, not a next action booked, so it does not count here. This is the habit most worth coaching — a deal with nothing booked is a deal with nowhere to go.';
COMMENT ON COLUMN vw_rep_process_discipline.pct_with_a_note IS
  'Share of open deals with any note written. Notes are rep-authored context, so this measures whether what was learned is being written down anywhere another person could read it.';
COMMENT ON COLUMN vw_rep_process_discipline.pct_with_linked_msgs IS
  'Share of open deals with at least one message linked to them. NOT a rep habit: GHL''s association resolver links conversations to deals, not the rep, and it depends on the contact having one open deal rather than several. Read it as how well the data is joined up, not how well someone works. Never coach anyone on this figure.';
COMMENT ON COLUMN vw_rep_process_discipline.with_overdue_next_action IS
  'Open deals whose next action is booked but past due. Counted as having a next action above — booked-but-late is a different failing from never booked, and worth naming separately.';
COMMENT ON COLUMN vw_rep_process_discipline.no_action_and_no_note IS
  'Open deals with nothing booked and nothing written. The deals most likely to be quietly forgotten.';
COMMENT ON COLUMN vw_rep_process_discipline.unassigned_open_deals IS
  'Open deals in this sub-account with no owner at all. Not attributable to any rep, so they are excluded from the rates here — but they are the deals least likely to be worked. The same figure on every row.';
