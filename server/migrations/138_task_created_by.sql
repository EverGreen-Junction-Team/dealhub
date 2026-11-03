-- 138_task_created_by.sql
--
-- Who MADE a task, as distinct from who it is FOR.
--
-- ── WHY ──────────────────────────────────────────────────────────────
--
-- A task created through Deal AI landed with assigned_to = NULL, so it
-- matched no rep's filter on the Tasks tab (routes/tasks.js filters on
-- `t.assigned_to = $n`). The task existed, the rep who asked for it could
-- not find it. That half is fixed in code — the confirming user's id is now
-- sent to GHL as assignedTo.
--
-- This column is the OTHER half, and it is deliberately a different thing.
-- `assigned_to` is who has to do the work; GHL owns it and syncs it back.
-- `created_by` is who brought the task into being, which GHL's task API has
-- no concept of at all — it accepts assignedTo and nothing else about
-- people. So if we want to answer "who made this, and did a human or the
-- model make it", we have to record it ourselves at the moment we write.
--
-- Notes need no equivalent: GHL's note API takes a `userId` and we already
-- store it as notes.author_user_id. The AI path simply was not sending it.
--
-- ── NULLABLE ON PURPOSE ──────────────────────────────────────────────
--
-- Every task that already exists has no recorded creator, and inventing one
-- would be a lie about history. NULL means "created before we tracked this,
-- or synced from GHL where it was made by hand" — which is exactly what the
-- backfill-free truth is. Readers must treat NULL as "unknown", never as
-- "nobody".
--
-- created_via is kept separate from created_by rather than encoded into it
-- (e.g. a magic 'ai' user id), because the two answer different questions:
-- WHO authorised it, and HOW it was made. A rep confirming an AI proposal is
-- both a real person AND an AI-created task; one column cannot say that.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS created_by  TEXT,
  ADD COLUMN IF NOT EXISTS created_via TEXT;

COMMENT ON COLUMN tasks.created_by IS
  'GHL user id of whoever created this task in OUR app. NULL means unknown '
  '— created before this column existed, or synced from GHL where it was '
  'made outside PipelinePulse. Distinct from assigned_to, which is who the '
  'task is FOR and which GHL owns.';

COMMENT ON COLUMN tasks.created_via IS
  '''ai'' when the task came from a confirmed Deal AI / Insights AI proposal, '
  '''app'' when a rep created it by hand in PipelinePulse, NULL when it came '
  'from GHL or predates this column. Separate from created_by because a rep '
  'confirming an AI proposal is both a real author and an AI-made task.';

-- "What has the AI created, and who signed it off" — the audit question this
-- column exists to answer. Partial, because the overwhelming majority of
-- rows are NULL (everything synced from GHL) and indexing those is dead
-- weight on every write.
-- ── THE CARRIER ──────────────────────────────────────────────────────
--
-- Our row does not exist when the task is created: GHL answers with an id,
-- and the TaskCreate webhook performs the INSERT some moments later. So the
-- creator cannot be written directly — it is parked in pending_deal_links
-- (migration 069, which already carries created_by for exactly this reason)
-- and applied by taskWriter when the webhook lands.
--
-- created_via rides the same carrier. Without this column the value would be
-- read as undefined on every consume and tasks.created_via would never be
-- anything but NULL.

ALTER TABLE pending_deal_links
  ADD COLUMN IF NOT EXISTS created_via TEXT;

COMMENT ON COLUMN pending_deal_links.created_via IS
  'How the record was made — ''ai'' or ''app'' — parked alongside created_by '
  'and applied to tasks.created_via by taskWriter when the webhook arrives.';

CREATE INDEX IF NOT EXISTS tasks_loc_created_by
  ON tasks (location_id, created_by, created_via)
  WHERE created_by IS NOT NULL;
