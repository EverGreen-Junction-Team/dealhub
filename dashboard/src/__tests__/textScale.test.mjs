// The text size setting reaches the whole app.
//
// Run: node --test src/__tests__/textScale.test.mjs
//
// ── THE BUG THIS PINS ────────────────────────────────────────────────
//
// The setting shipped looking complete and moved almost nothing. Two
// separate halves of the app were missed, and both failed silently:
//
//   1. index.css re-declared the type scale on `.pp-portal` only.
//      dealhub-tokens.css declares it on `[data-dealhub], .pp-portal` —
//      the app tree carries the attribute, portalled overlays carry the
//      class. So the override matched open dropdowns and nothing else.
//
//   2. antd resolves its sizing in JS and never reads a CSS variable, so
//      no amount of token work reaches a Select, Input, Button or Table.
//
// Both are invisible in a code read and neither throws. The symptom in
// each case is a slider that appears not to work — the zoom slider beside
// it works perfectly, which makes it look like the feature was half built.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexCss = readFileSync(join(src, 'index.css'), 'utf8');
const tokensCss = readFileSync(join(src, 'styles/dealhub-tokens.css'), 'utf8');

// The block in index.css that re-points the type scale at the setting.
const scaleBlock = indexCss.slice(indexCss.indexOf('--app-text-scale: 1'));

test('the scale block targets the app tree, not just portals', () => {
  // THE ACTUAL BUG. Without [data-dealhub] the setting moves the text
  // inside an open dropdown and nowhere else.
  const rule = scaleBlock.slice(
    scaleBlock.indexOf('--text-xs: calc') - 200,
    scaleBlock.indexOf('--text-xs: calc')
  );
  assert.match(rule, /\[data-dealhub\]/, 'the app tree must be in the selector');
  assert.match(rule, /\.pp-portal/, 'portalled overlays must be too');
});

test('every size in the scale follows the setting', () => {
  // One token left as a literal is one part of the app that stops
  // responding, and the gap shows as mismatched type on the same screen.
  for (const name of [
    '--text-xs', '--text-sm', '--text-base', '--text-md',
    '--text-lg', '--text-xl', '--text-2xl', '--text-3xl', '--text-display'
  ]) {
    assert.match(
      scaleBlock,
      new RegExp(`${name}: calc\\([0-9.]+px \\* var\\(--app-text-scale\\)\\)`),
      `${name} must be scaled`
    );
  }
});

test('the scaled values match what the tokens file declares', () => {
  // At scale 1 this block must change nothing. If a base number here drifts
  // from the tokens file, the app silently resizes the day the override
  // loads — and the tokens file looks innocent.
  const bases = [...scaleBlock.matchAll(
    /(--text-[a-z0-9]+): calc\(([0-9.]+)px \* var\(--app-text-scale\)\)/g
  )];
  assert.ok(bases.length >= 9, 'expected the whole scale');

  for (const [, name, px] of bases) {
    const declared = tokensCss.match(
      new RegExp(`\\[data-dealhub\\][\\s\\S]*?${name}: (\\d+)px`)
    );
    assert.ok(declared, `${name} not found in the tokens file`);
    assert.equal(
      px, declared[1],
      `${name} is ${px}px here and ${declared[1]}px in dealhub-tokens.css`
    );
  }
});

test('the override is declared after the tokens it overrides', () => {
  // Equal specificity, so source order decides. The @import has to come
  // first for the later block to win.
  const imported = indexCss.indexOf("@import './styles/dealhub-tokens.css'");
  assert.ok(imported >= 0, 'the tokens are imported here');
  assert.ok(
    imported < indexCss.indexOf('--text-xs: calc'),
    'the override must come after the import'
  );
});

// ── The antd half ─────────────────────────────────────────────────────

test('antd is scaled too, because it cannot read the CSS tokens', async () => {
  const { scaledTheme, BASE_THEME } = await import('../theme.js');
  const big = scaledTheme(1.2);
  assert.ok(
    big.token.fontSize > BASE_THEME.token.fontSize,
    'antd text must grow with the setting or half the screen ignores it'
  );
});

test('control heights grow with the text inside them', () => {
  // Otherwise bigger text clips inside a box pinned at 36px, and "larger
  // text" produces cut-off inputs.
  return import('../theme.js').then(({ scaledTheme, BASE_THEME }) => {
    const big = scaledTheme(1.3);
    assert.ok(big.token.controlHeight > BASE_THEME.token.controlHeight);
  });
});

test('antd sizes stay whole pixels', async () => {
  // antd derives fontSizeLG, fontSizeSM and its line heights from these.
  // A fractional base pushes fractions through the entire derived scale.
  const { scaledTheme } = await import('../theme.js');
  for (const s of [0.85, 0.9, 1.05, 1.15, 1.2, 1.3]) {
    const t = scaledTheme(s);
    assert.equal(t.token.fontSize, Math.round(t.token.fontSize), `fontSize at ${s}`);
    assert.equal(t.token.controlHeight, Math.round(t.token.controlHeight), `height at ${s}`);
  }
});

test('scale 1 returns the base theme untouched', async () => {
  const { scaledTheme, BASE_THEME } = await import('../theme.js');
  assert.equal(scaledTheme(1), BASE_THEME);
  assert.equal(scaledTheme(), BASE_THEME);
});

test('nonsense falls back to the base theme rather than collapsing it', async () => {
  // A 0 here would resolve to fontSize 0 — an app with no visible text and
  // no readable way back to the setting that did it.
  const { scaledTheme, BASE_THEME } = await import('../theme.js');
  for (const bad of [0, -1, NaN, undefined, null, 'big']) {
    assert.equal(scaledTheme(bad), BASE_THEME, `${String(bad)} must be ignored`);
  }
});
