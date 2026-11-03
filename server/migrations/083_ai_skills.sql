-- 083_ai_skills.sql
--
-- AI skills: a saved, named question shape that runs against a DATABASE VIEW.
--
-- WHY. Every answer today comes from SQL hand-written in
-- services/ai/tools/registry.js. That works, but it means the query logic
-- lives in application code rather than with the data team who own the
-- definitions, and adding a new kind of question needs a deploy. The data
-- team is now building views; a skill points the AI at one.
--
-- WHAT A SKILL IS NOT: it does not store SQL. The account page captures a
-- VIEW NAME and the parameters it accepts, and the app builds a parameterised
-- SELECT from that. Storing SQL typed into a web form would put arbitrary
-- query execution behind an HTTP endpoint, which no amount of a read-only
-- role makes comfortable. The view is written in a migration, reviewed like
-- any other schema change.
--
-- HOW THE AI SEES IT. Enabled skills are turned into ordinary tools at
-- request time (services/ai/tools/skillTools.js) with the same shape as every
-- built-in one: name, description, input schema. The model cannot tell them
-- apart, which is the point — no new mechanism to reason about.
--
-- RLS. A skill's view MUST be created WITH (security_invoker = true), or it
-- runs as its owner and silently bypasses row-level security — one client's
-- data in another client's answer. Migration 042 exists because exactly this
-- was missed once. validateSkillView() refuses to register a view that lacks
-- it, so the mistake cannot reach a rep.

CREATE TABLE IF NOT EXISTS ai_skills (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     TEXT        NOT NULL,

  -- What the model sees. `name` becomes the tool name, so it has to look like
  -- one: lower snake_case, no spaces. Checked here rather than only in the
  -- app, because a malformed name reaches Anthropic's API as a 400 that is
  -- hard to trace back to a row someone typed three weeks ago.
  name            TEXT        NOT NULL
    CHECK (name ~ '^[a-z][a-z0-9_]{2,48}$'),
  -- The single most important field. The model chooses tools almost entirely
  -- on their description, so this is where "when should I use this" lives.
  description     TEXT        NOT NULL CHECK (length(trim(description)) >= 20),

  -- The view it reads. Unqualified name; schema is always public.
  view_name       TEXT        NOT NULL
    CHECK (view_name ~ '^[a-z][a-z0-9_]{2,62}$'),

  -- Parameters the model may pass, as:
  --   [{ "name": "rep", "column": "owner_name", "type": "text",
  --      "op": "eq", "description": "Rep's name" }]
  -- `column` is checked against the view's real columns on save, so a typo is
  -- caught then rather than at 2am inside someone's question.
  params          JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Columns to return. Empty = all of them. A view built for a dashboard can
  -- be 40 columns wide; feeding all of that to the model is tokens spent on
  -- nothing.
  columns         JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Default ordering, e.g. "quiet_days DESC". Validated against real columns.
  order_by        TEXT,
  row_limit       INT         NOT NULL DEFAULT 50
    CHECK (row_limit BETWEEN 1 AND 500),

  -- Which surface may use it. Both by default: a skill that answers across
  -- deals belongs to Insights AI, one scoped to a single deal to Deal AI, and
  -- plenty suit both.
  surfaces        TEXT[]      NOT NULL DEFAULT ARRAY['deal', 'portfolio']
    CHECK (surfaces <@ ARRAY['deal', 'portfolio']::text[] AND cardinality(surfaces) > 0),

  is_enabled      BOOLEAN     NOT NULL DEFAULT true,

  -- Audit. A skill changes what the AI can answer, so who last touched it is
  -- worth keeping.
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Observability: a skill nobody uses is a skill with a bad description.
  last_used_at    TIMESTAMPTZ,
  use_count       INT         NOT NULL DEFAULT 0,

  UNIQUE (location_id, name)
);

CREATE INDEX IF NOT EXISTS ai_skills_enabled_idx
  ON ai_skills (location_id)
  WHERE is_enabled = true;

COMMENT ON TABLE ai_skills IS
  'Saved question shapes that expose a database view to the AI as a tool. No SQL is stored — see 083 header.';
COMMENT ON COLUMN ai_skills.view_name IS
  'A public view, which MUST have security_invoker = true or it bypasses RLS. Enforced by validateSkillView() before a row is written.';
COMMENT ON COLUMN ai_skills.description IS
  'What the model reads when deciding whether to use this. The quality of this text is the quality of the skill.';

ALTER TABLE ai_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ai_skills;
CREATE POLICY tenant_iso ON ai_skills
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));
