// Tasks and Notes: grey behind the list, white cards on top, in BOTH views.
//
// ── WHAT CHANGED ─────────────────────────────────────────────────────
//
// The cards were white on a white panel, so each card's own 1px border was
// doing the whole job of separating it from the page. And the two views were
// built differently: the grid drew cards, rows drew list items with a divider
// rule between them — so the same task looked like a card in one view and a
// table row in the other.
//
// Now: --gray-50 behind the list in both views, every item a card, and the
// gap between them does the separating that the rules used to.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const css = read('../../../styles/dealhub-tokens.css');

const TABS = [['Tasks', read('../TasksTab.jsx')], ['Notes', read('../NotesTab.jsx')]];

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('the list sits on grey, not white', () => {
  for (const [name, src] of TABS) {
    assert.match(
      src, /background: 'var\(--gray-50\)'/,
      `${name}: the list is still white on white, so each card's border does all the separating`
    );
  }
});

t('that grey is the one the design system defines', () => {
  // #F5F6F8. Pinned so the surface cannot drift to a hand-picked hex that
  // looks right on one screen.
  assert.match(css, /--gray-50:\s*#f5f6f8/i, '--gray-50 is no longer #f5f6f8');
});

t('an item is a card in BOTH views, not a card in one and a row in the other', () => {
  for (const [name, src] of TABS) {
    assert.match(src, /A CARD IN BOTH VIEWS/, `${name}: the card treatment is still view-dependent`);
    // The tell-tale of the old split: a border/radius applied only when
    // view === 'grid'.
    assert.ok(
      !/view === 'grid'\s*\n?\s*\?\s*\{\s*\n?\s*border: '1px solid var\(--border-default\)'/.test(src),
      `${name}: border and radius are still gated on the grid view`
    );
  }
});

t('no dividing rules are left between items', () => {
  for (const [name, src] of TABS) {
    assert.ok(
      !/borderBottom: hasChips \?|borderBottom: i === notes\.length/.test(src),
      `${name}: a divider rule survives — with a gap and a grey surface it says nothing new`
    );
  }
});

t('rows get the same gap as the grid', () => {
  // The request was explicitly "the same spacing as in grid view", so one
  // gap declaration serves both rather than each view setting its own.
  for (const [name, src] of TABS) {
    const at = src.indexOf("background: 'var(--gray-50)'");
    const block = src.slice(at, at + 420);
    assert.match(block, /gap: 'var\(--space-3\)'/, `${name}: the two views do not share a gap`);
    assert.match(block, /padding: 'var\(--space-3\)'/, `${name}: the grey has no padding to show through`);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
