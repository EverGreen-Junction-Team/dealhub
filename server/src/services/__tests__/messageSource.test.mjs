// Tests for services/messageSource.js — deriveSenderType / labelForSenderType.
//
// Run: node src/services/__tests__/messageSource.test.mjs
//
// Why this is tested: the previous behavior collapsed every outbound message
// with no userId into a single 'unknown' bucket, which the UI showed as the
// bare, misleading "Us" — even for workflow sends, campaign blasts, bulk
// actions, AI auto-replies and connected-integration sends, none of which
// have a human sender at all. This locks in that each of those reads as
// itself, not as an undifferentiated "Us" or "unknown".

import { deriveSenderType, labelForSenderType } from '../messageSource.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── deriveSenderType ────────────────────────────────────────────────────

t('inbound is always contact, regardless of other fields',
  deriveSenderType({ userId: 'u1', workflowId: 'w1' }, 'inbound') === 'contact');

t('a direction that is neither inbound nor outbound is unknown',
  deriveSenderType({ userId: 'u1' }, 'automated') === 'unknown');

t('workflowId marks a workflow send',
  deriveSenderType({ workflowId: 'w1' }, 'outbound') === 'automation_workflow');

t('a campaignId prefixed workflow_ is still a workflow send',
  deriveSenderType({ campaignId: 'workflow_abc' }, 'outbound') === 'automation_workflow');

t('source: workflow is a workflow send even with no id',
  deriveSenderType({ source: 'workflow' }, 'outbound') === 'automation_workflow');

t('workflow beats campaign when both are present',
  deriveSenderType({ workflowId: 'w1', campaignId: 'c1' }, 'outbound') === 'automation_workflow');

t('a plain campaignId (not workflow-prefixed) is a campaign send',
  deriveSenderType({ campaignId: 'spring_sale' }, 'outbound') === 'automation_campaign');

t('a bulkReqId is a bulk send',
  deriveSenderType({ bulkReqId: 'b1' }, 'outbound') === 'automation_bulk');

t('isAutoReply flags an AI auto-reply',
  deriveSenderType({ isAutoReply: true }, 'outbound') === 'automation_ai');

t('isAiAutoReply.value flags an AI auto-reply',
  deriveSenderType({ isAiAutoReply: { value: true } }, 'outbound') === 'automation_ai');

t('a userId with none of the above is a real user',
  deriveSenderType({ userId: 'u1' }, 'outbound') === 'user');

t('userId wins over a bare conversationProviderId',
  deriveSenderType({ userId: 'u1', conversationProviderId: 'p1' }, 'outbound') === 'user');

t('a conversationProviderId with nothing else attributable is a provider send',
  deriveSenderType({ conversationProviderId: 'p1' }, 'outbound') === 'provider');

t('outbound with none of the signals is genuinely unknown',
  deriveSenderType({}, 'outbound') === 'unknown');

// ── labelForSenderType ──────────────────────────────────────────────────

t('workflow reads as "Workflow"', labelForSenderType('automation_workflow') === 'Workflow');
t('campaign reads as "Campaign"', labelForSenderType('automation_campaign') === 'Campaign');
t('bulk reads as "Bulk send"', labelForSenderType('automation_bulk') === 'Bulk send');
t('AI auto-reply reads as "AI auto-reply"', labelForSenderType('automation_ai') === 'AI auto-reply');

t('a provider send uses the real provider name when we have one',
  labelForSenderType('provider', 'Zapier') === 'Zapier');

t('a provider send with no resolved name falls back to "Integration", not "Us"',
  labelForSenderType('provider', null) === 'Integration');

t('unknown falls back to "Team member", never the bare "Us"',
  labelForSenderType('unknown') === 'Team member');

t('an unrecognised/legacy sender_type value also falls back to "Team member"',
  labelForSenderType('automation') === 'Team member');

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
