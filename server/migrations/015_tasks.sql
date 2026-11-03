-- 015_tasks.sql
--
-- GHL tasks. One row per (location_id, task_id).
--
-- Populated by webhooks:
--   - TaskCreate   → INSERT row, status='open', enqueue 60s association resolve
--   - TaskComplete → UPDATE existing row: status='completed', stamp completed_at
--   - TaskDelete   → UPDATE existing row: status='deleted', stamp deleted_at
--
-- opportunity_id is populated in TWO independent paths:
--   1. Delayed association resolver (60s after TaskCreate — see
--      pending_task_associations table): calls the GHL Associations API and
--      writes the linked opp id, or leaves NULL if the task is contact-only.
--   2. RelationCreate / RelationDelete webhooks: if a rep manually links or
--      unlinks a task↔opportunity later, we hear about it and update the
--      column in real time.
-- Both paths write to the same column. Whichever fires first wins; the other
-- becomes a no-op via idempotent update.
--
-- Per CSV blueprint §1.14 — 17 columns.

CREATE TABLE IF NOT EXISTS tasks (
  location_id       TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  contact_id        TEXT,                                  -- FK-shaped; NULL when GHL didn't attach it
  opportunity_id    TEXT,                                  -- resolved via associations API or RelationCreate
  assigned_to       TEXT,                                  -- GHL user id
  assigned_to_name  TEXT,                                  -- resolved from users table
  title             TEXT,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'open',          -- 'open' | 'completed' | 'deleted'
  due_at            TIMESTAMPTZ,                           -- task.dueDate
  completed_at      TIMESTAMPTZ,                           -- set on TaskComplete
  raw_task          JSONB,                                 -- full GHL payload (in case fields we haven't promoted matter later)
  from_backfill     BOOLEAN NOT NULL DEFAULT false,
  created_at_ghl    TIMESTAMPTZ,                           -- task.dateAdded
  updated_at_ghl    TIMESTAMPTZ,                           -- task.dateUpdated
  deleted_at        TIMESTAMPTZ,                           -- set on TaskDelete
  imported_at       TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, task_id),
  FOREIGN KEY (location_id, contact_id)     REFERENCES contacts (location_id, contact_id),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);

-- Common query shapes:
--   "give me every open task in BGD"                (location_id, status)
--   "tasks for this contact"                        (location_id, contact_id)
--   "tasks for this opportunity"                    (location_id, opportunity_id)
--   "tasks owned by this user, open"                (location_id, assigned_to, status)
--   "tasks due in the next 24h"                     (location_id, due_at)
CREATE INDEX IF NOT EXISTS tasks_loc_status   ON tasks (location_id, status);
CREATE INDEX IF NOT EXISTS tasks_loc_contact  ON tasks (location_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_loc_opp      ON tasks (location_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_loc_owner    ON tasks (location_id, assigned_to, status) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_loc_due_at   ON tasks (location_id, due_at) WHERE due_at IS NOT NULL AND status = 'open';

-- RLS scoped by location.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON tasks;
CREATE POLICY tenant_iso ON tasks USING (location_id = current_setting('app.location_id', true));
