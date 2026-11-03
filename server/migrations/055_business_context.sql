-- 055_business_context.sql
--
-- Control panel v1: one markdown file of business context per sub-account.
--
-- Replaces the four-section Control centre (tone samples, products table,
-- MEDDIC descriptions, business info free-text) with a single uploaded file
-- the agent reads at the start of every conversation. No schema — the business
-- writes whatever it wants the agent to know.
--
-- Stored IN POSTGRES, not on disk. Three reasons:
--   • It survives a server restart and a redeploy. A file on the VM's
--     filesystem would not survive a rebuild, and the agent would silently
--     lose its grounding.
--   • It's per-tenant, so it belongs behind the same RLS as everything else.
--   • It's small (the design shows 18 KB) — well inside what a TEXT column
--     handles comfortably, and cheaper than standing up object storage.
--
-- `content_version` is the cache key. Every replace bumps it, which
-- invalidates both our in-process cache and any cached ai_runs, so an answer
-- can never be grounded in a file the client has already replaced.
--
-- Migration 049's tables (tone_samples, products, location_ai_settings) are
-- deliberately left in place: the Qualification headings panel still reads
-- GHL's custom-field definitions, and dropping the others would lose data if
-- v6 reverses the decision.

CREATE TABLE IF NOT EXISTS business_context (
  location_id      TEXT        NOT NULL,
  -- The markdown itself. TEXT, not bytea: it's markdown by definition, and
  -- storing it as text means the preview and the prompt both read it directly.
  content          TEXT        NOT NULL,
  filename         TEXT        NOT NULL DEFAULT 'business-context.md',
  size_bytes       INTEGER     NOT NULL DEFAULT 0,
  -- Monotonic. Bumped on every replace so caches key off it rather than a
  -- timestamp, which two replaces in the same second would collide on.
  content_version  INTEGER     NOT NULL DEFAULT 1,
  -- How many times it's been replaced — the design surfaces this
  -- ("replaced twice"), and it's a useful signal that someone is maintaining
  -- the file rather than uploading once and forgetting.
  replace_count    INTEGER     NOT NULL DEFAULT 0,
  uploaded_by      TEXT,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id)
);

COMMENT ON TABLE business_context IS
  'Control panel v1 — one markdown file of business context per sub-account, read by the agent at the start of every conversation. Stored in Postgres so it survives restarts and redeploys. content_version is the cache key: bumped on every replace.';
COMMENT ON COLUMN business_context.content_version IS
  'Monotonic version. Part of every ai_runs cache key, so replacing the file invalidates cached answers grounded in the old text.';

ALTER TABLE business_context ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON business_context;
CREATE POLICY tenant_iso ON business_context
  USING (location_id = current_setting('app.location_id', true));
