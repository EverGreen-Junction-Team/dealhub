// The email signature: what gets stored, and what never does.
//
// This HTML is written by a rep, stored, then put into an email that goes out
// over the company's own domain. The endpoint is reachable with curl, so the
// editor's client-side sanitiser protects the page and not the database —
// everything here is about the SERVER's copy.

import assert from 'node:assert/strict';
import { sanitiseHtml, isHtmlEmpty, ALLOWED_TAGS } from '../../utils/sanitiseHtml.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0;
const failures = [];
function t(name, cond) { if (cond) pass++; else failures.push(name); }

// ── what must never survive ──────────────────────────────────────────
t('a script tag is removed WITH its content',
  !/steal/.test(sanitiseHtml('<script>steal()</script><p>Hi</p>'))
  && sanitiseHtml('<script>steal()</script><p>Hi</p>').includes('Hi'));

t('an event handler attribute is stripped',
  !/onclick/i.test(sanitiseHtml('<p onclick="steal()">Hi</p>')));

t('a javascript: href is dropped but the text stays',
  !/javascript/i.test(sanitiseHtml('<a href="javascript:alert(1)">click</a>'))
  && sanitiseHtml('<a href="javascript:alert(1)">click</a>').includes('click'));

t('a data: href is dropped',
  !/data:/i.test(sanitiseHtml('<a href="data:text/html,<script>x</script>">x</a>')));

t('an image is dropped — a remote src in a signature is a tracking pixel',
  sanitiseHtml('<img src="http://track.me/p.gif">') === '');

t('an iframe is removed with its content',
  sanitiseHtml('<iframe src="http://evil"></iframe>') === '');

// ── what must survive ────────────────────────────────────────────────
t('ordinary formatting is kept',
  sanitiseHtml('<p>J <strong>Srini</strong></p>') === '<p>J <strong>Srini</strong></p>');

t('a real link is kept',
  sanitiseHtml('<a href="https://crittall.co.uk">site</a>').includes('href="https://crittall.co.uk"'));

t('a bare domain is upgraded rather than dropped',
  sanitiseHtml('<a href="crittall.co.uk">site</a>').includes('https://crittall.co.uk'));

t('mailto and tel survive — a signature is mostly contact details',
  sanitiseHtml('<a href="mailto:j@x.com">mail</a>').includes('mailto:')
  && sanitiseHtml('<a href="tel:+441210000000">call</a>').includes('tel:'));

// Pasting from Outlook is the common case, and it arrives wrapped in tables.
//
// Tables are now KEPT, not unwrapped. They were stripped to their text while
// the editor had no way to make one, so an Outlook paste collapsed into a
// single run of text. Now that the editor offers tables — a signature is
// routinely a two-column logo/details layout — unwrapping one would throw
// away the layout the rep built, and silently: it saves without complaint.
// The cell contents are still sanitised, so a <script> in a <td> dies as
// before; only the structure survives.
t('an Outlook table is kept, with its cells intact',
  sanitiseHtml('<table><tr><td>J Srini</td></tr></table>')
    === '<table><tbody><tr><td>J Srini</td></tr></tbody></table>');

t('a table is structure only — scripting inside a cell is still stripped',
  sanitiseHtml('<table><tr><td><script>x</script>ok</td></tr></table>')
    === '<table><tbody><tr><td>ok</td></tr></tbody></table>');

t('target=_blank gains rel=noopener',
  sanitiseHtml('<a href="https://x.com" target="_blank">x</a>').includes('noopener'));

// ── empty detection ──────────────────────────────────────────────────
// Matters because an empty signature must DELETE rather than store '<p></p>',
// which would append a blank line to every email forever.
t('an empty paragraph counts as empty', isHtmlEmpty('<p></p>'));
t('a lone break counts as empty', isHtmlEmpty('<p><br></p>'));
t('a non-breaking space counts as empty', isHtmlEmpty('<p>&nbsp;</p>'));
t('real text does not', !isHtmlEmpty('<p>J Srini</p>'));

// ── the two sanitisers must agree ────────────────────────────────────
{
  // The client offers controls; the server decides what is stored. If the
  // lists drift, the editor offers a button whose output the server strips —
  // and nothing says so.
  //
  // GUARDED: the dashboard is a separate repo and is not always checked out
  // beside the server. An unguarded read here crashes the whole suite on a
  // machine that only has the backend, which is how a deploy broke once.
  const clientPath = fileURLToPath(
    new URL('../../../../../pipelinePulse-dashboard/src/utils/sanitiseHtml.js', import.meta.url)
  );
  if (!existsSync(clientPath)) {
    console.log('  (dashboard not checked out — skipping the shared-allow-list check)');
  } else {
    const clientSrc = readFileSync(clientPath, 'utf8');
    const m = clientSrc.match(/const ALLOWED = new Set\(\[([\s\S]*?)\]\)/);
    const clientTags = new Set(
      [...(m?.[1] || '').matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1].toLowerCase())
    );
    const missingOnServer = [...clientTags].filter((tag) => !ALLOWED_TAGS.has(tag));
    t(`every tag the editor can produce is allowed server-side${
      missingOnServer.length ? ` — missing: ${missingOnServer.join(', ')}` : ''}`,
    missingOnServer.length === 0);
  }
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILED:', failures); process.exit(1); }
