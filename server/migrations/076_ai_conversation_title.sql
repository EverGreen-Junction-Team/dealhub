-- 076_ai_conversation_title.sql
--
-- Let a rep rename a Co-Pilot conversation in the Recents rail (GHL has this
-- in its own Ask AI menu; we only had Delete).
--
-- There's no ai_conversations table — a conversation is just a shared
-- conversation_id on ai_runs, and its rail title is derived at query time
-- from the FIRST run's question text. A rename has nothing to overwrite:
-- rewriting that question would corrupt real chat content the transcript
-- still displays. Instead, custom_title is a per-run override column;
-- history queries read COALESCE(custom_title, <first question>) and a
-- rename only ever needs to touch the first row of the conversation.

ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS custom_title TEXT;
