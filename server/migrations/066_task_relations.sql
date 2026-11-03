-- 066_task_relations.sql
--
-- A task can belong to SEVERAL deals. `tasks.opportunity_id` holds one.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY
-- ═════════════════════════════════════════════════════════════════════════
--
-- GHL's TASK_OPPORTUNITY_ASSOCIATION caps at 10 (associationConstants.js), and
-- its UI lets a rep link a task to more than one deal. Our schema promoted a
-- single `opportunity_id` onto the task, so a second link either overwrote the
-- first or was dropped.
--
-- Worse, the RelationCreate/RelationDelete webhooks that carry these links
-- were being DISCARDED: opportunityContactWriter returns early for any
-- associationId other than OPPORTUNITIES_CONTACTS_ASSOCIATION, logging at
-- debug. So a task linked to a deal in GHL never showed that link here unless
-- the daily association sweep happened to resolve it.
--
-- NOTES ARE DELIBERATELY NOT HERE. NOTE_OPPORTUNITY_ASSOCIATION caps at 1 —
-- a note belongs to exactly one deal — so `notes.opportunity_id` is the
-- correct shape and a join table would imply a capability GHL does not have.
--
-- ═════════════════════════════════════════════════════════════════════════
-- tasks.opportunity_id IS KEPT
-- ═════════════════════════════════════════════════════════════════════════
--
-- Not dropped, and not deprecated. It stays as the task's PRIMARY deal — the
-- one the Deal Hub files it under, the one attributionEngine reads, the one
-- every existing query joins on. Nine call sites read it; breaking them to
-- model a cap of 10 would be a wide change for a rare case.
--
-- The join table is ADDITIVE: every link lives here, and the scalar mirrors
-- whichever one GHL reports first. A reader that wants "the" deal keeps
-- working; a reader that wants all of them has somewhere to look.

CREATE TABLE IF NOT EXISTS task_relations (
  location_id     TEXT NOT NULL,
  -- GHL's own relation id. The PK, because RelationDelete identifies the link
  -- by it and nothing else — the same pair can be unlinked and relinked, and
  -- keying on (task, opportunity) would make those indistinguishable.
  relation_id     TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  opportunity_id  TEXT NOT NULL,
  -- Which side GHL called what, kept verbatim. firstRecordId is always the
  -- task and secondRecordId the opportunity per the webhook contract, but
  -- storing the keys means a payload that ever arrives reversed is
  -- detectable rather than silently mis-filed.
  association_id  TEXT,
  last_seen_via   TEXT,                    -- 'webhook' | 'sweep'
  raw_relation    JSONB,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, relation_id)
);

-- No FOREIGN KEYs, deliberately.
--
-- Sync order is not guaranteed: a RelationCreate can arrive before the task
-- or the opportunity has been written, and rejecting it would lose the link
-- permanently — GHL does not redeliver after our 200. An orphaned row simply
-- resolves nothing on read until its other half arrives.

-- "every deal on this task" — the read the UI does.
CREATE INDEX IF NOT EXISTS task_rel_loc_task
  ON task_relations (location_id, task_id);

-- "every task on this deal" — the deal hub's task rail.
CREATE INDEX IF NOT EXISTS task_rel_loc_opp
  ON task_relations (location_id, opportunity_id);

COMMENT ON TABLE task_relations IS
  'Task <-> opportunity links (GHL cap 10). tasks.opportunity_id remains the task''s PRIMARY deal; this holds all of them.';

-- ── Backfill from what the scalar already knows ──────────────────────────
--
-- Existing single links become rows here, so "all deals on this task" is
-- correct immediately rather than only for links created after this deploy.
--
-- The synthetic relation_id is marked so it is distinguishable from a real
-- one: GHL never issued it, and a RelationDelete will never reference it. The
-- association sweep replaces these with genuine ids as it sees them.
INSERT INTO task_relations
  (location_id, relation_id, task_id, opportunity_id, association_id, last_seen_via)
SELECT
  t.location_id,
  'backfill:' || t.task_id || ':' || t.opportunity_id,
  t.task_id,
  t.opportunity_id,
  'TASK_OPPORTUNITY_ASSOCIATION',
  'backfill'
FROM tasks t
WHERE t.opportunity_id IS NOT NULL
  AND t.deleted_at IS NULL
ON CONFLICT (location_id, relation_id) DO NOTHING;

-- ── Tenant isolation ─────────────────────────────────────────────────────
--
-- Same policy every other table carries. current_setting wrapped in a SELECT
-- so it is evaluated once per QUERY rather than once per row — the correction
-- migration 062 applied everywhere; a new table must not reintroduce the old
-- shape.
ALTER TABLE task_relations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON task_relations;
CREATE POLICY tenant_iso ON task_relations
  USING (location_id = (SELECT current_setting('app.location_id', true)));
