-- 146_operations.sql
--
-- Operations Hub, slice 1: projects and remedials after a deal is won.
-- See docs/operations-hub-plan.md.
--
-- ── THE HYBRID MODEL ─────────────────────────────────────────────────
--
-- A project's or remedial's STAGE lives in GoHighLevel: it is an opportunity
-- in the Operations or Remedials pipeline, mirrored into `opportunities` by
-- the webhooks and sweeps that already exist. Everything GHL has no home for
-- lives here, beside it, keyed by that opportunity:
--
--   projects / remedials   the job's own facts (job number, fitter, dates…)
--   ops_task_links         which job a GHL task belongs to — GHL refuses to
--                          let an app link a task to a deal at all
--   ops_steps              the checklist for each stage
--   ops_time_entries       time logged against a job
--
-- An opportunity in the mapped pipeline IS the job, however it got there.
-- The rows here are created the first time somebody opens or edits it, so
-- nothing in this migration depends on how a won deal becomes a project
-- (an open question for the client; see services/opsDecisions.js).
--
-- Every table is location-scoped with the usual tenant_iso RLS policy.

-- ── ops_settings ─────────────────────────────────────────────────────
-- Which GHL pipeline is which. A Deal Hub setting: choosing them changes
-- nothing in GHL. NULL = not mapped yet, and every Operations screen says so
-- rather than guessing by name.
CREATE TABLE IF NOT EXISTS ops_settings (
  location_id            TEXT PRIMARY KEY,
  operations_pipeline_id TEXT,
  remedials_pipeline_id  TEXT,
  updated_by             TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (operations_pipeline_id IS NULL
         OR remedials_pipeline_id IS NULL
         OR operations_pipeline_id <> remedials_pipeline_id)
);
ALTER TABLE ops_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ops_settings;
CREATE POLICY tenant_iso ON ops_settings
  USING (location_id = current_setting('app.location_id', true));

-- ── projects ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  location_id          TEXT NOT NULL,
  -- The opportunity in the Operations pipeline. Its stage is the project's.
  opportunity_id       TEXT NOT NULL,
  -- The won sales deal this came from, when there is one (Q1 decides whether
  -- it is a separate opportunity or the same one).
  sales_opportunity_id TEXT,
  -- Typed by hand until Q2 says where job numbers come from.
  job_number           TEXT,
  -- Which company does the work (TBCG / The Tile & Bathroom Company).
  business_id          TEXT,
  -- GHL user ids. Not foreign keys: the users table is a synced cache.
  showroom_user_id     TEXT,
  ordering_user_id     TEXT,
  admin_user_id        TEXT,
  -- Fitters are mostly subcontractors, not GHL users, so a name.
  fitter_name          TEXT,
  install_start        DATE,
  install_end          DATE,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id),
  CHECK (install_end IS NULL OR install_start IS NULL OR install_end >= install_start)
);
-- A job number means one job. Partial: most rows have none yet.
CREATE UNIQUE INDEX IF NOT EXISTS projects_job_number_unique
  ON projects (location_id, lower(job_number)) WHERE job_number IS NOT NULL;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON projects;
CREATE POLICY tenant_iso ON projects
  USING (location_id = current_setting('app.location_id', true));

-- ── remedials ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS remedials (
  location_id             TEXT NOT NULL,
  opportunity_id          TEXT NOT NULL,
  -- R-<job no.>-<nn> once Q2 confirms the format; typed by hand until then.
  ref                     TEXT,
  -- The project it is a remedial OF. Nullable: a snag on a job that pre-dates
  -- Deal Hub has no project row to point at.
  project_opportunity_id  TEXT,
  kind                    TEXT CHECK (kind IS NULL OR kind IN ('product', 'other')),
  reason                  TEXT,
  category                TEXT,
  fitter_name             TEXT,
  -- "Customer (phone)", "Fitter (WhatsApp)"…
  reported_via            TEXT,
  taken_by_user_id        TEXT,
  reported_at             DATE,
  created_by              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No FK to opportunities, unlike projects: "Log remedial" creates the
  -- opportunity in GHL and writes this row straight away, seconds before the
  -- OpportunityCreate webhook writes ours. The details typed into the form
  -- must not be lost to that race.
  PRIMARY KEY (location_id, opportunity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS remedials_ref_unique
  ON remedials (location_id, lower(ref)) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS remedials_by_project
  ON remedials (location_id, project_opportunity_id);
ALTER TABLE remedials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON remedials;
CREATE POLICY tenant_iso ON remedials
  USING (location_id = current_setting('app.location_id', true));

-- ── ops_task_links ───────────────────────────────────────────────────
-- One job per task, as the design says ("every task belongs to one project
-- or one remedial"). No FK to tasks: a task made from the job page is linked
-- here straight after GHL accepts it, before the TaskCreate webhook has
-- written our row.
CREATE TABLE IF NOT EXISTS ops_task_links (
  location_id     TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('project', 'remedial')),
  opportunity_id  TEXT NOT NULL,
  -- Which stage the task belongs to ("Deliveries & check"), as a stage key.
  stage_key       TEXT,
  linked_by       TEXT,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, task_id)
);
CREATE INDEX IF NOT EXISTS ops_task_links_by_job
  ON ops_task_links (location_id, opportunity_id);
ALTER TABLE ops_task_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ops_task_links;
CREATE POLICY tenant_iso ON ops_task_links
  USING (location_id = current_setting('app.location_id', true));

-- ── ops_steps ────────────────────────────────────────────────────────
-- "To do in this stage": the checklist that moves a job on when it is all
-- ticked. Seeded from the template for a stage the first time a job is seen
-- in it; editable after that.
CREATE TABLE IF NOT EXISTS ops_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     TEXT NOT NULL,
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('project', 'remedial')),
  opportunity_id  TEXT NOT NULL,
  stage_key       TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  title           TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  assignee_user_id TEXT,
  due_on          DATE,
  done_at         TIMESTAMPTZ,
  done_by         TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS ops_steps_by_job_stage
  ON ops_steps (location_id, opportunity_id, stage_key, position);
ALTER TABLE ops_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ops_steps;
CREATE POLICY tenant_iso ON ops_steps
  USING (location_id = current_setting('app.location_id', true));

-- Which stages have had their template seeded for a job. Kept apart from the
-- steps so deleting every step of a stage does not re-seed them next visit.
CREATE TABLE IF NOT EXISTS ops_stage_seeds (
  location_id     TEXT NOT NULL,
  opportunity_id  TEXT NOT NULL,
  stage_key       TEXT NOT NULL,
  seeded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id, stage_key)
);
ALTER TABLE ops_stage_seeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ops_stage_seeds;
CREATE POLICY tenant_iso ON ops_stage_seeds
  USING (location_id = current_setting('app.location_id', true));

-- ── ops_time_entries ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops_time_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     TEXT NOT NULL,
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('project', 'remedial')),
  opportunity_id  TEXT NOT NULL,
  -- A GHL user, or a name for someone who is not one (a fitter).
  user_id         TEXT,
  worker_name     TEXT,
  work_date       DATE NOT NULL,
  hours           NUMERIC(5, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  activity        TEXT NOT NULL,
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR worker_name IS NOT NULL),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS ops_time_by_job
  ON ops_time_entries (location_id, opportunity_id, work_date DESC)
  WHERE deleted_at IS NULL;
ALTER TABLE ops_time_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ops_time_entries;
CREATE POLICY tenant_iso ON ops_time_entries
  USING (location_id = current_setting('app.location_id', true));
