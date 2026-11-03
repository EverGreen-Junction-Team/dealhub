-- 115_vw_open_deals_note_quality.sql
--
-- Open deals with no notes or thin notes, by stage — plus the adoption check
-- the source says to run first. Built to be exposed to the AI as two skills
-- (see 083).
--
-- ── ADOPTION FIRST, AS THE SOURCE INSTRUCTS ──────────────────────────
-- Part A is not context, it is the precondition. If a sub-account has 40 notes
-- across 900 deals, "92% of open deals have no notes" is not a diligence
-- finding — it says the team does not use notes, and chasing individuals for
-- it would be chasing them for not adopting a tool nobody adopted. The two
-- readings call for opposite responses, and the counts alone cannot tell them
-- apart, so adoption gets its own view and the quality skill is told to check
-- it first.
--
-- ── BUG: n JOINS ON BARE opportunity_id ──────────────────────────────
-- The source's n CTE groups by opportunity_id with no location in the key,
-- then joins on the bare id. notes is keyed (location_id, note_id) with an FK
-- on (location_id, opportunity_id) (017_notes), so the id is unique per
-- sub-account, not globally. Two accounts sharing one merge their notes before
-- the join, and a deal is credited with another account's notes.
--
-- One-directional again: a deal wrongly credited drops out of no_notes, so
-- the report reads as better documented than it is. Scoped on both columns.
--
-- ── length(body) IGNORES THE TITLE ───────────────────────────────────
-- 058 promoted notes.title out of raw_note into a real column, backfilled.
-- A note carrying a real title and a short body is not thin — its content is
-- split across two fields, and measuring only body undercounts it.
--
-- Both are measured here: body length as the source has it, and title+body
-- together. thin_notes uses the combined length, because the question is how
-- much was written, not which field it went in.
--
-- ── THE THRESHOLDS ARE ARBITRARY, AND SAID TO BE ─────────────────────
-- 30 characters for a stub, 100 for thin. Nothing in the data justifies those
-- numbers; they are the source's judgement and they are reasonable. But a view
-- makes them look measured, so both the counts and the raw median length are
-- returned, and the skill is told to quote a threshold as a choice rather than
-- a standard.
--
-- ── note_older_30d MISSES DEALS WITH NO NOTES AT ALL ─────────────────
-- Kept as written, and it is correct: n.last_note is NULL for a deal with no
-- notes, and NULL < now() - 30 days is NULL, not true. So the column counts
-- deals that WERE documented and then went quiet, which is the distinct
-- finding — a deal never documented is already in no_notes. Named here because
-- it reads like an omission and is not.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped stages under five open deals. Inside a view that is a
-- floor nobody can see; open_deals is returned and the skill exposes min_deals.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_note_adoption
  WITH (security_invoker = true) AS
SELECT location_id,
       count(*)                                               AS notes,
       count(opportunity_id)                                  AS with_opportunity,
       round(100.0 * count(opportunity_id) / NULLIF(count(*), 0))
                                                              AS pct_linked_to_deal,
       count(DISTINCT author_user_id)                         AS authors,
       -- Body alone, as the source measures it.
       round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY length(COALESCE(body, '')))::numeric, 0) AS median_body_len,
       -- Title and body together: 058 gave notes a real title column, so a
       -- note's content can be split across both fields.
       round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY length(COALESCE(title, '') || COALESCE(body, '')))::numeric, 0)
                                                              AS median_full_len,
       count(*) FILTER (WHERE length(COALESCE(title, '') || COALESCE(body, '')) < 30)
                                                              AS under_30_chars,
       count(*) FILTER (WHERE COALESCE(btrim(title), '') = ''
                          AND COALESCE(btrim(body), '') = '') AS empty_note,
       count(*) FILTER (WHERE COALESCE(btrim(title), '') <> ''
                          AND COALESCE(btrim(body), '') = '') AS title_only,
       max(created_at_ghl)                                    AS last_note_written
  FROM notes
 WHERE deleted_at IS NULL
 GROUP BY location_id;

COMMENT ON VIEW vw_note_adoption IS
  'Whether notes are used at all in this sub-account: how many exist, how many are linked to a deal, how many people write them, how long they typically are, and when the last one was written. Read this BEFORE any per-deal note finding — at low adoption, "most deals have no notes" describes a team that does not use notes, not reps who are failing to document.';

