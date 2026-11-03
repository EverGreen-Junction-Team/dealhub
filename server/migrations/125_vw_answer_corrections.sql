-- 125_vw_answer_corrections.sql
--
-- Answers a rep marked wrong, with everything needed to fix them.
--
-- ── CLOSING THE LOOP, NOT OPENING ONE ────────────────────────────────
-- Thumbs-down and its free-text reason have been captured since 073. Nothing
-- has ever read them. A feedback button that collects complaints into a table
-- nobody opens is worse than no button: it asks a rep to spend effort on a
-- report that goes nowhere, and they stop using it once they notice.
--
-- So this is the read side. It pairs each down-rating with the question, the
-- answer, and WHICH TOOL OR SKILL produced it — because "the forecast number
-- was wrong" is unactionable, while "forecast_by_month returned this for that
-- question" names the view to go and look at.
--
-- ── WHY THE TOOL NAMES MATTER MOST ───────────────────────────────────
-- A wrong answer has three possible causes and they need different fixes:
--   the model picked the wrong skill   -> fix the skill's description
--   the skill returned the wrong rows  -> fix the view
--   the model misread correct rows     -> fix the prompt
-- Without knowing what ran, every report is the first kind of guess. The
-- tool list distinguishes them.

CREATE OR REPLACE VIEW vw_answer_corrections
  WITH (security_invoker = true) AS
SELECT r.location_id,
       rr.id                                                  AS rating_id,
       r.id                                                   AS run_id,
       rr.created_at                                          AS flagged_at,
       -- Free text, plus the structured reason chips the modal offers. Both,
       -- because a rep often picks a chip and types nothing, and the chip
       -- alone ("wrong number") still narrows where to look.
       rr.reason                                              AS what_was_wrong,
       rr.reasons                                             AS reason_tags,
       rr.rated_by                                            AS flagged_by,
       r.question,
       left(COALESCE(r.validated_output ->> 'answerText', ''), 400)
                                                              AS answer_start,
       r.created_at                                           AS answered_at,
       r.conversation_id,

       -- What actually ran. The name tells you which description to re-read;
       -- the input tells you which filters were applied.
       COALESCE((
         SELECT json_agg(json_build_object(
                  'tool',  tc ->> 'name',
                  'input', tc -> 'input',
                  'rows',  tc -> 'rows',
                  -- Present on skill calls since 125's companion change:
                  -- the exact SQL, so a wrong number can be re-run by hand.
                  'query', tc -> 'query'
                ) ORDER BY ord)
           FROM jsonb_array_elements(COALESCE(r.raw_output -> 'toolCalls', '[]'::jsonb))
                WITH ORDINALITY AS t(tc, ord)
       ), '[]'::json)                                          AS what_ran,

       -- Quick triage: a down-rating on an answer that called NOTHING is a
       -- different problem — the model answered from its own memory.
       jsonb_array_length(COALESCE(r.raw_output -> 'toolCalls', '[]'::jsonb)) = 0
                                                              AS answered_without_looking
  FROM ai_run_rating rr
  JOIN ai_runs r
    ON r.id = rr.run_id
   -- Scoped on location as well as id: ai_runs is keyed per sub-account and a
   -- join on the id alone would be unscoped.
   AND r.location_id = rr.location_id
 WHERE rr.rating = 'down';

COMMENT ON VIEW vw_answer_corrections IS
  'Answers a rep marked wrong, with the question, the answer, what the rep said was wrong, and which tools or skills produced it. The read side of the feedback button — without it, thumbs-down collects complaints nobody sees.';

COMMENT ON COLUMN vw_answer_corrections.what_ran IS
  'The tools and skills this answer called, with their inputs and (for skills) the exact SQL. This is what makes a report actionable: a wrong skill choice is a description problem, wrong rows are a view problem, and a misread of correct rows is a prompt problem.';
COMMENT ON COLUMN vw_answer_corrections.answered_without_looking IS
  'True when the answer called no tools at all. A wrong answer here is the most serious kind — the model answered from its own memory rather than from the data.';
COMMENT ON COLUMN vw_answer_corrections.what_was_wrong IS
  'What the rep typed when rating it down. Often the only statement of what the right answer should have been. May be empty when they picked a reason tag instead — read reason_tags alongside it.';
