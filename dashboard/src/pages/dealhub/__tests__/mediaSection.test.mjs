// The Media tab: every file on a deal, previewable in place.
//
// It already flattened attachments off the timeline messages, so the wiring
// was right. What was missing is what a rep actually needs from it:
//
//   1. IMAGES SHOWED A GENERIC GLYPH. Every tile rendered the same `image`
//      icon, so a grid of photos was indistinguishable — and which photo it
//      is is the one thing you are scanning for.
//   2. CLICKING JUMPED TO THE TIMELINE. Useful, but not what a click on a
//      thumbnail means: you want to see the file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'MediaSection.jsx'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// iconFor, mirrored from the source.
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
const extOf = (name) => (String(name || '').split('.').pop() || '').toLowerCase();
const iconFor = (f) => {
  if (f.isImage) return 'image';
  const ext = extOf(f.name);
  if (ext === 'pdf') return 'picture_as_pdf';
  if (ext === 'dwg' || ext === 'dxf') return 'architecture';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'table_chart';
  if (['doc', 'docx'].includes(ext)) return 'description';
  if (['zip', 'rar', '7z'].includes(ext)) return 'folder_zip';
  return 'attach_file';
};
const isImage = (name) => IMAGE_EXT.includes(extOf(name));

console.log('which files get a thumbnail');

t('images are recognised by extension', () => {
  for (const ext of IMAGE_EXT) assert.equal(isImage(`photo.${ext}`), true, ext);
});

t('a PDF gets the pdf icon, not a thumbnail', () => {
  assert.equal(isImage('quote.pdf'), false);
  assert.equal(iconFor({ name: 'quote.pdf' }), 'picture_as_pdf');
});

t('a drawing gets its own icon — this client sends dwg', () => {
  assert.equal(iconFor({ name: 'elevation.dwg' }), 'architecture');
});

t('an unnamed file still gets an icon, not a blank tile', () => {
  // SMS and WhatsApp media arrive with no filename at all.
  assert.equal(iconFor({ name: null }), 'attach_file');
  assert.equal(iconFor({}), 'attach_file');
});

console.log('\nthe tile');

t('an image renders a real <img>, not a glyph', () => {
  assert.match(src, /const showThumb = file\.isImage && file\.url && !broken/);
  assert.match(src, /<img\s*\n\s*src=\{file\.url\}/);
});

t('a failed thumbnail falls back to the icon', () => {
  // GHL's attachment URLs are signed and expire, so a broken image is a
  // normal state — and the browser's broken-image glyph looks like our bug.
  assert.match(src, /onError=\{\(\) => setBroken\(true\)\}/);
});

t('cover, not contain', () => {
  // At 76px a letterboxed photo is mostly grey; recognising it needs detail.
  assert.match(src, /objectFit: 'cover'/);
});

t('thumbnails load lazily', () => {
  // A deal with forty photos should not fetch forty images to render a tab
  // the reader may not scroll.
  assert.match(src, /loading="lazy"/);
});

console.log('\nwhat a click does');

t('the tile previews, using the SHARED viewer', () => {
  // The same component the timeline and the email thread use, so a file
  // opened here behaves as it does everywhere else.
  assert.match(src, /import AttachmentViewer from '\.\/AttachmentViewer'/);
  assert.match(src, /onOpen=\{\(\) => setViewing\(/);
});

t('only files WITH a url are given to the viewer', () => {
  // An email attachment synced before the fetch existed has no url, and the
  // viewer would open a blank frame on it.
  assert.match(src, /shown\.filter\(\(f\) => f\.url\)/);
});

t('the arrows page through the FILTERED list', () => {
  // Paging into files the Images/Files filter has hidden would surprise.
  assert.match(src, /attachments: withUrls, index: withUrls\.indexOf\(f\)/);
});

t('jumping to the timeline survives as a secondary action', () => {
  // It is the context the file arrived in — worth keeping, not worth being
  // the primary click.
  assert.match(src, /onJump\(\)/);
  assert.match(src, /e\.stopPropagation\(\)/,
    'without stopPropagation the tile would also open the preview');
});

t('the jump control is not a nested button', () => {
  // A button inside a button is invalid HTML and the inner click fires both.
  assert.match(src, /role="button"/);
  assert.match(src, /tabIndex=\{0\}/);
  assert.match(src, /onKeyDown=/, 'a role=button needs its own key handling');
});

// ── Reading the message a file came in ───────────────────────────────────
//
// The tile's second control JUMPED to the timeline. That works, but it closes
// the Media tab and loses your place in the grid — and when the question is
// "what was said around this file?", answering it in place is better than
// navigating away and back.
console.log('\nthe message context dialog');

t('the icon opens a dialog rather than navigating', () => {
  assert.match(src, /onJump=\{\(\) => setContext\(f\)\}/,
    'the icon navigates away again');
  assert.match(src, /<MessageContextDialog/);
});

t('the whole message is carried, not looked up by id', () => {
  // It is already in memory; a lookup would go stale the moment the timeline
  // refetched.
  assert.match(src, /message: m$/m);
});

t('an EMAIL body renders through RichBody, which sanitises', () => {
  // Email bodies are HTML — cleanEmail strips the head and inline styles but
  // keeps the tags. As text they would show literal <p> tags.
  assert.match(src, /isEmail \? \(\s*\n\s*<RichBody/);
});

t('SMS and WhatsApp keep their line breaks', () => {
  assert.match(src, /className="pp-mc-text"/);
});

t('a message with no text says so', () => {
  // An attachment-only send has an empty body; a blank dialog reads as a
  // loading failure.
  assert.match(src, /it was sent with the attachment only/);
});

t('the dialog names WHICH file brought you here', () => {
  // On a message with four attachments there would otherwise be no clue
  // which tile was clicked.
  assert.match(src, /className="pp-mc-file"/);
  assert.match(src, /className="pp-mc-filename"/);
});

t('jumping to the timeline survives, from inside', () => {
  // The timeline is the full thread, with everything before and after — worth
  // keeping, just no longer the only option.
  assert.match(src, /Show in the timeline/);
  assert.match(src, /onJumpToMessage\(context\.messageId\); setContext\(null\)/,
    'jumping must also close the dialog it came from');
});

t('it sits BELOW the attachment viewer', () => {
  // A file can be previewed from inside this dialog, so the viewer must be
  // on top. Viewer is 65.
  assert.match(src, /zIndex: 62/);
});

t('Escape closes it', () => {
  assert.match(src, /if \(e\.key === 'Escape'\) onClose\(\)/);
});

t('it is read-only', () => {
  // Replying belongs in the timeline; a composer here would be a second
  // place to write from with none of that surface's context.
  assert.ok(!/>\s*(Reply|Send|Forward)\s*</.test(src),
    'a reply control appeared — this dialog is for reading');
});

console.log(`\n${n} passed`);
