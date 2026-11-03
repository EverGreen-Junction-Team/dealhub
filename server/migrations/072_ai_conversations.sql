-- 072_ai_conversations.sql
--
-- Group ai_runs into conversations.
--
-- ai_runs stored ONE ROW PER QUESTION with nothing tying a follow-up to what
-- came before, so the Co-Pilot's "Chat history" rail was really a list of
-- individual questions. Asking a follow-up added a second entry rather than
-- extending a thread, and reopening one replaced the transcript with a single
-- Q&A pair — the rest of the conversation was unreachable.
--
-- The live transcript in the browser was always correct; it just could not
-- survive a reload or a reopen, because there was nowhere to persist it.
--
-- conversation_id groups the turns. A question with no conversation starts
-- one; a follow-up carries the id forward.

ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS conversation_id UUID;

-- Backfill: every existing run becomes a single-turn conversation of its own.
-- NOT one shared id per deal — those questions were asked independently, and
-- pretending they were one thread would put unrelated context in front of the
-- model on the first follow-up.
UPDATE ai_runs
   SET conversation_id = gen_random_uuid()
 WHERE conversation_id IS NULL;

-- The rail's query: newest conversation first, within one deal.
CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx
  ON ai_runs (location_id, opportunity_id, conversation_id, created_at);

-- Left nullable on purpose. A run that fails before a conversation is
-- established still needs to be logged — status/error rows are written on
-- paths that never reach the ask handler, and a NOT NULL here would turn a
-- logging failure into a lost error record.