COMMENT ON COLUMN vw_note_adoption.authors IS
  'How many distinct people have written a note. One or two against a team of eight means notes are one person''s habit, not a process — a finding about adoption rather than about anyone''s diligence.';
COMMENT ON COLUMN vw_note_adoption.pct_linked_to_deal IS
  'Share of notes attached to an opportunity rather than only a contact. Notes against a contact alone do not appear in any per-deal note count, so a low figure here means per-deal findings understate what has actually been written.';
COMMENT ON COLUMN vw_note_adoption.median_full_len IS
  'Typical note length counting title and body together. Prefer this over median_body_len: a note with a real title and a short body is not thin, its content is simply split across two fields.';
COMMENT ON COLUMN vw_note_adoption.title_only IS
  'Notes with a title and no body. These are real notes that any body-only length test scores as empty.';

-- ─────────────────────────────────────────────────────────────────────
-- Part B: open deals by stage.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_open_deals_note_quality_by_stage
  WITH (security_invoker = true) AS
WITH od AS (
  SELECT o.opportunity_id, o.location_id, o.monetary_value,
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
n AS (
  SELECT location_id, opportunity_id,
         count(*)                                             AS notes,
         -- Title and body together, per 058.
         sum(length(COALESCE(title, '') || COALESCE(body, ''))) AS total_len,
         max(created_at_ghl)                                  AS last_note
    FROM notes
   WHERE deleted_at IS NULL
     AND opportunity_id IS NOT NULL
   GROUP BY location_id, opportunity_id
),
j AS (
  SELECT d.location_id, d.stage, d.monetary_value,
         COALESCE(n.notes, 0)     AS notes,
         COALESCE(n.total_len, 0) AS total_len,
         n.last_note
    FROM od d
    LEFT JOIN n ON n.opportunity_id = d.opportunity_id
               AND n.location_id    = d.location_id
)
SELECT location_id,
       stage,
       count(*)                                               AS open_deals,
       count(*) FILTER (WHERE notes = 0)                      AS no_notes,
       count(*) FILTER (WHERE total_len BETWEEN 1 AND 99)     AS thin_notes,
       count(*) FILTER (WHERE notes = 0 OR total_len < 100)   AS no_or_thin_notes,
       -- NULL last_note (no notes at all) is not counted here on purpose:
       -- these are deals that WERE documented and then went quiet.
       count(*) FILTER (WHERE last_note < now() - interval '30 days')
                                                              AS note_older_30d,
       round(100.0 * count(*) FILTER (WHERE notes = 0)
             / NULLIF(count(*), 0))                           AS pct_no_notes,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_len)::numeric, 0)
                                                              AS median_chars_per_deal,
       sum(monetary_value) FILTER (WHERE notes = 0)           AS value_no_notes,
       sum(monetary_value) FILTER (WHERE notes = 0 OR total_len < 100)
                                                              AS value_no_or_thin_notes
  FROM j
 GROUP BY location_id, stage;

COMMENT ON VIEW vw_open_deals_note_quality_by_stage IS
  'Open deals with no notes or only thin ones, by the stage they sit in, with the value at stake. Check note adoption for this sub-account first — at low adoption these counts describe a team that does not use notes rather than deals that were neglected. The thin threshold is a judgement, not a standard.';

COMMENT ON COLUMN vw_open_deals_note_quality_by_stage.thin_notes IS
  'Open deals with notes totalling fewer than 100 characters across title and body. 100 is a chosen threshold, not a measured one — quote it as a choice. Deals with no notes at all are counted in no_notes, not here.';
COMMENT ON COLUMN vw_open_deals_note_quality_by_stage.note_older_30d IS
  'Deals whose most recent note is over 30 days old. Deals with NO notes are deliberately excluded — they are in no_notes already. This counts deals that were being documented and then went quiet, which is a different signal from never having been documented.';
COMMENT ON COLUMN vw_open_deals_note_quality_by_stage.median_chars_per_deal IS
  'Typical total characters written per open deal at this stage, title and body together, counting deals with no notes as zero. A better comparison between stages than the counts, which move with how many deals sit in each.';
COMMENT ON COLUMN vw_open_deals_note_quality_by_stage.value_no_or_thin_notes IS
  'Total value of open deals with nothing or almost nothing written about them. If the owner leaves, this is the money nobody else can pick up.';
