-- 106_vw_close_reason_by_stage.sql
--
-- "Why did we lose it?" — the reason a rep recorded when closing a deal,
-- counted by stage, with how often the field was filled at all. Built to be
-- exposed to the AI as a skill (see 083).
--
-- Two questions in one view, because they are inseparable: what the reasons
-- say, and how much of the pipeline they cover. A theme holding 40% of losses
-- means nothing until you know whether reasons were recorded on 90% of deals
-- or 12%. Quoting the first without the second is the failure mode this view
-- is shaped to prevent, which is why pct_filled sits on every row.
--
-- ── meddic_9 IS THE LOST FIELD. ABANDONED DEALS USE meddic_11 ────────
-- The source query filtered status IN ('lost','abandoned') and read meddic_9
-- alone. Per 067: won -> meddic_10, lost -> meddic_9, abandoned -> meddic_11.
-- So every abandoned deal counted against the denominator while its reason
-- was never read — pct_filled understated, and the whole abandoned side of
-- the report invisible.
--
-- That is the larger half of the question. A deal nobody pursued and a deal
-- actively lost fail for different reasons, and 099 exists because that
-- distinction was worth its own column. Here the correct field is chosen per
-- status, and reason_field says which was read.
--
-- ── WHAT IS NOT USED, AND WHY IT IS EXPOSED ANYWAY ───────────────────
-- The source is explicit: GHL's native lost-reason pop-up
-- (raw_opportunity->>'lostReasonId') is NOT the source of truth here; the
-- MEDDIC text fields are. Honoured — reason_text never falls back to the
-- pop-up, unlike vw_opportunity_flat's deal_lost_reason (045), which
-- deliberately does.
--
-- But the source's Part C listed deals where the rep answered the pop-up
-- INSTEAD of the text field, to drive a workflow fix. That is the same
-- question as fill rate, so it is a column here rather than a second skill:
-- popup_only counts deals with a pop-up answer and no text. A high number
-- says the reasons are being recorded, just not where this report reads them
-- — a very different conclusion from "reps are not recording reasons", and
-- the two are indistinguishable without this column.
--
-- ── NO KEYWORD THEMES ────────────────────────────────────────────────
-- The source's Part B bucketed free text with eight regexes into themes like
-- 'Price' and 'No response from customer'. Not reproduced, for a reason that
-- is specific rather than squeamish: the source header says "Misha confirms
-- by hand", so the regexes are a first cut a person then checks. Frozen into
-- a view they become unreviewed truth — 'Other / unclear' silently absorbs
-- every phrasing nobody anticipated, and the AI reports clean percentages
-- over buckets no one validated. The patterns are also written for this
-- customer's vocabulary ('fabco', 'schuco', 'timber', 'one window'); another
-- sub-account's losses would land in 'Other' and read as unclassifiable.
--
-- The AI reads text well. Giving it the reasons themselves (see the companion
-- list skill on vw_close_reason_list) lets it group what is actually there and
-- quote the wording, which is both more accurate and auditable. Percentages
-- over hand-written regexes are neither.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_close_reason_by_stage
  WITH (security_invoker = true) AS
WITH closed AS (
  SELECT o.opportunity_id,
         o.location_id,
         o.status,
         COALESCE(initcap(lower(s.stage_name)), '(no stage recorded)') AS stage_name,
         -- The field GHL writes depends on how the deal closed (067).
         CASE o.status
           WHEN 'lost'      THEN NULLIF(btrim(o.meddic_9), '')
           WHEN 'abandoned' THEN NULLIF(btrim(o.meddic_11), '')
         END                                                  AS reason_text,
         NULLIF(btrim(o.raw_opportunity ->> 'lostReasonId'), '') AS popup_reason_id
    FROM opportunities o
    LEFT JOIN stage_history s
      ON s.opportunity_id = o.opportunity_id
     -- Scoped on location: opportunity_id is unique per sub-account, not
     -- globally (001_schema).
     AND s.location_id = o.location_id
     AND s.current_stage
     AND NOT s.deleted
     AND NOT s.ghost_opportunity
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
     AND o.status IN ('lost', 'abandoned')
)
SELECT location_id,
       stage_name,
       count(*)                                               AS deals,
       count(*) FILTER (WHERE status = 'lost')                AS lost,
       count(*) FILTER (WHERE status = 'abandoned')           AS abandoned,
       count(reason_text)                                     AS reason_filled,
       round(100.0 * count(reason_text) / NULLIF(count(*), 0)) AS pct_filled,
       -- Split, because the two fields are filled by different habits and a
       -- combined rate hides one side being ignored entirely.
       round(100.0 * count(reason_text) FILTER (WHERE status = 'lost')
             / NULLIF(count(*) FILTER (WHERE status = 'lost'), 0))
                                                              AS pct_filled_lost,
       round(100.0 * count(reason_text) FILTER (WHERE status = 'abandoned')
             / NULLIF(count(*) FILTER (WHERE status = 'abandoned'), 0))
                                                              AS pct_filled_abandoned,
       -- Recorded, but in GHL's pop-up rather than the MEDDIC field this
       -- report reads. A workflow problem, not a discipline problem.
       count(*) FILTER (WHERE popup_reason_id IS NOT NULL
                          AND reason_text IS NULL)            AS popup_only,
       count(*) FILTER (WHERE popup_reason_id IS NULL
                          AND reason_text IS NULL)            AS no_reason_anywhere
  FROM closed
 GROUP BY location_id, stage_name;

