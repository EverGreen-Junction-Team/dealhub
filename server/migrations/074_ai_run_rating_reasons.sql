-- 074_ai_run_rating_reasons.sql
--
-- GHL's own thumbs-down modal (ai-frontend NegativeFeedbackModal.vue) lets a
-- rep pick MULTIPLE reason chips plus a free-text comment — our single flat
-- `reason` TEXT column can hold neither the multi-select nor keep the chosen
-- chips distinguishable from the free text once joined into one string.
--
-- `reasons` is the chip ids (e.g. ['not_factually_correct', 'incomplete_response']),
-- validated against the same set GHL uses so a report can group by reason
-- without normalising free text. `reason` (the old column) becomes the
-- free-text comment — kept, not renamed, so a rating written before this
-- migration is not silently orphaned: its plain string just has no reasons[]
-- alongside it, which is the correct history for a rating rated before chips
-- existed.

ALTER TABLE ai_run_rating ADD COLUMN IF NOT EXISTS reasons TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN ai_run_rating.reasons IS
  'Reason chip ids from the negative-feedback modal, e.g. {not_factually_correct,incomplete_response}. Validated server-side against RATING_REASON_IDS in routes/ai.js (same set as GHL''s NEGATIVE_FEEDBACK_REASON_IDS). Empty on a thumbs-up or a pre-migration rating.';
COMMENT ON COLUMN ai_run_rating.reason IS
  'Free-text comment from the negative-feedback modal ("Share details"). Also holds the whole reason for ratings written before migration 074 added reasons[].';
