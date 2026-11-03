// sanitiseHtml — what a signature may keep, and what must never survive.
import assert from 'node:assert/strict';
import { sanitiseHtml as s } from '../sanitiseHtml.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`FAIL ${name}\n  ${e.message}`); }
};

// ── kept: what a signature is made of ────────────────────────────────
t('keeps table layout', () => assert.match(s('<table><tr><td>x</td></tr></table>'), /<table/));
t('keeps img with https src', () =>
  assert.match(s('<img src="https://a.com/l.png">'), /<img/));
t('keeps colour', () =>
  assert.match(s('<p style="color:#c95d2e">x</p>'), /color: #c95d2e/));
t('keeps line-height', () =>
  assert.match(s('<div style="line-height:1.5">x</div>'), /line-height/));
t('keeps border-collapse', () =>
  assert.match(s('<table style="border-collapse:collapse"></table>'), /border-collapse/));
t('keeps link colour', () =>
  assert.match(s('<a href="https://a.com" style="color:#111">x</a>'), /color: #111/));
t('keeps img sizing attrs', () =>
  assert.match(s('<img src="https://a.com/l.png" width="64" height="20">'), /width="64"/));

// ── dropped: the reasons this file exists ────────────────────────────
t('drops script with its content', () =>
  assert.doesNotMatch(s('<script>alert(1)</script>'), /alert/));
t('drops javascript: href', () =>
  assert.doesNotMatch(s('<a href="javascript:alert(1)">x</a>'), /javascript/i));
t('drops onclick', () =>
  assert.doesNotMatch(s('<p onclick="alert(1)">x</p>'), /onclick/i));
t('drops url() in style', () =>
  assert.doesNotMatch(s('<p style="background-color:url(http://e.com/t)">x</p>'), /url\(/i));
t('drops position (not in allow-list)', () =>
  assert.doesNotMatch(s('<div style="position:fixed">x</div>'), /position/));
t('drops display:none', () =>
  assert.doesNotMatch(s('<div style="display:none">x</div>'), /display/));
t('drops http img — removes the element, not just the src', () => {
  const out = s('<img src="http://e.com/pixel.gif">');
  assert.doesNotMatch(out, /<img/);
});
t('drops data: non-image', () =>
  assert.doesNotMatch(s('<img src="data:text/html;base64,PHNjcmlwdD4=">'), /<img/));
t('keeps data: image', () =>
  assert.match(s('<img src="data:image/png;base64,iVBORw0KGgo=">'), /<img/));
t('adds rel to target=_blank', () =>
  assert.match(s('<a href="https://a.com" target="_blank">x</a>'), /noopener/));
t('unwraps unknown tag but keeps its text', () => {
  const out = s('<marquee>J Srini</marquee>');
  assert.doesNotMatch(out, /marquee/);
  assert.match(out, /J Srini/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
