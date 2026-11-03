// Tests for the Ask-AI tool registry — services/ai/tools/registry.js
//
// Run: node src/services/ai/__tests__/toolRegistry.test.mjs
//
// These are CONTRACT tests, not SQL tests: they check the shape the model
// sees. The SQL itself is exercised against a real Postgres separately,
// because the failure modes differ — a wrong column throws loudly, whereas a
// bad description fails silently by making the model pick the wrong tool.

import assert from 'node:assert';

process.env.DATABASE_URL ||= 'postgres://stub/stub';

const { LOOKUP_TOOLS, PROPOSE_TOOLS, toolCatalogue, runTool } =
  await import('../tools/registry.js');

const ALL_TOOLS = [...LOOKUP_TOOLS, ...PROPOSE_TOOLS];

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

await t('every tool has a name, description and schema', () => {
  for (const tool of ALL_TOOLS) {
    assert.ok(tool.name, 'missing name');
    assert.ok(tool.description, `${tool.name}: missing description`);
    assert.ok(tool.inputSchema, `${tool.name}: missing inputSchema`);
    assert.equal(typeof tool.run, 'function', `${tool.name}: missing run()`);
  }
});

await t('tool names are unique across both lookup and propose tools', () => {
  const names = ALL_TOOLS.map((x) => x.name);
  assert.equal(new Set(names).size, names.length);
});

await t('descriptions are long enough to route on', () => {
  // The description is ALL the model has when choosing. A terse one ("finds
  // deals") makes it guess between tools, which is the failure this whole
  // design exists to avoid.
  for (const tool of ALL_TOOLS) {
    assert.ok(tool.description.length >= 80,
      `${tool.name}: description too short to choose on`);
  }
});

await t('schemas are closed', () => {
  // additionalProperties:false — an unrecognised argument should be a visible
  // schema error, not silently ignored SQL that returns the wrong rows.
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false,
      `${tool.name}: schema is open`);
  }
});

await t('per-deal LOOKUP tools require a dealId', () => {
  // Derived from the name, not a hand-maintained list — a new get_deal_*
  // tool that forgets to require dealId would otherwise silently sail past
  // this check the way a hardcoded list always eventually does.
  const explicit = ['get_deal_messages', 'get_deal_history', 'get_deal_tasks_and_notes',
    'get_deal_detail', 'get_deal_contacts'];
  const perDealTools = LOOKUP_TOOLS.filter((x) => x.name.startsWith('get_deal_'));
  assert.ok(perDealTools.length >= explicit.length,
    'fewer get_deal_* tools found than expected — did one get renamed?');
  for (const tool of perDealTools) {
    assert.ok(tool.inputSchema.required?.includes('dealId'),
      `${tool.name}: dealId must be required`);
  }
});

await t('per-contact LOOKUP tools require a contactId', () => {
  const perContactTools = LOOKUP_TOOLS.filter((x) => x.name.startsWith('get_contact_'));
  assert.ok(perContactTools.length >= 1, 'expected at least get_contact_detail');
  for (const tool of perContactTools) {
    assert.ok(tool.inputSchema.required?.includes('contactId'),
      `${tool.name}: contactId must be required`);
  }
});

await t('every search_ LOOKUP tool offers countOnly', () => {
  // "How many X" is a count question, but the row-fetching path is capped
  // at MAX_ROWS — without countOnly there is no way to give an exact total
  // once the true number exceeds that cap (the bug this schema addition
  // fixed: search_contacts answered "at least 50, capped" to a plain "how
  // many contacts were updated last week"). Derived from the name, not a
  // hand-maintained list, so a new search_ tool can't silently ship without it.
  const searchTools = LOOKUP_TOOLS.filter((x) => x.name.startsWith('search_'));
  assert.ok(searchTools.length >= 6, 'fewer search_ tools found than expected — did one get renamed?');
  for (const tool of searchTools) {
    assert.equal(tool.inputSchema.properties?.countOnly?.type, 'boolean',
      `${tool.name}: must declare a countOnly:boolean property`);
  }
});

