// Which attachments get previewed, and how the viewer is wired.
//
// WHY THIS MATTERS. Attachment clicks were dead: `onJumpAttachment` was
// threaded through MessageRow and EmailBody but DealHubTab never passed it,
// so every chip in the timeline did nothing. The viewer is now the default,
// which means the type detection decides what a rep sees — and getting it
// wrong shows a blank frame instead of a usable file card.
//
// Type is decided by EXTENSION, because it has to be: the GHL email endpoint
// returns `attachments: string[]` — bare URLs with no MIME type.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'AttachmentViewer.jsx'), 'utf8');

const start = src.indexOf('function kindOf(att) {');
assert.notEqual(start, -1, 'kindOf is gone from AttachmentViewer.jsx');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const kindOf = new Function(`${src.slice(start, end)}; return kindOf;`)();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('kindOf — what can actually be previewed');

t('images preview as images', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg']) {
    assert.equal(kindOf({ name: `photo.${ext}` }), 'image', ext);
  }
});

t('pdf previews in a frame', () => {
  assert.equal(kindOf({ name: 'quote-v3.pdf' }), 'pdf');
});

t('everything else falls back to the card', () => {
  // These have no in-browser renderer: an iframe pointed at one either
  // downloads it or shows an empty box.
  for (const ext of ['dwg', 'xlsx', 'csv', 'docx', 'zip', 'txt', 'eml', 'pptx']) {
    assert.equal(kindOf({ name: `file.${ext}` }), 'file', ext);
  }
});

t('case is ignored — GHL urls are not consistent', () => {
  assert.equal(kindOf({ name: 'PHOTO.PNG' }), 'image');
  assert.equal(kindOf({ name: 'Quote.PDF' }), 'pdf');
});

t('a signed url is classified on the path, not the query', () => {
  // ?sig=...&exp=... must not make a pdf look extensionless.
  assert.equal(kindOf({ name: 'quote.pdf?sig=abc&exp=999' }), 'pdf');
  assert.equal(kindOf({ url: 'https://x/y/photo.png?sig=abc' }), 'image');
});

t('falls back to the url when there is no name', () => {
  // The email endpoint gives urls only, so this is the common case.
  assert.equal(kindOf({ url: 'https://msgsndr.example/f/a/report.pdf' }), 'pdf');
});

t('no extension means the card, not a blank frame', () => {
  // Better a usable card for a previewable file than an empty box.
  assert.equal(kindOf({ url: 'https://x/y/download' }), 'file');
  assert.equal(kindOf({ name: 'attachment' }), 'file');
});

t('never throws on junk', () => {
  for (const v of [null, undefined, {}, { name: null }, { name: 42 }, { url: {} }]) {
    assert.doesNotThrow(() => kindOf(v), JSON.stringify(v));
    assert.equal(kindOf(v), 'file');
  }
});

// ── The wiring that makes clicks live ───────────────────────────────────
console.log('\nwiring');

const timeline = readFileSync(join(here, '..', 'Timeline.jsx'), 'utf8');
// EmailBody was extracted out of Timeline.jsx so the contact record could
// render the SAME email card instead of a plainer copy. The assertions below
// about the card's own markup follow it there; the ones about wiring
// (AttachmentViewer, openAttachment) stay with Timeline.
const emailBody = readFileSync(join(here, '..', 'EmailBody.jsx'), 'utf8');
const thread = readFileSync(join(here, '..', 'EmailThreadModal.jsx'), 'utf8');

t('Timeline mounts the viewer', () => {
  assert.match(timeline, /<AttachmentViewer/);
  assert.match(timeline, /const openAttachment = \(list, idx\) =>/,
    'the click resolver is gone — chips would be dead again');
});

t('onJumpAttachment is optional, so chips work with no parent handler', () => {
  // The original bug: DealHubTab renders <Timeline> without it.
  assert.match(timeline, /onJumpAttachment = null/,
    'onJumpAttachment must default, or an unpassed handler kills every chip');
});

t('the thread dialog previews instead of opening a tab', () => {
  assert.match(thread, /<AttachmentViewer/);
  assert.ok(!/window\.open\(att\.url/.test(thread),
    'window.open is back — clicking a file would leave the thread');
});

t('the viewer sits above the thread dialog', () => {
  // The thread dialog is z-index 60 and this opens from it.
  assert.match(src, /zIndex: 65/);
});

t('external links carry noopener, and the pdf frame is sandboxed', () => {
  // A rendered document from someone else's host, inside our origin.
  assert.equal((src.match(/rel="noopener noreferrer"/g) || []).length, 2);
  assert.match(src, /sandbox=""/);
});

t('a failed preview falls back rather than showing a blank frame', () => {
  // An expired signed url, a deleted file, a wrong extension.
  assert.match(src, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(src, /const kind = failed \? 'file' : kindOf\(att\)/);
});

// ── An email with no body must still render ────────────────────────────
//
// GHL sends `<div></div>` as the body when someone sends only an attachment.
// The timeline gated the whole email card on `m.channel === 'EMAIL' && m.body`
// — and `<div></div>` is truthy, so it passed that check but then produced an
// empty RichBody; worse, an email whose body was genuinely absent fell through
// to the plain branch (which also requires a body) and rendered NOTHING: a
// bare "Us · Out · Email" header with no subject, no attachment, no thread
// chip, while GHL displayed the image perfectly.
console.log('\nan email with no body');

t('the card is gated on the CHANNEL, not the body', () => {
  assert.match(timeline, /\{m\.channel === 'EMAIL' \? \(/,
    'the email card must render for every email — subject, addresses, '
    + 'attachments and the thread link are each worth showing without a body');
  assert.ok(!/m\.channel === 'EMAIL' && m\.body \? \(/.test(timeline),
    'the body gate is back — an attachment-only email renders nothing');
});

t('an empty body does not render an empty block', () => {
  // `preview` is the body run through htmlToText, so it is the honest test of
  // "is there any text": RichBody's own `if (!html)` does not catch
  // "<div></div>", which is truthy.
  assert.match(emailBody, /\{preview \? \(\s*<(RichBody|EmailFrame)/,
    'The body (RichBody or EmailFrame) must be gated on preview, not on m.body');
});

t('no body and no files says so, rather than showing a blank card', () => {
  assert.match(emailBody, /pp-email-nobody/);
});

t('the attachment block drops its rule when there is no body', () => {
  // Without this the From/To block's rule and the attachment block's rule sit
  // one under the other, reading as an empty row where the body should be.
  assert.match(emailBody, /pp-email-atts pp-email-atts-first/);
});

console.log(`\n${n} passed`);
