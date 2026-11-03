-- 020_tags_columns.sql
--
-- Add current-state `tags` array columns to contacts and opportunities so
-- everyday queries can filter without joining tag_history. Populated by
-- the same writers that update tag_history — kept in lock-step:
--
--   contacts.tags       = current tag_names on the contact
--   opportunities.tags  = current tag_names on the opportunity
--
-- tag_history remains the source of truth for temporal questions ("was
-- this ever tagged X?"). These columns are convenience projections of
-- (SELECT array_agg(tag_name) FROM tag_history WHERE ... AND removed_at
-- IS NULL) — but materialised because filter queries against a GIN'd
-- array beat a subquery every time.

ALTER TABLE contacts      ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- GIN indexes let us do "WHERE tags @> ARRAY['hot-lead']" cheaply.
CREATE INDEX IF NOT EXISTS contacts_tags_gin      ON contacts      USING GIN (tags);
CREATE INDEX IF NOT EXISTS opportunities_tags_gin ON opportunities USING GIN (tags);
