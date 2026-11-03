-- 085_vw_close_without_win_comments.sql
--
-- Column comments for vw_close_without_win_by_stage.
--
-- These are not decoration. The Control panel reads them and shows each one
-- on the column picker, so whoever builds a skill can see what a column means
-- without opening a migration. `pct_of_closed` is the case that makes the
-- point: a percentage is a guess until you know what it is a percentage OF.
--
-- The view's own COMMENT is offered as the skill's starting description, so
-- it is written for someone deciding whether this view answers their
-- question — not as an implementation note.

-- Same reasoning as the view comment: this one is shown on the column picker,
-- so it says what the column IS, not why the plumbing needs it.
COMMENT ON COLUMN vw_close_without_win_by_stage.location_id IS
  'Which sub-account. Every row already belongs to the one you are looking at, so there is no need to return it.';

COMMENT ON COLUMN vw_close_without_win_by_stage.stage_name IS
  'The stage the deal was sitting in when it closed. Normalised to Title Case, because GHL stores both "Quote Sent" and "Quote sent" and they are the same stage. "(no stage recorded)" means the deal closed before any stage change synced.';

COMMENT ON COLUMN vw_close_without_win_by_stage.closed_without_win IS
  'Deals that ended at this stage without being won — lost and abandoned together.';

COMMENT ON COLUMN vw_close_without_win_by_stage.lost IS
  'Of those, the ones marked lost: a deal that was pursued and did not close.';

COMMENT ON COLUMN vw_close_without_win_by_stage.abandoned IS
  'Of those, the ones marked abandoned: dropped rather than actively lost. Often junk clearing at early stages.';

COMMENT ON COLUMN vw_close_without_win_by_stage.pct_of_closed IS
  'This stage as a percentage of every deal this sub-account closed without a win. Not a percentage of deals that ENTERED the stage — a high figure means many deals die here, not that this stage has a poor conversion rate.';

-- The view's own description, rewritten.
--
-- 084 set it to a sentence ending "One sub-account only — RLS scopes it.
-- Exposed to the AI via an ai_skills row." Both facts are true and neither
-- belongs here: this comment is now SHOWN in the Control panel and offered as
-- the skill's starting description, so it is read by someone deciding whether
-- this view answers their question — not by someone maintaining the schema.
-- Row-level security and the ai_skills table are our plumbing, and naming
-- them tells that reader nothing they can act on.
COMMENT ON VIEW vw_close_without_win_by_stage IS
  'Which pipeline stage deals were in when they stopped progressing — marked lost or abandoned — with how many, the lost/abandoned split, and each stage''s share of all deals that closed without a win.';
