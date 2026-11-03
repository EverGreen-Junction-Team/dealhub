-- 050_ai_runs.sql
--
-- Audit trail for every LLM call. This is the only way to answer "why did it
-- say that" after the fact, and it's the eval/training set for tuning — so it
-- goes in before the first call ships, not after. Retrofitting it means
-- throwing away the first months of feedback.
--
-- Two tables:
--   ai_runs       — one row per call: inputs, output, cost, latency, outcome
--   ai_feedback   — one row per human confirm/dismiss on a run's item
--
-- ai_runs.input_message_ids is the exact set the model read. Combined with
-- config_version it forms the cache key: same messages + same Control centre
-- config = same answer, so re-opening a deal doesn't re-bill.

CREATE TABLE IF NOT EXISTS ai_runs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         TEXT        NOT NULL,
  -- Which of the six spec'd calls this was.
  call_type           TEXT        NOT NULL
    CHECK (call_type IN ('analysis', 'ask', 'next_step', 'task_proposals', 'deal_assignment')),
  opportunity_id      TEXT,                     -- null for deal_assignment (that's the question)

  -- ── Inputs, for reproducibility ────────────────────────────────────
  -- The exact message set read, ordered. Doubles as the cache key input.
  input_message_ids   TEXT[]      NOT NULL DEFAULT '{}',
  -- Hash of (message id set + config version + call type + question). A
  -- repeat request with the same hash serves the cached row instead of
  -- re-billing.
  cache_key           TEXT,
  -- Bumped whenever Control centre config changes, so a config edit
  -- invalidates cached runs without hashing the whole config blob.
  config_version      INTEGER     NOT NULL DEFAULT 0,
  -- The rep's question (ask calls only).
  question            TEXT,

  -- ── Model identity ────────────────────────────────────────────────
  model               TEXT        NOT NULL,
  prompt_version      TEXT        NOT NULL,     -- e.g. 'analysis.v1'

  -- ── Output ────────────────────────────────────────────────────────
  -- Raw model output, pre-validation. Kept even when validation rejects
  -- items: a run that produced unquotable claims is exactly what you want
  -- to inspect later.
  raw_output          JSONB,
  -- Post-validation, what the UI actually rendered.
  validated_output    JSONB,
  -- Items dropped by the quote-substring / id-existence checks, with why.
  -- A rising count here is a prompt bug.
  rejected_items      JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- ── Coverage stamp (computed in app code, never from the model) ────
  messages_total      INTEGER,
  messages_read       INTEGER,
  unread_reasons      TEXT[]      NOT NULL DEFAULT '{}',

  -- ── Operational ───────────────────────────────────────────────────
  status              TEXT        NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'timeout', 'malformed', 'api_error',
                      'rate_limited', 'empty', 'refused')),
  error               TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  latency_ms          INTEGER,
  -- Session user who triggered the run; null for system/cron-driven runs.
  triggered_by        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Show me this deal's last analysis" — the hot read.
CREATE INDEX IF NOT EXISTS ai_runs_loc_opp_type_created
  ON ai_runs (location_id, opportunity_id, call_type, created_at DESC);

-- Cache lookup. Partial: only successful runs are worth serving from cache.
CREATE INDEX IF NOT EXISTS ai_runs_cache_key
  ON ai_runs (location_id, cache_key)
  WHERE cache_key IS NOT NULL AND status = 'ok';

-- "What's failing, and how often" — the ops read.
CREATE INDEX IF NOT EXISTS ai_runs_status_created
  ON ai_runs (location_id, status, created_at DESC)
  WHERE status <> 'ok';

COMMENT ON TABLE ai_runs IS
  'Audit trail for every LLM call (Deal Hub AI spec). One row per call: exact input message set, config version, model, raw + validated output, rejected items, coverage stamp, tokens, latency. Answers "why did it say that" and is the eval set for prompt tuning.';
COMMENT ON COLUMN ai_runs.rejected_items IS
  'Items the model returned that failed validation (missing quote, quote not a substring of the cited message, unknown message/contact id). A rising count is a prompt bug, not a data problem.';
COMMENT ON COLUMN ai_runs.cache_key IS
  'sha256 of (call_type + sorted input_message_ids + config_version + question). Identical key + status ok = serve the stored output instead of re-billing.';

ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ai_runs;
CREATE POLICY tenant_iso ON ai_runs
  USING (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- ai_feedback — the highest-value signal in the system.
--
-- Nothing the model proposes counts until a human confirms it. Every
-- confirm/dismiss lands here. Dismissals with a reason are what you review to
-- find prompt bugs: a repeated dismissal pattern on one item type is a
-- prompt problem, not a user problem.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_feedback (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       TEXT        NOT NULL,
  run_id            UUID        NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  opportunity_id    TEXT,
  -- Which kind of proposal this was: commitment_ours / commitment_theirs /
  -- why_change / why_now / why_us / qualification / task / next_step.
  item_type         TEXT        NOT NULL,
  -- Stable identity for the item within the run, so a re-run can match an
  -- already-confirmed item instead of re-proposing it: (text, quote_message_id).
  item_key          TEXT        NOT NULL,
  item_payload      JSONB       NOT NULL,
  action            TEXT        NOT NULL CHECK (action IN ('confirmed', 'dismissed', 'edited')),
  -- Free text on dismissal. The single most useful column in this schema.
  reason            TEXT,
  -- Present when action = 'edited': what the human changed it to.
  edited_payload    JSONB,
  acted_by          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: re-running analysis must not duplicate a confirmed item.
-- The writer checks this key before proposing.
CREATE UNIQUE INDEX IF NOT EXISTS ai_feedback_item_uniq
  ON ai_feedback (location_id, opportunity_id, item_type, item_key);

CREATE INDEX IF NOT EXISTS ai_feedback_run
  ON ai_feedback (run_id);

-- The review query: "every dismissal with a reason, newest first".
CREATE INDEX IF NOT EXISTS ai_feedback_dismissals
  ON ai_feedback (location_id, item_type, created_at DESC)
  WHERE action = 'dismissed';

COMMENT ON TABLE ai_feedback IS
  'Human confirm/dismiss/edit on each AI proposal. Drives the "nothing counts until confirmed" rule, provides idempotency on re-runs via item_key, and is the primary tuning signal — review dismissal reasons to find prompt bugs.';

ALTER TABLE ai_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ai_feedback;
CREATE POLICY tenant_iso ON ai_feedback
  USING (location_id = current_setting('app.location_id', true));

-- ─────────────────────────────────────────────────────────────────────────
-- Config version counter on location_ai_settings (migration 049).
--
-- Any Control centre edit bumps this, which changes every cache key for the
-- location — so a new product or tone sample invalidates stale analyses
-- without needing to hash the config itself.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE location_ai_settings
  ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN location_ai_settings.config_version IS
  'Monotonic counter bumped on every Control centre save. Part of every ai_runs cache key, so config edits invalidate cached AI output.';