COMMENT ON VIEW vw_close_reason_by_stage IS
  'How well close reasons are recorded, by the stage the deal was in when it closed: deals, how many carry a written reason, and how many were answered in GHL''s pop-up instead. Reads meddic_9 for lost deals and meddic_11 for abandoned ones, which is how GHL writes them. Never quote a reason breakdown without the fill rate from here — a theme''s share is meaningless if reasons were only recorded on a fraction of deals.';

COMMENT ON COLUMN vw_close_reason_by_stage.pct_filled IS
  'Share of deals closing at this stage that carry a written close reason. This is the confidence figure for every reason breakdown — quote it alongside, always.';
COMMENT ON COLUMN vw_close_reason_by_stage.popup_only IS
  'Deals where the rep answered GHL''s built-in lost-reason pop-up but left the written field empty. These are NOT reps failing to record a reason — the reason exists, in a place this report does not read. High here means a workflow fix, not coaching.';
COMMENT ON COLUMN vw_close_reason_by_stage.no_reason_anywhere IS
  'Deals closed with no reason in either place. This is the genuine gap.';
COMMENT ON COLUMN vw_close_reason_by_stage.pct_filled_abandoned IS
  'Fill rate for abandoned deals, read from meddic_11. Reported apart from the lost rate because the two fields are filled by different habits, and one side being ignored is invisible in a combined figure.';

-- ─────────────────────────────────────────────────────────────────────
-- Companion: the reasons themselves, one row per deal.
--
-- This is what replaces the source's Part B keyword bucketing. The AI groups
-- what it reads and quotes the wording, rather than reporting percentages
-- over eight regexes nobody reviewed. Slower to read, but it can be checked —
-- and when a theme is named, the deal it came from can be opened.
--
-- Capped by the skill's rowLimit, ordered newest first, so a large account
-- returns recent losses rather than an arbitrary slice.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_close_reason_list
  WITH (security_invoker = true) AS
SELECT o.location_id,
       o.opportunity_id,
       o.name                                                 AS deal_name,
       o.status,
       o.lost_at,
       o.monetary_value,
       COALESCE(initcap(lower(s.stage_name)), '(no stage recorded)') AS stage_name,
       CASE o.status
         WHEN 'lost'      THEN NULLIF(btrim(o.meddic_9), '')
         WHEN 'abandoned' THEN NULLIF(btrim(o.meddic_11), '')
       END                                                    AS reason_text,
       CASE o.status WHEN 'lost' THEN 'meddic_9'
                     WHEN 'abandoned' THEN 'meddic_11' END    AS reason_field,
       -- The pop-up label where one is mapped, for deals whose reason was
       -- recorded there instead. Degrades to the raw id when unmapped — 045's
       -- lookup table is populated by hand from GHL settings and may be empty.
       COALESCE(l.label, NULLIF(btrim(o.raw_opportunity ->> 'lostReasonId'), ''))
                                                              AS popup_reason
  FROM opportunities o
  LEFT JOIN stage_history s
    ON s.opportunity_id = o.opportunity_id
   AND s.location_id = o.location_id
   AND s.current_stage
   AND NOT s.deleted
   AND NOT s.ghost_opportunity
  LEFT JOIN lost_reason_labels l
    ON l.reason_id = NULLIF(btrim(o.raw_opportunity ->> 'lostReasonId'), '')
   AND l.location_id = o.location_id
 WHERE o.deleted_at IS NULL
   AND o.is_ghost = false
   AND o.status IN ('lost', 'abandoned');

COMMENT ON VIEW vw_close_reason_list IS
  'One row per lost or abandoned deal with the reason the rep wrote, the stage it closed at, and its value. Read the reasons and group them by what they actually say — do not assume a fixed set of categories. Always check the fill rate in vw_close_reason_by_stage before describing any theme as common.';

COMMENT ON COLUMN vw_close_reason_list.reason_text IS
  'What the rep wrote, verbatim. NULL means the field was left empty — check popup_reason before concluding no reason was recorded.';
COMMENT ON COLUMN vw_close_reason_list.reason_field IS
  'Which GHL field this came from: meddic_9 for lost deals, meddic_11 for abandoned ones.';
COMMENT ON COLUMN vw_close_reason_list.popup_reason IS
  'The reason chosen in GHL''s built-in pop-up, where one was. A raw id rather than words means the label has not been mapped in lost_reason_labels — say the id is unmapped rather than quoting it as a reason.';
