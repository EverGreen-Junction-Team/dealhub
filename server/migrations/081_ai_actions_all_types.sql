-- 081_ai_actions_all_types.sql
--
-- ai_actions.action_type allowed FIVE values while the Co-Pilot could propose
-- TWENTY-FOUR. Every action outside that five — create_task, create_note,
-- create_deal, add_tags, update_contact, the delete_* family, all of them —
-- failed at INSERT with:
--
--   new row for relation "ai_actions" violates check constraint
--   "ai_actions_action_type_check"
--
-- runTool returns that string to the model as the tool's result, so the model
-- read a genuine unrecoverable system fault and told the rep to contact whoever
-- administers the integration. It was right to. The tools, the executor and the
-- confirmation card had all been extended; only this constraint was not, so the
-- feature looked shipped and failed on first use.
--
-- WHY THE LIST IS NOW EXHAUSTIVE. 077 enumerated the four types that existed
-- then and 078 appended one more. That pattern requires a migration per action
-- and fails LOUDLY but LATE — at runtime, in front of a rep, as an opaque
-- constraint error. The list below is the full set actionExecutor.js dispatches
-- on; a test now asserts the two stay equal (test:actiontypes), so a new action
-- fails CI instead of production.

ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_action_type_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_action_type_check
  CHECK (action_type IN (
    -- contacts
    'create_contact', 'update_contact', 'attach_contact', 'remove_contact',
    -- deals
    'create_deal', 'update_deal', 'delete_deal',
    'change_owner', 'change_status',
    -- tasks
    'create_task', 'update_task', 'complete_task', 'delete_task',
    -- notes
    'create_note', 'update_note', 'delete_note',
    -- businesses
    'create_business', 'update_business', 'delete_business',
    -- tags & followers
    'add_tags', 'remove_tags', 'add_followers', 'remove_followers',
    -- outbound comms
    'send_message'
  ));

COMMENT ON COLUMN ai_actions.action_type IS
  'Which CRM write a rep is being asked to confirm. Must stay in lockstep with the case labels in services/ai/actionExecutor.js — see test:actiontypes, which fails when they diverge.';
