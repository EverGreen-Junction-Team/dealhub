// Tests for the citation validator — the load-bearing safety guarantee.
//
// Run: node src/services/ai/__tests__/validate.test.mjs
//
// These are not incidental tests. The validator is what turns "every claim
// carries a quote" from a prompt request into an enforced invariant, and the
// asymmetry it enforces (drop rather than display) is the difference between
// a rep trusting the panel and never reading it again. A regression here ships
// fabricated quotes.

import { makeValidator } from '../validate.js';

const ctx = {
  messages: [
    // Stored as HTML with entities — dataCleaner keeps email markup — while
    // the model is shown the text. Normalisation has to bridge that.
    { message_id: 'm1', body_text: '<p>Hi Sarah — I&#39;ll send the revised quote on Thursday.</p>' },
    { message_id: 'm2', body_text: 'We need it under £30k including the garden room.' }
  ],
  notes: [{ note_id: 'n1', body: 'Builder Dave on site Thursdays.' }],
  people: [{ contact_id: 'p1' }]
};

let pass = 0;
const failures = [];
function t(name, cond) {
  if (cond) pass++;
  else failures.push(name);
}
const v = () => makeValidator(ctx);

// ── Accepts: real quotes, tolerating formatting differences ──────────
t('verbatim quote accepted',
  !!v().check('c', { value: 'x', quote_message_id: 'm1', quote_text: 'send the revised quote on Thursday' }));

t('html tags and entities normalised',
  !!v().check('c', { value: 'x', quote_message_id: 'm1', quote_text: "I'll send the revised quote" }));

t('curly apostrophe matches straight',
  !!v().check('c', { value: 'x', quote_message_id: 'm1', quote_text: 'I’ll send the revised quote' }));

t('notes are citable evidence',
  !!v().check('c', { value: 'x', quote_message_id: 'n1', quote_text: 'Dave on site Thursdays' }));

// ── Rejects: anything unverifiable ───────────────────────────────────
t('paraphrase rejected',
  v().check('c', { value: 'x', quote_message_id: 'm1', quote_text: 'I will send a new quote Thursday' }) === null);

t('invented message id rejected',
  v().check('c', { value: 'x', quote_message_id: 'm99', quote_text: 'anything' }) === null);

t('real quote against wrong message rejected',
  v().check('c', { value: 'x', quote_message_id: 'm2', quote_text: 'send the revised quote' }) === null);

t('value with no quote rejected',
  v().check('c', { value: 'something', quote_message_id: null, quote_text: null }) === null);

t('empty quote rejected',
  v().check('c', { value: 'x', quote_message_id: 'm1', quote_text: '   ' }) === null);

// ── Null is a valid answer (rule 8: no invention) ────────────────────
{
  const r = v().check('c', { value: null });
  t('null value passes with no quote', r && r.value === null && r.quote_text === null);
}

// ── Contact ids are existence-checked, not fatal ─────────────────────
{
  const r = v().check(
    'c',
    { value: 'x', quote_message_id: 'm2', quote_text: 'under £30k', owed_to_contact_id: 'ghost' },
    { contactFields: ['owed_to_contact_id'] }
  );
  t('unknown contact id nulled, item kept', r && r.owed_to_contact_id === null);
}

// ── Rejections are recorded with a reason ────────────────────────────
{
  const val = v();
  val.check('commitment', { value: 'x', quote_message_id: 'm1', quote_text: 'not in there at all' });
  t('rejection recorded with reason',
    val.rejected.length === 1 && /verbatim substring/.test(val.rejected[0].reason));
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL: ${f}`);
process.exit(failures.length ? 1 : 0);
