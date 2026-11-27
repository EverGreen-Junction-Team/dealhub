-- 147_ops_location_flag.sql
--
-- Operations Hub: switched on PER SUB-ACCOUNT.
--
-- The dashboard build flag (VITE_FEATURE_OPERATIONS) decides whether the
-- feature exists at all. This decides whether a given sub-account sees it:
-- off by default, turned on from the Control panel, and enforced by the
-- server — every /api/ops route except the switch itself refuses with
-- reason 'ops_disabled' while it is off, so hiding the menu is not the only
-- thing standing between a sub-account and the feature.
ALTER TABLE ops_settings ADD COLUMN IF NOT EXISTS enabled    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ops_settings ADD COLUMN IF NOT EXISTS enabled_by TEXT;
ALTER TABLE ops_settings ADD COLUMN IF NOT EXISTS enabled_at TIMESTAMPTZ;
