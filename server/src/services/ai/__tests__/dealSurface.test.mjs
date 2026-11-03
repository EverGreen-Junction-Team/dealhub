// The deal surface boundary: what Deal AI may call, and on which deal.
//
// These are the two halves of the tenant/scope boundary — the catalogue
// decides what is OFFERED, runTool decides what can RUN. Both are asserted
// because either alone is bypassable.
process.env.DATABASE_URL ||= 'postgres://x/x';
process.env.GHL_CLIENT_ID ||= 'x';
process.env.GHL_CLIENT_SECRET ||= 'x';
process.env.GHL_REDIRECT_URI ||= 'http://x';
process.env.GHL_WEBHOOK_PUBLIC_KEY ||= 'x';
process.env.INTERNAL_API_KEY ||= 'x';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Dynamic: static imports are hoisted ABOVE the env assignments above, and
// config.js throws on a missing DATABASE_URL at module load.
const { toolCatalogue, runTool, ACCOUNT_ONLY_TOOLS, COMPOSER_POINTER } = await import('../tools/registry.js');
const { evidenceFromToolCalls } = await import('../toolEvidence.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { fail++; console.error(`FAIL ${name}\n  ${e.message}`); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; } catch (e) { fail++; console.error(`FAIL ${name}\n  ${e.message}`); }
};

const dealTools = toolCatalogue('deal').map((x) => x.name);
const allTools = toolCatalogue('portfolio').map((x) => x.name);

// ── what is offered ──────────────────────────────────────────────────
t('deal surface offers fewer tools than portfolio', () =>
  assert.ok(dealTools.length < allTools.length));

t('no account-wide tool reaches the deal surface', () => {
  const leaked = dealTools.filter((n) => ACCOUNT_ONLY_TOOLS.has(n));
  assert.deepEqual(leaked, []);
});

t('search_deals is withheld', () => assert.ok(!dealTools.includes('search_deals')));
t('get_rep_performance is withheld', () => assert.ok(!dealTools.includes('get_rep_performance')));
t('search_contacts is withheld', () => assert.ok(!dealTools.includes('search_contacts')));

for (const keep of ['get_deal_messages', 'get_deal_tasks_and_notes',
  'get_deal_contacts', 'get_deal_detail', 'get_deal_history', 'get_deal_metrics']) {
  t(`${keep} is kept`, () => assert.ok(dealTools.includes(keep)));
}

t('write tools are available on a deal', () => {
  const writes = dealTools.filter((n) => n.startsWith('propose_'));
  assert.ok(writes.length >= 14, `only ${writes.length} write tools`);
  assert.ok(writes.includes('propose_create_task'));
});

// Messages to a customer go out from the timeline composer, not Co-Pilot.
t('propose_send_message is withheld on a deal', () =>
  assert.ok(!dealTools.includes('propose_send_message')));
t('Insights AI (portfolio) keeps propose_send_message', () =>
  assert.ok(allTools.includes('propose_send_message')));

t('propose_create_deal is withheld — that is not a deal-scoped action', () =>
  assert.ok(!dealTools.includes('propose_create_deal')));

// ── what may run ─────────────────────────────────────────────────────
await ta('an account-wide tool is refused even if somehow called', async () => {
  const r = await runTool('L1', 'search_deals', {}, { surface: 'deal', dealId: 'A' });
  assert.match(r.error || '', /not available when asking about a single deal/);
});

await ta('a send is refused on a deal even if somehow called, with the composer pointer', async () => {
  const r = await runTool('L1', 'propose_send_message', { contactId: 'c1', type: 'Email' }, { surface: 'deal', dealId: 'A' });
  assert.equal(r.error, COMPOSER_POINTER);
});

await ta('portfolio surface still runs account-wide tools', async () => {
  const r = await runTool('L1', 'search_deals', {}, { surface: 'portfolio' });
  // It will fail on the fake DB — the point is it was NOT refused by scope.
  assert.doesNotMatch(r.error || '', /not available when asking about a single deal/);
});

// ── the prompt must agree with the catalogue ─────────────────────────
// TOOL_SYSTEM_PROMPT rule 13 says to resolve ids with search_contacts, which
// the deal surface withholds. A model following it literally reaches for a
// tool that is not there and gives up — which is how "draft a message to the
// client" became "Working on that."
const { DEAL_TOOL_PROMPT } = await import('../tools/prompt.js');

t('the deal prompt names the tool that IS available', () =>
  assert.match(DEAL_TOOL_PROMPT, /get_deal_contacts/));

t('it says the account-wide tools are absent', () =>
  assert.match(DEAL_TOOL_PROMPT, /search_contacts/));

t('every tool the deal prompt recommends is actually offered', () => {
  for (const name of ['get_deal_contacts',
    'propose_create_task', 'propose_create_note']) {
    assert.ok(dealTools.includes(name), `${name} is recommended but not offered`);
  }
});

