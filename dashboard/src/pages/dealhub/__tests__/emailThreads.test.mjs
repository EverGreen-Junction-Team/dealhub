// Which emails fold into a thread, and what the thread dialog opens with.
//
// WHY THIS IS WORTH A TEST. The grouping decides whether a row offers a
// control at all, and the two failure modes are both silent:
//
//   • grouping too eagerly — a lone email offering "1 in thread", or an SMS
//     appearing inside an email dialog
//   • grouping too little — a reply that never surfaces, so a rep reads a
//     two-message exchange as the whole conversation
//
// Neither throws. Both just look plausible and mislead.
//
// The dialog's open-state rule is here too, because "latest expanded, older
// collapsed" has an edge that is easy to get wrong: clicking an OLDER message
// must open that one as well, or the click lands on a dialog that expanded
// something else.
//
// Source-parsed rather than imported: Timeline.jsx pulls in React and the
// component tree, and buildThreads is a pure function over plain objects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'Timeline.jsx'), 'utf8');

const start = src.indexOf('function buildThreads(list) {');
assert.notEqual(start, -1, 'buildThreads is gone from Timeline.jsx — no email row would offer its thread');

// Brace-match rather than regex: a regex for a balanced body is how an
// 85-line orphaned function body got left behind in this repo once.
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
assert.notEqual(end, -1, 'could not brace-match buildThreads');
const buildThreads = new Function(`${src.slice(start, end)}; return buildThreads;`)();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const E = (id, threadId, ts) => ({ id, channel: 'EMAIL', threadId, ts });

console.log('buildThreads — which emails fold into a thread');

t('two emails sharing a threadId form a thread', () => {
  const m = buildThreads([E(1, 't1', '2026-09-04T12:10:00Z'), E(2, 't1', '2026-09-04T11:44:00Z')]);
  assert.equal(m.size, 1);
  assert.equal(m.get('t1').length, 2);
});

t('a lone email is NOT a thread', () => {
  // "1 in thread" would open a dialog showing exactly what the row shows.
  assert.equal(buildThreads([E(1, 't1', 'x')]).size, 0);
});

t('two separate threads stay separate', () => {
  const m = buildThreads([E(1, 'a', 'w'), E(2, 'a', 'x'), E(3, 'b', 'y'), E(4, 'b', 'z')]);
  assert.equal(m.size, 2);
  assert.equal(m.get('a').length, 2);
  assert.equal(m.get('b').length, 2);
});

t('an email with no threadId is excluded', () => {
  // Older syncs and non-threading providers. These render as plain rows.
  assert.equal(buildThreads([E(1, null, 'x'), E(2, null, 'y')]).size, 0);
  assert.equal(buildThreads([E(1, undefined, 'x'), E(2, undefined, 'y')]).size, 0);
});

t('non-email channels never thread', () => {
  // SMS carries no threadId today. If one ever did, grouping it here would
  // put an SMS inside a dialog that renders every message as an email.
  assert.equal(buildThreads([
    { id: 1, channel: 'SMS', threadId: 't1', ts: 'x' },
    { id: 2, channel: 'SMS', threadId: 't1', ts: 'y' }
  ]).size, 0);
});

t('mixed channels on one threadId keep only the emails', () => {
  const arr = buildThreads([
    E(1, 't1', 'x'), E(2, 't1', 'y'),
    { id: 3, channel: 'SMS', threadId: 't1', ts: 'z' }
  ]).get('t1');
  assert.equal(arr.length, 2);
  assert.ok(arr.every((x) => x.channel === 'EMAIL'));
});

t('notes and tasks in the merged timeline are ignored', () => {
  const list = [E(1, 't1', 'x'), E(2, 't1', 'y'), { id: 9, kind: 'note', ts: 'z' }];
  assert.equal(buildThreads(list).get('t1').length, 2);
});

t('an empty timeline yields no threads', () => {
  assert.equal(buildThreads([]).size, 0);
});

t('a three-message thread keeps all three', () => {
  assert.equal(buildThreads([E(1, 't', 'a'), E(2, 't', 'b'), E(3, 't', 'c')]).get('t').length, 3);
});

t('the input list is not mutated', () => {
  // Timeline passes its live `messages` array; reordering it in place would
  // scramble the rendered order.
  const list = [E(1, 't', 'a'), E(2, 't', 'b')];
  const copy = JSON.parse(JSON.stringify(list));
  buildThreads(list);
  assert.deepEqual(list, copy);
});

// ── The dialog's ordering and initial expansion ─────────────────────────
//
// Mirrors EmailThreadModal. Kept in step by asserting the source still
// contains both rules, below.
console.log('\nthread dialog — ordering and what opens');

const orderOf = (msgs) => [...msgs].sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
const initialOpen = (msgs, initialId) => {
  const ordered = orderOf(msgs);
  const newest = ordered[ordered.length - 1];
  const ids = new Set();
  if (newest) ids.add(newest.id);
  if (initialId) ids.add(initialId);
  return ids;
};

// The timeline hands these over NEWEST FIRST (ORDER BY message_timestamp DESC).
const T = [E(2, 't', '2026-09-04T12:10:00Z'), E(1, 't', '2026-09-04T11:44:00Z')];

t('sorted oldest-first, because a conversation reads top-down', () => {
  assert.deepEqual(orderOf(T).map((x) => x.id), [1, 2]);
});

t('clicking the newest opens only it', () => {
  assert.deepEqual([...initialOpen(T, 2)], [2]);
});

t('clicking an OLDER message opens that one too', () => {
  // The edge that matters: landing on a dialog that expanded only 12:10 when
  // you clicked 11:44 loses the message the click was about.
  const open = initialOpen(T, 1);
  assert.ok(open.has(1), 'the clicked message must be open');
  assert.ok(open.has(2), 'the newest must also be open');
});

t('with no clicked id, the newest still opens', () => {
  assert.deepEqual([...initialOpen(T, null)], [2]);
});

t('a thread with no timestamps does not crash or lose messages', () => {
  const msgs = [E(1, 't', null), E(2, 't', null)];
  assert.equal(orderOf(msgs).length, 2);
  assert.equal(initialOpen(msgs, null).size, 1);
});

// ── The dialog source must still implement those rules ──────────────────
const modal = readFileSync(join(here, '..', 'EmailThreadModal.jsx'), 'utf8');

t('the dialog still sorts oldest-first', () => {
  assert.match(modal, /sort\(\(a, b\) => new Date\(a\.ts \|\| 0\) - new Date\(b\.ts \|\| 0\)\)/,
    'EmailThreadModal no longer sorts oldest-first — the thread would read newest-down');
});

t('the dialog still opens the newest AND the clicked message', () => {
  assert.match(modal, /if \(newest\) ids\.add\(newest\.id\)/, 'the newest is no longer opened');
  assert.match(modal, /if \(initialId\) ids\.add\(initialId\)/, 'the clicked message is no longer opened');
});

t('the dialog offers no reply or forward control', () => {
  // The explicit request: display only. A future edit adding one should fail
  // here rather than ship silently.
  assert.ok(!/>\s*(Reply|Forward)\s*</.test(modal),
    'a reply/forward control appeared in EmailThreadModal — this view is display-only');
});

console.log(`\n${n} passed`);
