// Tests for the "has this deal gone quiet" fact — shapeDeal's quiet_days/
// last_inbound_at computation (contextBuilder.js) and threadBlock's
// rendering of it (prompts.js).
//
// Run: node src/services/ai/__tests__/quietDays.test.mjs
//
// WHY THIS EXISTS. Before this, "why has this deal gone quiet" was answered
// by the model re-deriving a day count from raw message timestamps in the
// thread — it worked, but as inference, not a fact, and could disagree with
// search_deals's quietDays filter (registry.js) for the exact same deal.
// This locks down that the two now share one computation and that the
// never-replied edge case reads as a real, distinct fact rather than a
// missing/zero value.

import assert from 'node:assert';

process.env.DATABASE_URL ||= 'postgres://stub/stub';

const { shapeDeal } = await import('../contextBuilder.js');
const { threadBlock } = await import('../prompts.js');

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
};

const baseRow = {
  opportunity_id: 'o1', name: 'Test Deal', current_stage_name: 'Quote Sent',
  stage_entered_at: null, status: 'open', monetary_value: null, currency: 'GBP',
  owner_name: null, assigned_to_name: null, forecast_close_date: null,
  pipeline_name: null, product_system: null, product_type: null, client_type: null,
  lead_source_opportunity: null, opportunity_source: null, created_at_ghl: null
};

t('a deal with a recent inbound message gets a numeric quiet_days', () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
  const shaped = shapeDeal({ ...baseRow, last_inbound_at: threeDaysAgo }, []);
  assert.equal(shaped.quiet_days, 3);
  assert.equal(shaped.last_inbound_at, threeDaysAgo);
});

t('a deal that never received an inbound message has quiet_days null', () => {
  const shaped = shapeDeal({ ...baseRow, last_inbound_at: null }, []);
  assert.equal(shaped.quiet_days, null);
  assert.equal(shaped.last_inbound_at, null);
});

function ctxWith(deal) {
  return {
    deal,
    people: [],
    notes: [],
    tasks: [],
    messages: [],
    coverage: { unreadReasons: [] }
  };
}

t('threadBlock states a numeric quiet-days fact when the deal has replied before', () => {
  const shaped = shapeDeal({ ...baseRow, last_inbound_at: new Date(Date.now() - 12 * 86400000).toISOString() }, []);
  const [block] = threadBlock(ctxWith(shaped));
  assert.ok(block.text.includes('Days since the customer last replied: 12'),
    `expected a "Days since..." line, got:\n${block.text}`);
});

t('threadBlock states the never-replied case distinctly, not as a blank/zero', () => {
  const shaped = shapeDeal({ ...baseRow, last_inbound_at: null }, []);
  const [block] = threadBlock(ctxWith(shaped));
  assert.ok(block.text.includes('The customer has never sent an inbound message on this deal.'),
    `expected the never-replied sentence, got:\n${block.text}`);
  assert.ok(!block.text.includes('Days since the customer last replied'),
    'should not also print the numeric line when there is no last_inbound_at');
});

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
