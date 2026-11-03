// Text that is cut off must say so on hover.
//
// ── THE GAP ──────────────────────────────────────────────────────────
//
// 73 places truncated text with a hand-written ellipsis and 64 had no
// tooltip, so a clipped deal name, email or business was unreadable: on
// screen, cut off, with no way to see the rest short of opening the record.
//
// Truncate does both halves, and shows the tooltip ONLY when the text has
// actually been cut — a title on text you can already read is noise, and it
// suppresses the browser's own tooltips elsewhere.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('the tooltip only fires on text that is actually clipped', () => {
  const chrome = read('../ListChrome.jsx');
  const comp = chrome.slice(chrome.indexOf('export function Truncate'), chrome.indexOf('// ── Chips'));
  assert.match(comp, /scrollWidth > el\.clientWidth/, 'clipping is not measured');
  assert.match(comp, /title=\{clipped \? full : undefined\}/, 'the tooltip is unconditional');
  // Sub-pixel rounding makes scrollWidth exceed clientWidth by a fraction on
  // text that visually fits; without the guard every line gets a tooltip.
  assert.match(comp, /clientWidth \+ 1/, 'no guard against sub-pixel rounding');
});

t('it re-measures when the box resizes', () => {
  // A column dragged narrower clips text that fitted a moment ago. A one-shot
  // measurement on mount would never notice.
  const chrome = read('../ListChrome.jsx');
  const comp = chrome.slice(chrome.indexOf('export function Truncate'), chrome.indexOf('// ── Chips'));
  assert.match(comp, /ResizeObserver/, 'clipping is measured once and never again');
  assert.match(comp, /ro\.disconnect\(\)/, 'the observer is never cleaned up');
});

t('a non-string child gets no tooltip', () => {
  // title={<JSX/>} renders as "[object Object]" — worse than no tooltip.
  const chrome = read('../ListChrome.jsx');
  const comp = chrome.slice(chrome.indexOf('export function Truncate'), chrome.indexOf('// ── Chips'));
  assert.match(comp, /typeof children === 'string'/, 'any child is used as tooltip text');
});

t('every file using Truncate imports it', () => {
  // The build does NOT catch an undefined JSX component — it compiles and
  // then throws at render. This is the only thing standing between a missing
  // import and a blank page.
  // Test files are excluded: this one quotes "<Truncate>" in its own
  // assertions and would otherwise flag itself.
  const files = execSync('grep -rl "<Truncate" src/ | grep -v node_modules | grep -v __tests__', {cwd: root, encoding:'utf8'})
    .trim().split('\n').filter(Boolean);
  assert.ok(files.length > 20, `expected the rollout across many files, found ${files.length}`);
  for (const f of files) {
    if (f.endsWith('shared/ListChrome.jsx')) continue;
    const src = readFileSync(join(root, f), 'utf8');
    assert.match(
      src, /import \{[^}]*\bTruncate\b[^}]*\} from '[^']*ListChrome'/,
      `${f} renders <Truncate> without importing it — blank page at runtime`
    );
  }
});

t('no hand-rolled truncation was left behind in the converted files', () => {
  // A <span> still doing the ellipsis by hand is a line that can still be
  // unreadable. Some remain deliberately (multi-line clamps, inputs), so this
  // pins the COUNT rather than demanding zero.
  const n = Number(execSync('grep -rn "textOverflow" src/ | grep -v node_modules | wc -l', {cwd: root, encoding:'utf8'}).trim());
  assert.ok(n <= 25, `${n} hand-written truncations remain, expected the bulk to be converted`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
