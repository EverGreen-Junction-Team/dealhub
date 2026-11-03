// Tests for the thread budget — services/ai/contextBuilder.js applyThreadBudget.
//
// Run: node src/services/ai/__tests__/threadBudget.test.mjs
//
// This function decides what the AI is allowed to read. Three properties have
// to hold or answers become quietly wrong:
//
//   1. It keeps the NEWEST messages. Recency is what a deal question needs,
//      and rule 4 ("the latest version wins") is meaningless if the newest
//      message is the one dropped.
//   2. It returns them OLDEST-FIRST. The prompt states messages are in
//      chronological order; hand the model a reversed thread and it will read
//      a superseded price as the current one.
//   3. It reports the drop count. A silently truncated thread produces a
//      confident answer built on half the evidence, with nothing on screen
//      saying so — the one failure a rep cannot catch.

import { applyThreadBudget } from '../threadBudget.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ~4 chars/token, plus the ~200-char XML wrapper the real cost() accounts for.
const msg = (id, chars) => ({ message_id: id, body_text: 'x'.repeat(chars) });
const ids = (r) => r.kept.map((m) => m.message_id).join(',');

// ── Under budget: nothing changes ────────────────────────────────────
const small = [msg('m1', 400), msg('m2', 400), msg('m3', 400)];
t('keeps every message when under budget',
  applyThreadBudget(small, 150_000).kept.length === 3);
t('reports nothing dropped when under budget',
  applyThreadBudget(small, 150_000).dropped === 0);
t('preserves order when under budget',
  ids(applyThreadBudget(small, 150_000)) === 'm1,m2,m3');

// ── Over budget: newest survive, oldest-first order preserved ────────
// Each message ≈ (4000 + 200)/4 = 1050 tokens. A 2200 budget fits two.
const many = [msg('m1', 4000), msg('m2', 4000), msg('m3', 4000), msg('m4', 4000)];
const cut = applyThreadBudget(many, 2200);
t('drops the oldest, not the newest', ids(cut) === 'm3,m4');
t('returns survivors oldest-first', ids(cut) === 'm3,m4');
t('reports the exact number dropped', cut.dropped === 2);
t('kept + dropped accounts for every message',
  cut.kept.length + cut.dropped === many.length);

// ── The single-oversized-message case ────────────────────────────────
// One 400k-char transcript against a 1000-token budget. Dropping it leaves the
// model nothing to read, which is worse than one oversized message.
const huge = applyThreadBudget([msg('big', 400_000)], 1000);
t('keeps one oversized message rather than sending an empty thread',
  huge.kept.length === 1 && huge.dropped === 0);

// And it must not swallow newer messages alongside it.
const hugeThenNew = applyThreadBudget([msg('big', 400_000), msg('new', 400)], 1000);
t('an oversized OLD message does not evict the newest one',
  hugeThenNew.kept.some((m) => m.message_id === 'new'));

// ── Edges ────────────────────────────────────────────────────────────
t('empty thread returns empty, not a crash',
  (() => { const r = applyThreadBudget([], 1000); return r.kept.length === 0 && r.dropped === 0; })());
t('a zero budget still returns the newest message',
  applyThreadBudget(many, 0).kept.length === 1);
t('the message kept at zero budget is the NEWEST',
  applyThreadBudget(many, 0).kept[0].message_id === 'm4');
t('null body_text does not throw',
  applyThreadBudget([{ message_id: 'n', body_text: null }], 1000).kept.length === 1);

// ── Regression: the reverse() must not mutate order twice ────────────
// Calling it repeatedly on the same array has to be stable — a shared context
// object gets read more than once per request.
const stable = [msg('a', 400), msg('b', 400), msg('c', 400)];
const first = ids(applyThreadBudget(stable, 150_000));
const second = ids(applyThreadBudget(stable, 150_000));
t('is idempotent — repeated calls give the same order', first === second);
t('does not mutate the input array',
  stable.map((m) => m.message_id).join(',') === 'a,b,c');

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
