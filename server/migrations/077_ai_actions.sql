-- 077_ai_actions.sql
--
-- Proposed CRM writes from Co-Pilot — create a contact, attach a contact to
-- a deal, change the owner, change the status. Every write in this app
-- (contacts, opportunities, associations) already goes through a route a
-- rep drives, with a UI and a confirmation — see toolRegistry.test.mjs's
-- "every tool is read-only" guarantee and ghlContactWrite.js's own header
-- comment. This table is what makes an AI-proposed write follow that same
-- rule instead of a new one: the model can only ever INSERT a row here
-- describing what it WANTS to do; nothing calls GHL until a rep hits
-- Confirm on the specific action, which reads this row back by id and
-- checks it is still 'pending' before writing anything.
--
-- Deliberately NOT reused: ai_runs. That table is the answer transcript —
-- question in, validated prose out. A proposed action has its own
-- lifecycle (pending -> confirmed/edited/rejected/expired) independent of
-- whether the answer that surfaced it is ever re-read, and stuffing a
-- pending write into ai_runs.raw_output would make "is this still safe to
-- confirm" a JSONB reach-in instead of a plain WHERE clause.

CREATE TABLE IF NOT EXISTS ai_actions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     TEXT        NOT NULL,
  -- Which run proposed this — for the audit trail ("Co-Pilot proposed this
  -- because of THIS question"), and so a stale proposal from a reloaded old
  -- conversation can be told apart from one just made.
  run_id          UUID        REFERENCES ai_runs(id),
  -- Not every action is deal-scoped (create_contact and attach_contact need
  -- a deal id for the LATTER but a portfolio-wide "create this contact"
  -- question has none yet); nullable on purpose.
  opportunity_id  TEXT,

  action_type     TEXT        NOT NULL
    CHECK (action_type IN (
      'create_contact', 'attach_contact', 'change_owner', 'change_status'
    )),

  -- What the model proposed, e.g. for create_contact:
  --   { "firstName": "Jane", "lastName": "Doe", "phone": "+1...", "email": "..." }
  -- A rep can edit these in the confirmation card before confirming — see
  -- `edited_payload` below for what actually gets sent if they do.
  proposed_payload JSONB       NOT NULL,
  -- Set only if the rep changed something in the card before confirming.
  -- Kept SEPARATE from proposed_payload rather than overwriting it, so the
  -- audit trail preserves what the model actually proposed vs. what a human
  -- decided to send instead — the same distinction mapping_status keeps for
  -- attribution decisions (migration 034's message_opportunity_map).
  edited_payload  JSONB,

  status          TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed', 'expired')),
  -- GHL's own response id / error, once the write actually runs. Failed
  -- stays inspectable rather than silently reverting to pending — a rep who
  -- clicks Confirm and gets a CRM rejection needs to see why, not just "try
  -- again" with no more information than before.
  result          JSONB,

  confirmed_by    TEXT,                          -- GHL user id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ                     -- confirmed/rejected/expired timestamp
);

-- The confirm route's hot path: "is this id still pending, in this
-- location". Confirming twice (a double-click, a retried request) must be a
-- no-op the second time, not a second contact/attach/owner-change — this is
-- the index that makes that check cheap.
CREATE INDEX IF NOT EXISTS ai_actions_loc_status
  ON ai_actions (location_id, status);

ALTER TABLE ai_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON ai_actions;
CREATE POLICY tenant_iso ON ai_actions
  USING (location_id = current_setting('app.location_id', true));

COMMENT ON TABLE ai_actions IS
  'Proposed CRM writes from Co-Pilot, awaiting a rep''s confirmation. The model may only INSERT a pending row describing what it wants to do; the actual GHL write happens only when a rep confirms this specific row by id.';
