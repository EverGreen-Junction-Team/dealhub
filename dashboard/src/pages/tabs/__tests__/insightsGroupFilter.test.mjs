// The Insights tab's section filter.
//
// Reported: the group headings ("Pipeline Leakage", "Scaling & Rep
// Performance", …) had no way to narrow the page, and the whole tab looked
// unlike the other eight — a bare <h1> instead of the Panel every other tab
// uses, plain-text headings instead of a control. The filter is now a
// multi-select, and it must default to showing EVERY section until someone
// deliberately narrows it.
//
// Mirrored from InsightsTab rather than imported: the component renders
// through Panel/antd, which needs a DOM. The grouping and filtering logic
// underneath it is plain data, so it is tested as that.

import assert from 'node:assert/strict';

const CARDS = [
  { card_id: '1.1', group_number: 1, group_name: 'Pipeline Leakage' },
  { card_id: '1.4', group_number: 1, group_name: 'Pipeline Leakage' },
  { card_id: '2.1', group_number: 2, group_name: 'Scaling & Rep Performance' },
  { card_id: '8.1', group_number: 8, group_name: 'Sales Discipline' },
];

function groupDefsFor(cards) {
  const by = new Map();
  for (const c of cards) {
    if (!by.has(c.group_number)) by.set(c.group_number, { number: c.group_number, name: c.group_name });
  }
  return [...by.values()].sort((a, b) => a.number - b.number);
}

// Mirrors InsightsTab's `selected` derivation: undefined (never touched the
// control) expands to every group; anything else, including [], is taken as
// a real, deliberate choice.
function selectedFor(storedValue, groupDefs) {
  return storedValue === undefined ? groupDefs.map((g) => g.number) : storedValue;
}

function groupsFor(cards, selected) {
  const by = new Map();
  for (const c of cards) {
    if (!selected.includes(c.group_number)) continue;
    if (!by.has(c.group_number)) by.set(c.group_number, { number: c.group_number, name: c.group_name, cards: [] });
    by.get(c.group_number).cards.push(c);
  }
  return [...by.values()].sort((a, b) => a.number - b.number);
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('insights section filter');

t('untouched, every group is selected', () => {
  const defs = groupDefsFor(CARDS);
  const selected = selectedFor(undefined, defs);
  assert.deepEqual(selected.sort(), [1, 2, 8]);
});

t('untouched, every card from every group renders', () => {
  const defs = groupDefsFor(CARDS);
  const selected = selectedFor(undefined, defs);
  const groups = groupsFor(CARDS, selected);
  const shown = groups.reduce((n2, g) => n2 + g.cards.length, 0);
  assert.equal(shown, CARDS.length);
  assert.equal(groups.length, 3);
});

t('narrowing to one group hides the others', () => {
  const groups = groupsFor(CARDS, [1]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Pipeline Leakage');
  assert.equal(groups[0].cards.length, 2);
});

t('a deliberate empty selection is NOT the same as "never touched"', () => {
  // [] clears every group on purpose. undefined means the dropdown was never
  // opened. Both have to reach the empty-state message, but for different
  // reasons, and a stored [] must not silently re-expand to "all" on the
  // next visit the way undefined does.
  const defs = groupDefsFor(CARDS);
  assert.deepEqual(selectedFor([], defs), []);
  assert.deepEqual(selectedFor(undefined, defs), [1, 2, 8]);
  assert.equal(groupsFor(CARDS, selectedFor([], defs)).length, 0);
});

t('groups are ordered by group number, not first appearance', () => {
  const shuffled = [CARDS[3], CARDS[0], CARDS[2], CARDS[1]];
  const groups = groupsFor(shuffled, [1, 2, 8]);
  assert.deepEqual(groups.map((g) => g.number), [1, 2, 8]);
});

// ── What the control SAYS when everything is picked ──────────────────
// With all eight sections selected, antd collapsed them into a bare "+8"
// chip — a number naming none of them, describing the state the page starts
// in anyway. "All" says the same thing in words — just "All" and not
// "All sections", because the field's own "Section" label sits beside it.
//
// Mirrors the maxTagCount / maxTagPlaceholder pair in InsightsTab.

function tagDisplay(selected, groupDefs) {
  const allSelected = groupDefs.length > 0 && selected.length === groupDefs.length;
  return {
    // 0 hides every chip so only the rest-placeholder shows; 'responsive'
    // keeps the chips and collapses only what overflows.
    maxTagCount: allSelected ? 0 : 'responsive',
    restLabel: (omittedCount) => (allSelected ? 'All' : `+${omittedCount}`),
  };
}

t('all sections selected reads "All", not "+8"', () => {
  const defs = groupDefsFor(CARDS);
  const d = tagDisplay(selectedFor(undefined, defs), defs);
  assert.equal(d.maxTagCount, 0);
  assert.equal(d.restLabel(defs.length), 'All');
});

t('a narrowed selection keeps its chips', () => {
  // The chips ARE the useful thing here — they name which sections you are
  // looking at. Only genuine overflow should collapse.
  const defs = groupDefsFor(CARDS);
  const d = tagDisplay([1], defs);
  assert.equal(d.maxTagCount, 'responsive');
  assert.equal(d.restLabel(2), '+2');
});

t('clearing every section is not mistaken for "all"', () => {
  // [] and "all of them" are opposite states and must not share a label.
  const defs = groupDefsFor(CARDS);
  const d = tagDisplay([], defs);
  assert.equal(d.maxTagCount, 'responsive');
});

console.log(`\n${n} passed`);
