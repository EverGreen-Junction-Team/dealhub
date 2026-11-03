-- 078_ai_actions_send_message.sql
--
-- Adds 'send_message' to ai_actions.action_type (migration 077) — the
-- first Co-Pilot-proposed action that reaches a CUSTOMER (an SMS or
-- email), not just internal CRM state. Same propose-then-confirm rule as
-- every other action: a propose tool only ever inserts a pending row here;
-- the actual GHL send happens only when a rep confirms it (see
-- ghlMessageWrite.js, actionExecutor.js).

ALTER TABLE ai_actions DROP CONSTRAINT ai_actions_action_type_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_action_type_check
  CHECK (action_type IN (
    'create_contact', 'attach_contact', 'change_owner', 'change_status',
    'send_message'
  ));