await t('per-deal PROPOSE tools require an opportunityId', () => {
  for (const name of [
    'propose_attach_contact', 'propose_remove_contact', 'propose_change_owner',
    'propose_change_status', 'propose_update_deal',
    'propose_delete_deal', 'propose_add_followers', 'propose_remove_followers'
  ]) {
    const tool = PROPOSE_TOOLS.find((x) => x.name === name);
    assert.ok(tool.inputSchema.required?.includes('opportunityId'),
      `${name}: opportunityId must be required`);
  }
});

await t('the catalogue never leaks run()', () => {
  // run() is a live database call. It must stay on our side of the wire.
  for (const entry of toolCatalogue()) {
    assert.ok(!('run' in entry), `${entry.name}: run() reached the catalogue`);
  }
});

await t('an unknown tool is an error, not a throw', async () => {
  const out = await runTool('L', 'definitely_not_a_tool', {});
  assert.ok(out.error, 'a hallucinated name should come back as { error }');
});

await t('every LOOKUP tool is read-only', () => {
  // A write reaching the model through a LOOKUP tool would let a question
  // mutate the CRM with no confirmation at all. This check is scoped to
  // LOOKUP_TOOLS on purpose — PROPOSE_TOOLS legitimately INSERT (see the
  // next test for what those are held to instead).
  const code = LOOKUP_TOOLS.map((x) => x.run.toString())
    .join('\n')
    .replace(/\/\/[^\n]*/g, '')        // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    // SQL comments inside the template literals. Without this the scan read
    // prose as code: a comment explaining that a NULL check would "silently
    // DROP a channel" tripped the DROP check, and the test failed on a tool
    // that executes nothing of the kind. A false positive here is worse than
    // useless — this is a safety check, and one that cries wolf gets muted.
    .replace(/--[^\n]*/g, '')
    .toUpperCase();
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(code), `a lookup tool contains ${verb}`);
  }
});

await t('every PROPOSE tool only ever calls proposeAction — never a GHL write function', () => {
  // The whole safety property of a propose tool is that it can INSERT into
  // ai_actions and nothing else — no ghlContactWrite/ghlOpportunityWrite/
  // ghlAssociations call, no UPDATE/DELETE on any other table. If a propose
  // tool ever calls a real write function directly, an AI-initiated CRM
  // write could fire with no rep confirmation in between — exactly the
  // failure this whole framework exists to prevent. Checked by SOURCE SCAN,
  // the same technique the LOOKUP read-only check already uses, so a
  // regression here fails loudly rather than needing a live GHL call to
  // notice.
  const code = PROPOSE_TOOLS.map((x) => x.run.toString())
    .join('\n')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden = [
    'createGhlContact', 'updateGhlContact', 'createGhlOpportunity',
    'updateGhlOpportunity', 'setGhlOpportunityStatus', 'deleteGhlOpportunity',
    'addDealContact', 'removeDealContact', 'sendGhlMessage', 'ghlRequest',
    'createGhlTask', 'updateGhlTask', 'setGhlTaskCompleted', 'deleteGhlTask',
    'createGhlNote', 'updateGhlNote', 'deleteGhlNote',
    'addGhlContactTags', 'removeGhlContactTags',
    'createGhlBusiness', 'updateGhlBusiness', 'deleteGhlBusiness',
    'addGhlOpportunityFollowers', 'removeGhlOpportunityFollowers'
  ];
  for (const name of forbidden) {
    assert.ok(!code.includes(name), `a propose tool calls ${name} directly — it must only proposeAction()`);
  }
  for (const verb of ['UPDATE', 'DELETE', 'DROP', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(code.toUpperCase()),
      `a propose tool contains ${verb} — it must only ever INSERT a pending ai_actions row`);
  }
});

await t('every propose tool asks for missing info instead of proposing an incomplete action', async () => {
  // Calling a propose tool with nothing should never insert a row — it
  // should come back asking for what's missing, the same way a required
  // form field would. This is what makes "ask for details conversationally"
  // work without a separate orchestration layer: the tool's own validation
  // IS the prompt for a follow-up turn.
  for (const tool of PROPOSE_TOOLS) {
    const out = await tool.run('L', {});
    assert.ok(Array.isArray(out.needsInfo) && out.needsInfo.length > 0,
      `${tool.name}: calling with no arguments should ask for info, got ${JSON.stringify(out)}`);
    assert.ok(!out.actionId, `${tool.name}: must not propose an action when required info is missing`);
  }
});

console.log(`\n${n} passed, 0 failed`);
