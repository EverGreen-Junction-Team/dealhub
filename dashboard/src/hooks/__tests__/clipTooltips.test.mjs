// Every clipped line gets a tooltip — including the CSS-clipped ones.
//
// ── THE GAP ──────────────────────────────────────────────────────────
//
// The Truncate rollout converted spans that ellipsised through INLINE styles.
// A large part of the app does it through CSS classes instead — .pp-cc-value
// on every contact-card field, .pp-email-subject, .pp-thread-name and five
// more. Those clip correctly and had no tooltip at all, so a long address or
// deal name was cut off with no way to read the rest.
//
// There was no inline style to match on, so the rollout could not see them.
// This pass measures the rendered element instead.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const hook = read('../useClipTooltips.js');
const shell = read('../../pages/DealHubShell.jsx');
const css = read('../../styles/dealhub-tokens.css');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// The real reducer, lifted so the test exercises the rule rather than
// restating it.
function makeNode(cls, text, scrollWidth, clientWidth, title = '') {
  return {
    className: cls, textContent: text, scrollWidth, clientWidth, title,
    _a: {},
    hasAttribute(a) { return a in this._a },
    setAttribute(a, v) { this._a[a] = v },
    removeAttribute(a) { if (a === 'title') this.title = ''; delete this._a[a] }
  };
}
function apply(nodes) {
  global.document = { querySelectorAll: () => nodes };
  const src = hook
    .replace(/^import.*$/m, '')
    .replace(/export function/g, 'function')
    .replace(/export function useClipTooltips[\s\S]*$/, '');
  // eslint-disable-next-line no-eval
  eval(src + ';applyClipTooltips();');
}

t('a clipped line gets its own text as the tooltip', () => {
  const n = makeNode('pp-cc-value', 'Studio 115, Mare Street Studios, London', 400, 200);
  apply([n]);
  assert.equal(n.title, 'Studio 115, Mare Street Studios, London');
});

t('text that fits gets no tooltip', () => {
  // A title on something you can already read is noise, and it suppresses the
  // browser's own tooltips elsewhere.
  const n = makeNode('pp-cc-value', 'jessica williamson', 150, 200);
  apply([n]);
  assert.equal(n.title, '');
});

t("an author's own tooltip is never overwritten", () => {
  // A cell showing "3 days ago" may want the full date — which is not its
  // own text.
  const n = makeNode('pp-cc-value', '3 days ago', 400, 200, '2 Jul 2026');
  apply([n]);
  assert.equal(n.title, '2 Jul 2026');
});

t('a widened column loses the tooltip it no longer needs', () => {
  const n = makeNode('pp-cc-value', 'now fits', 150, 200, 'now fits');
  n.setAttribute('data-cliptitle', '');
  apply([n]);
  assert.equal(n.title, '', 'a stale tooltip survived the column widening');
});

t('every truncating CSS class is covered', () => {
  // The selector list and the stylesheet must not drift: a class that
  // ellipsises but is not listed here is a line with no tooltip again.
  const classes = [...css.matchAll(/\[data-dealhub\] \.([a-z-]+)\s*\{[^}]*text-overflow:\s*ellipsis/g)]
    .map((m) => m[1]);
  assert.ok(classes.length >= 8, `expected the ellipsising classes, found ${classes.length}`);

  // Read the SELECTOR list, not the whole file: the header comment names
  // several of these classes, so `hook.includes('.pp-thread-name')` matched
  // the prose and the test passed with the class removed from the selector.
  const list = hook.slice(hook.indexOf('const SELECTOR'), hook.indexOf('.join('));
  const covered = new Set([...list.matchAll(/'\.([a-z-]+)'/g)].map((m) => m[1]));

  for (const c of new Set(classes)) {
    assert.ok(covered.has(c), `.${c} ellipsises in CSS but is not in the tooltip selector`);
  }
});

t('the pass runs for the whole app, once', () => {
  assert.match(shell, /useClipTooltips\(\)/, 'the hook is not called');
  assert.match(shell, /import \{ useClipTooltips \}/, 'the hook is not imported');
});

t('the observer cannot retrigger on its own writes', () => {
  // The pass SETS title attributes. Observing attributes would make it fire
  // on its own output, forever.
  assert.ok(
    !/attributes:\s*true/.test(hook),
    'the observer watches attributes — it would loop on its own title writes'
  );
  assert.match(hook, /childList: true/);
  assert.match(hook, /requestAnimationFrame/, 'measuring in the same tick gives stale widths');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
