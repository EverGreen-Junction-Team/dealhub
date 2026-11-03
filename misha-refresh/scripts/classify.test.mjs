// The question classifier's OUTPUT VOCABULARY must not drift.
//
// misha.question_theme_map already holds 575 classified labels, themed by
// these exact rules. The insight views group on the theme STRING, so a theme
// that is reworded — or a rule reordered such that labels land somewhere new
// — does not error. It silently splits one group into two, and the charts
// quietly stop agreeing with themselves.
//
// This pins the eleven strings classify() can return. It deliberately does
// NOT assert that any particular label maps to any particular theme: the
// rules are misha's, quirks included (\bphoto\b does not match "photos";
// "available" claims a colour question for the scheduling theme), and
// correcting them here would theme NEW labels differently from the 575
// already mapped — the exact drift this file exists to prevent.

import assert from 'node:assert/strict';
import { classify, RULES } from './question_theme_clusters.mjs';

// Every theme present in the migration 127 snapshot, verified against it.
const KNOWN_THEMES = new Set([
  'Price, cost & payment terms',
  'Photos & visual reference requests',
  'Lead time, scheduling & site visits',
  'Status update on quote or drawings',
  'Quote scope & inclusions clarification',
  'Colour, finish & material spec',
  'Dimensions, specs & drawings',
  'Product/system alternative or change',
  'Installation logistics & scope',
  'Company process & admin questions',
  'Other / uncategorized',
]);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('every rule yields a theme the stored map already knows', () => {
  for (const [, theme] of RULES) {
    assert.ok(
      KNOWN_THEMES.has(theme),
      `"${theme}" is not a theme in question_theme_map — it would start a new, ` +
      `parallel group alongside the 575 labels already classified`
    );
  }
});

t('the fallback is the stored "Other", not a new spelling of it', () => {
  // A label matching nothing must land in the SAME bucket the snapshot uses.
  // 'Other / uncategorized, needs review' is the REQUIREMENT fallback and
  // belongs to a different map — using it here would scatter questions into
  // a bucket no question view reads.
  const theme = classify('zzz nothing matches this at all zzz');
  assert.equal(theme, 'Other / uncategorized');
});

t('classify always returns one of the known themes', () => {
  const probes = [
    '', '   ', 'price', 'PRICE', 'colour', 'lead time from order',
    'asking about mm width', 'who is the contractor', 'thanks',
    '¿cuánto cuesta?', '12345', 'a'.repeat(500),
  ];
  for (const p of probes) {
    const theme = classify(p);
    assert.ok(KNOWN_THEMES.has(theme), `classify(${JSON.stringify(p.slice(0, 30))}) -> "${theme}"`);
  }
});

t('first match wins, and the order is load-bearing', () => {
  // Several rules match the same label; which one fires is decided by
  // position. Pinned so a reordering cannot pass unnoticed — it would
  // re-theme labels that are already mapped.
  assert.equal(RULES.length, 10);
  assert.equal(RULES[0][1], 'Price, cost & payment terms');
  assert.equal(RULES[RULES.length - 1][1], 'Company process & admin questions');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
