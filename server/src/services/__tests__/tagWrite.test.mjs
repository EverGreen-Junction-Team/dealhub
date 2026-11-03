// Tests for tagPatch.js — the validation and normalisation behind the contact
// tag endpoints. Dependency-free, like the module under test.
//
// The two functions that actually call GHL live in ghlTagWrite.js and need the
// network; the integration check covers those.

import { buildTagList, normaliseTag, TagWriteError } from '../tagPatch.js';

let passed = 0, failed = 0;

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n        got  ${g}\n        want ${w}`); }
};

const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

function throwsWith(name, fn, { field = undefined, match = undefined } = {}) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${name}\n        expected a throw, got none`);
  } catch (err) {
    if (!(err instanceof TagWriteError)) {
      failed++;
      console.log(`FAIL  ${name}\n        threw ${err.name}, not TagWriteError`);
      return;
    }
    if (field !== undefined && err.field !== field) {
      failed++;
      console.log(`FAIL  ${name}\n        field ${err.field}, expected ${field}`);
      return;
    }
    if (match && !err.message.toLowerCase().includes(match.toLowerCase())) {
      failed++;
      console.log(`FAIL  ${name}\n        "${err.message}" lacks "${match}"`);
      return;
    }
    passed++;
    console.log(`  ok  ${name}`);
  }
}

console.log('\n--- normalisation: lowercase and trim, BOTH directions ---');

// GHL lowercases and trims on ADD but only lowercases on REMOVE. That
// asymmetry means ' VIP ' would add as 'vip' and then fail to remove. We
// normalise identically on both sides so add/remove are symmetric.
eq('lowercased', normaliseTag('VIP'), 'vip');
eq('trimmed', normaliseTag('  vip  '), 'vip');
eq('both at once', normaliseTag('  VIP  '), 'vip');
eq('mixed case inner text', normaliseTag('Hot Lead'), 'hot lead');
eq('namespaced tags keep their colon', normaliseTag('Quote:Email'), 'quote:email');
eq('whitespace-only is nothing', normaliseTag('   '), null);
eq('empty is nothing', normaliseTag(''), null);
eq('a non-string is nothing', normaliseTag(42), null);
eq('null is nothing', normaliseTag(null), null);

console.log('\n--- buildTagList: shape ---');

eq('a plain array', buildTagList(['vip']), ['vip']);
eq('the { tags } body shape', buildTagList({ tags: ['vip'] }), ['vip']);
eq('several tags', buildTagList({ tags: ['vip', 'newsletter'] }), ['vip', 'newsletter']);
eq('normalised on the way through',
  buildTagList({ tags: ['  VIP ', 'Newsletter'] }), ['vip', 'newsletter']);

// Same tag twice is harmless, so dedupe quietly rather than erroring.
eq('duplicates collapse', buildTagList({ tags: ['vip', 'vip'] }), ['vip']);
eq('duplicates after normalising also collapse',
  buildTagList({ tags: ['VIP', ' vip '] }), ['vip']);
eq('order is preserved', buildTagList({ tags: ['b', 'a', 'c'] }), ['b', 'a', 'c']);

console.log('\n--- buildTagList: rejections ---');

throwsWith('an empty list', () => buildTagList({ tags: [] }), { field: 'tags' });
throwsWith('a missing tags key', () => buildTagList({}), { field: 'tags' });
throwsWith('null', () => buildTagList(null), { field: 'tags' });
throwsWith('a bare string is not a list', () => buildTagList('vip'), { field: 'tags' });

// A request naming four tags that applies two is worse than one that fails and
// says which was wrong.
throwsWith('a blank entry fails the whole call',
  () => buildTagList({ tags: ['vip', '   '] }), { field: 'tags', match: 'cannot be blank' });
throwsWith('a non-string entry fails the whole call',
  () => buildTagList({ tags: ['vip', 7] }), { field: 'tags', match: 'must be text' });
throwsWith('a null entry fails the whole call',
  () => buildTagList({ tags: ['vip', null] }), { field: 'tags' });

throwsWith('an over-long tag',
  () => buildTagList({ tags: ['a'.repeat(101)] }), { field: 'tags', match: '100 characters' });
ok('a tag at the limit is fine',
  buildTagList({ tags: ['a'.repeat(100)] })[0].length === 100);

throwsWith('too many at once',
  () => buildTagList({ tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }),
  { field: 'tags', match: 'too many' });
ok('fifty is allowed',
  buildTagList({ tags: Array.from({ length: 50 }, (_, i) => `t${i}`) }).length === 50);

console.log('\n--- the verb reaches the message ---');

// "Which tags do you want to remove?" beats a generic "tags required" — the
// rep sees it in the context of the button they pressed.
throwsWith('add wording', () => buildTagList({ tags: [] }, { verb: 'add' }), { match: 'add' });
throwsWith('remove wording', () => buildTagList({ tags: [] }, { verb: 'remove' }), { match: 'remove' });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
