-- 037_tag_history_backfill_tag_id.sql
--
-- Fixes QA finding H2 — "tag_history.tag_id is NULL in 100% of rows."
--
-- Root cause: GHL webhooks send tag names only (not IDs). Our tagHistoryWriter
-- accepted a tagId if the payload happened to include one, but never looked
-- it up from the tags catalogue. Result: 145/145 rows with tag_id NULL.
--
-- Fix (two parts):
--   Part 1 (this migration): back-fill tag_id on existing rows by joining
--     to tags catalogue on (location_id, name). Only touches rows where
--     tag_id IS NULL — idempotent.
--   Part 2 (code): tagHistoryWriter.reconcileTags now looks up tag_id from
--     tags catalogue during INSERT. Forward-going rows arrive populated.
--
-- Rows where the tags catalogue doesn't have a matching name (rare — tag
-- applied faster than daily tagsSync captured it) stay NULL. A repeat run
-- of this migration after the next tagsSync will fill any remaining rows.

UPDATE tag_history th
   SET tag_id = t.tag_id
  FROM tags t
 WHERE th.tag_id IS NULL
   AND t.location_id = th.location_id
   AND t.name        = th.tag_name;
