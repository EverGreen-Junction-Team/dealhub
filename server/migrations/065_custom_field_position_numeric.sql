-- 065_custom_field_position_numeric.sql
--
-- `position` is FRACTIONAL in GoHighLevel, not an integer.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY
-- ═════════════════════════════════════════════════════════════════════════
--
-- Migration 064 typed these columns INTEGER, which is what the values looked
-- like in a sample: 50, 100, 150, 350. They are not. GHL orders fields by a
-- float so a field can be dragged BETWEEN two others without renumbering the
-- rest — the midpoint of 100 and 200 is 150, then 125, then 112.5, and so on.
-- Real values from production:
--
--     775.78125    37.5    751.5625
--
-- Every field write failed with
--   22P02  invalid input syntax for type integer: "775.78125"
-- which meant the whole custom-field sync aborted per location — not only the
-- new folder columns, but the display names, options and placeholders too.
--
-- NUMERIC rather than DOUBLE PRECISION: these are ordering keys, compared and
-- sorted but never arithmetic, and NUMERIC compares exactly. A float would
-- make two positions that differ in the last bit sort unpredictably.
--
-- ═════════════════════════════════════════════════════════════════════════
-- SAFE TO RE-RUN
-- ═════════════════════════════════════════════════════════════════════════
--
-- ALTER TYPE from INTEGER to NUMERIC is lossless and USING is unnecessary —
-- every existing integer is a valid numeric. Postgres rewrites the table,
-- which on these two tables (tens of rows per location) is instant.

ALTER TABLE ghl_custom_field_definitions
  ALTER COLUMN position TYPE NUMERIC;

ALTER TABLE ghl_custom_field_folders
  ALTER COLUMN position TYPE NUMERIC;

COMMENT ON COLUMN ghl_custom_field_definitions.position IS
  'GHL ordering key within its folder. FRACTIONAL — a field dragged between two others takes the midpoint, so values like 112.5 are normal.';

COMMENT ON COLUMN ghl_custom_field_folders.position IS
  'GHL ordering key for the folder. Fractional, as above.';
