// A portalled surface that uses .ms icons MUST carry .pp-portal.
//
// The Material Symbols rule is scoped to [data-dealhub]. createPortal attaches
// to <body>, outside that ancestor, so the rule never matches and every icon
// renders as its raw ligature — the deal-move popover showed "link_off" as
// eight characters of text.
//
// It fails quietly and only in the portal: the same component's non-portalled
// icons render correctly, so it reads as a styling slip rather than a scope
// problem. Worth pinning.
//
// Run: node src/pages/__tests__/portalIcons.test.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, '..');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : walk(p);
    return f.endsWith('.jsx') ? [p] : [];
  });
}

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const portalled = walk(pages).filter((f) =>
  readFileSync(f, 'utf8').includes('createPortal(')
);

t('found the portalled components', portalled.length >= 2);

for (const f of portalled) {
  const src = readFileSync(f, 'utf8');
  const name = f.split('/').pop();
  // Only matters when the portal actually renders icons.
  if (!src.includes('className="ms"')) continue;
  t(`${name} marks its portal with pp-portal`,
    src.includes('className="pp-portal"'));
}

// The stylesheet must actually carry the escape hatch.
const css = readFileSync(join(here, '../../styles/dealhub-tokens.css'), 'utf8');

t('the icon rule covers portalled content',
  /\[data-dealhub\] \.ms,\s*\n\.pp-portal \.ms \{/.test(css));

t('and so does the filled variant',
  /\.pp-portal \.ms\.ms-fill/.test(css));

// The icon rule was only half the problem: every design TOKEN is declared on
// the same [data-dealhub] selector, so a portal resolved none of them —
// var(--gray-50), var(--text-muted), var(--radius-lg) all fell back. The card
// still rendered, which is why it looked merely ugly rather than broken.
t('design tokens are declared for portals too',
  /\[data-dealhub\],\s*\n\.pp-portal \{/.test(css));

t('and the token block still covers the dealhub subtree',
  // Same trap as the icon rule: this must ADD a selector, not replace one.
  /\[data-dealhub\],\s*\n\.pp-portal \{[\s\S]{0,400}--gray-25:/.test(css));

t('the dealhub scope is still there',
  // The fix ADDS a selector; it must not have replaced the original, or
  // every icon outside a portal breaks instead.
  css.includes('[data-dealhub] .ms'));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
