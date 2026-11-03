-- 005_installs_reinstalled_at.sql
--
-- Add reinstalled_at so we can answer "when did this tenant last reinstall?"
-- without losing the original install date.
--
-- Column meanings after this migration:
--   installed_at        — FIRST install (immutable; T₀ for the relationship)
--   tracking_started_at — FIRST install (immutable; T₀ for forward-only data tracking)
--   reinstalled_at      — MOST RECENT install when re-installing after an uninstall
--                         (NULL on the very first install, updated each reinstall)
--   uninstalled_at      — MOST RECENT uninstall (NULL while currently active)
--
-- For the very common case "are they currently installed?": uninstalled_at IS NULL.
-- For "when did the current install begin?": COALESCE(reinstalled_at, installed_at).

ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS reinstalled_at TIMESTAMPTZ;
