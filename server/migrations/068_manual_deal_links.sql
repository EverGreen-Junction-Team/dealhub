-- 068_manual_deal_links.sql
--
-- "A human decided this" — for notes and tasks.
--
-- THE PROBLEM. Both tables record a deal as a plain column, so the only
-- states they can express are "a deal" and NULL. NULL has to mean two
-- different things at once:
--
--   (a) nobody has decided yet   -> the attribution rule should fill it
--   (b) a rep deliberately unlinked it -> the rule must leave it alone
--
-- Indistinguishable, so the rule refilled every deliberate unlink on the next
-- sync of that record. A rep detached a note from a deal, edited a typo in
-- GHL, and the note reattached itself.
--
-- Messages never had this bug because they do not store a value — they store
-- a DECISION, in message_opportunity_map.mapping_status ('mapped' vs
-- 'manually_resolved'), and the engine returns early on a manual one:
--
--   "A human decision outranks the engine, permanently. Without this a
--    re-sync, a backfill or the retrospective pass would quietly revert a
--    sales manager's correction."
--
-- This migration gives notes and tasks the same idea in the cheapest form
-- that fits their shape: one flag saying the value was set by a person. With
-- it, NULL + flag = "deliberately no deal", which the rule must respect, and
-- NULL alone stays "not decided yet", which it may fill.
--
-- WHY A FLAG AND NOT A MAPPING TABLE. Messages need history (a message can be
-- re-attributed repeatedly and superseded rows are the audit trail). A note
-- has exactly one deal and a task's set is small and fully replaced on each
-- write, so a row-per-decision buys nothing here.
--
-- SECOND USE. The same column carries the deal a rep picks when CREATING a
-- note. That pick cannot reach GHL (no notes.write) and cannot be written to
-- our own row either, because NoteCreate inserts the row a moment later —
-- so the route records the intent and the webhook honours it instead of
-- re-deriving one from the rule.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS deal_set_manually BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deal_set_manually BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN notes.deal_set_manually IS
  'TRUE when opportunity_id was set by a person (moved, or deliberately
   unlinked to NULL). The attribution rule must not overwrite it. FALSE means
   the value came from the rule and may be revised.';

COMMENT ON COLUMN tasks.deal_set_manually IS
  'TRUE when opportunity_id was set by a person (moved, or deliberately
   unlinked to NULL). The attribution rule must not overwrite it. FALSE means
   the value came from the rule and may be revised.';

-- Existing rows are all FALSE, which is correct: nothing before this
-- migration recorded who chose, so every stored value is treated as the
-- rule's and stays revisable. A rep's first manual move sets the flag.
--
-- No index. The flag is only ever read alongside a row already being fetched
-- by primary key, never searched on.
