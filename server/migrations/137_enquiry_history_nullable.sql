-- 137_enquiry_history_nullable.sql
--
-- Drop NOT NULL from opportunities.all_initial_enquiry.
--
-- ── WHY ──────────────────────────────────────────────────────────────
--
-- 136 created the column as `JSONB NOT NULL DEFAULT '[]'`. The default reads
-- as a safety net, but a DEFAULT only applies when a column is OMITTED from an
-- INSERT — never when NULL is supplied explicitly. upsertOpportunity always
-- names the column (it is a fixed 53-parameter statement), and the parameter
-- is NULL whenever there is nothing to append, so every INSERT of a new deal
-- failed with:
--
--   23502 null value in column "all_initial_enquiry" violates not-null
--
-- which rolled back the entire OpportunityUpdate transaction — the webhook
-- wrote nothing at all, so a rep's edit appeared to save and then vanished.
--
-- ── WHY NULLABLE RATHER THAN A COALESCE ──────────────────────────────
--
-- NULL is the writer's own signal for "no append this turn", and it has to
-- survive to the ON CONFLICT clause so the stored history is kept rather than
-- replaced. Forcing a non-null '[]' at the boundary makes that signal
-- indistinguishable from a real empty history, and the UPDATE path then
-- overwrites the stored history on every event.
--
-- So the column takes NULL, meaning exactly what every reader already assumes
-- it means — "no history recorded". Both readers were written that way from
-- the start and need no change:
--
--   routes/deals.js        Array.isArray(d.all_initial_enquiry) ? … : []
--   stageHistoryWriter.js  Array.isArray(rows[0].hist) ? rows[0].hist : []
--
-- The DEFAULT stays: a future INSERT that omits the column still gets '[]',
-- which is the right value when nothing is said about the history at all.

ALTER TABLE opportunities
  ALTER COLUMN all_initial_enquiry DROP NOT NULL;

COMMENT ON COLUMN opportunities.all_initial_enquiry IS
  'Every PREVIOUS master_initial_enquiry, oldest first, as [{text, seen_at}]. '
  'Appended by stageHistoryWriter when the master value changes. NULL or [] '
  'both mean no history recorded — readers treat a non-array as empty. '
  'Never written to GHL.';
