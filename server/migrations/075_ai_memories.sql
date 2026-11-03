-- 075_ai_memories.sql
--
-- Personalization for Co-Pilot — facts a rep tells it to remember across
-- every future chat, not just the current one. Matches GHL's own Ask AI
-- memory feature (ai-frontend memory/MemoryService.ts: userId, content,
-- source, status), scoped down to what we can build without access to
-- GHL's separate memory service (services.leadconnectorhq.com/copilot):
-- EXPLICIT save and bulk import only, no automatic mid-chat extraction.
--
-- Per USER, not per deal or per location: "I prefer short answers" or "my
-- name is Priya, I run the Sales team" applies to every sub-account a rep
-- opens Co-Pilot in, the same way GHL's memories follow userId + optional
-- locationId/companyId.

CREATE TABLE IF NOT EXISTS ai_memories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  -- 'explicit'  — the rep asked Co-Pilot to remember this, or typed it
  --               straight into the memory panel.
  -- 'import'    — bulk-imported from a pasted export (GHL's own "Export
  --               memories" flow produces a list like this).
  -- No 'auto' or 'system': those require reading every conversation to
  -- decide what's worth keeping, which lives in GHL's own memory service,
  -- not something we can replicate from here — see the migration header.
  source      TEXT        NOT NULL DEFAULT 'explicit'
    CHECK (source IN ('explicit', 'import')),
  -- Soft-deleted, not dropped: GHL's own model treats a memory the same
  -- way (status 'deleted' rather than a row removal) — a rep who deletes by
  -- mistake mid-list should not need a support ticket to get it back before
  -- this is ever exposed as a real "restore" feature.
  status      TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list view's hot path: this user's active memories, newest first by
-- default (the panel's own sort toggle just reverses the client-side read).
CREATE INDEX IF NOT EXISTS ai_memories_user_active
  ON ai_memories (location_id, user_id, status, created_at DESC);

ALTER TABLE ai_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ai_memories;
CREATE POLICY tenant_iso ON ai_memories
  USING (location_id = current_setting('app.location_id', true));

COMMENT ON TABLE ai_memories IS
  'Facts a rep has told Co-Pilot to remember across every future chat, scoped to (location_id, user_id). Explicit-save and bulk-import only — see the migration header for why there is no automatic extraction. Read into every ask/portfolio-ask prompt for that user.';