t('it tells the model it cannot message from a deal, and where to send from', () => {
  assert.match(DEAL_TOOL_PROMPT, /You cannot send, draft or propose a message/);
  assert.ok(DEAL_TOOL_PROMPT.includes(COMPOSER_POINTER));
  assert.doesNotMatch(DEAL_TOOL_PROMPT, /write it and propose it/);
});

t('the pointer names the composer above, and Reply for an email', () => {
  assert.match(COMPOSER_POINTER, /bottom of the Timeline above/);
  assert.match(COMPOSER_POINTER, /press Reply on that email/);
});

// ── evidence collection ──────────────────────────────────────────────
t('tool rows become citable evidence', () => {
  const ev = evidenceFromToolCalls([
    { name: 'get_deal_messages', result: { messages: [{ id: 'm1', body_text: 'Quote by Friday' }] } }
  ]);
  assert.deepEqual(ev, [{ id: 'm1', text: 'Quote by Friday' }]);
});

t('rows with no text are not evidence', () => {
  const ev = evidenceFromToolCalls([
    { name: 'get_deal_messages', result: { messages: [{ id: 'm1', body_text: '' }] } }
  ]);
  assert.deepEqual(ev, []);
});

t('aggregates yield no evidence', () => {
  const ev = evidenceFromToolCalls([
    { name: 'get_deal_metrics', result: { speedToLead: 42, winRate: 0.3 } }
  ]);
  assert.deepEqual(ev, []);
});

t('a task quotes title and body', () => {
  const ev = evidenceFromToolCalls([
    { name: 'get_deal_tasks_and_notes', result: { tasks: [{ id: 't1', title: 'Send quote', body: 'by EOW' }] } }
  ]);
  assert.match(ev[0].text, /Send quote/);
  assert.match(ev[0].text, /by EOW/);
});

// ── THE "Working on that." REGRESSION ────────────────────────────────
//
// A rep asked Deal AI to "draft a message" and got back the literal words
// "Working on that." and no draft. Three separate faults, one per test.

const askDealSrc = readFileSync(
  new URL('../askDeal.js', import.meta.url), 'utf8'
);

t('INSTRUCTION does not tell the model to defer a write request', () => {
  // The prompt was written for the OLD two-call design, where a second step
  // did the drafting and this sentence was a placeholder for its answer. The
  // port to the tool loop removed that step; the instruction survived, so the
  // model dutifully said "Working on that." and never called the tool that
  // was sitting on its catalogue.
  const instruction = askDealSrc.slice(
    askDealSrc.indexOf('const INSTRUCTION'),
    askDealSrc.indexOf('function threadBlock') > 0
      ? askDealSrc.indexOf('function threadBlock')
      : askDealSrc.indexOf('const IMAGE_NOTE')
  );
  assert.ok(
    !/reply with the single sentence/i.test(instruction),
    'INSTRUCTION still asks the model to reply with a placeholder sentence'
  );
  assert.ok(
    /IS your job/.test(instruction),
    'INSTRUCTION should tell the model that write requests are its job'
  );
  assert.ok(
    !/propose_send_message/.test(instruction),
    'INSTRUCTION must not offer a message-drafting tool on a deal'
  );
  assert.ok(
    instruction.includes('${COMPOSER_POINTER}'),
    'INSTRUCTION should answer a message request with the composer pointer'
  );
});

t('a draft the model made via a tool reaches the rep', () => {
  // proposedActions was ASSIGNED from the detector, which discarded anything
  // the loop had already proposed. So a draft written by propose_send_message
  // was stored in ai_actions and then dropped — no card, no draft on screen.
  assert.ok(
    /toolResult\.proposedActions/.test(askDealSrc),
    'askDeal must read the proposals the tool loop produced'
  );
  const detectorLine = askDealSrc.match(/proposedActions = detected\.proposedActions/);
  assert.equal(
    detectorLine, null,
    'the detector must not overwrite the loop\'s proposals'
  );
});

t('an emailed draft carries the rep signature, as the portfolio surface does', () => {
  // askPortfolio has always appended it. The deal surface could not, because
  // until now it never saw a send_message proposal at all.
  assert.ok(
    /getSignature/.test(askDealSrc),
    'deal drafts should get the same signature treatment as portfolio drafts'
  );
});

t('an OLD deal-chat send draft cannot be confirmed; Insights AI drafts can', () => {
  const exec = readFileSync(new URL('../actionExecutor.js', import.meta.url), 'utf8');
  const guard = exec.slice(exec.indexOf("if (action.action_type === 'send_message' && action.run_id)"));
  assert.ok(guard.length > 0, 'the confirm guard is missing');
  // Deal runs carry their deal id; portfolio runs carry none.
  assert.match(guard, /SELECT opportunity_id FROM ai_runs/);
  assert.match(guard, /if \(rows\[0\]\?\.opportunity_id\) \{\s*\n\s*throw new ActionExecutionError\(COMPOSER_POINTER/);
  // RLS table: read through withTenant.
  assert.match(guard.slice(0, 400), /withTenant\(locationId/);
  // It runs BEFORE anything reaches GHL.
  assert.ok(exec.indexOf("action.action_type === 'send_message' && action.run_id") < exec.indexOf('await runWrite(install'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
