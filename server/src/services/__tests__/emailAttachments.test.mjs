// Email attachments: the round trip from GHL's response into what the
// timeline renders.
//
// WHY THIS MODULE EXISTS AT ALL, restated because it is unintuitive:
// an outbound email webhook ALWAYS sends `attachments: null`. GHL stores
// email uploads on a `files` field, the webhook builder copies `attachments`
// (which that path never fills), and the `files → attachments` remap lives
// only on the GET email service. So a webhook consumer cannot see an email's
// attachments at any point, and the only way to know a PDF was sent is to
// fetch the message afterwards.
//
// These tests pin the two halves of that:
//   1. attachmentsFrom reads every shape the GET can return
//   2. extractAttachments (routes/deals.js) reads back exactly what we store
//
// Half 2 matters because the two functions live in different files and
// neither imports the other — the contract between them is "raw_message
// .attachments", and nothing but a test enforces it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// emailAttachments imports ghlClient, which imports config, which throws
// without the app's env. Stub the minimum: this test is about payload
// shapes, and requiring a database to assert one would be absurd.
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';

const { attachmentsFrom } = await import('../emailAttachments.js');

// The timeline's own reader. Imported directly now that it is a shared util:
// it used to be private to routes/deals.js, which builds an Express router at
// module load, so this test had to parse it out of the source.
const { extractAttachments } = await import('../../utils/attachments.js');

const here = dirname(fileURLToPath(import.meta.url));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// What GHL's GET /conversations/messages/:id returns, after its own
// files → attachments remap. Both field spellings, because GHL is
// inconsistent across paths.
const ghlMessage = {
  id: 'msg_1',
  subject: 'test email',
  attachments: [
    { url: 'https://msgsndr.example/f/quote-v3.pdf', filename: 'quote-v3.pdf', size: 284419, contentType: 'application/pdf' },
    { url: 'https://msgsndr.example/f/schedule.xlsx', name: 'schedule.xlsx', size: 18220, mimeType: 'application/vnd.ms-excel' }
  ]
};

console.log('attachmentsFrom — every shape the GET can return');

t('reads the remapped GET response', () => {
  const list = attachmentsFrom(ghlMessage);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'quote-v3.pdf');
  assert.equal(list[0].sizeBytes, 284419);
  assert.equal(list[0].contentType, 'application/pdf');
});

t('handles the OTHER spelling of every field', () => {
  // name/mimeType/size vs filename/contentType/sizeBytes.
  const list = attachmentsFrom(ghlMessage);
  assert.equal(list[1].name, 'schedule.xlsx');
  assert.equal(list[1].sizeBytes, 18220);
  assert.equal(list[1].contentType, 'application/vnd.ms-excel');
});

t('an un-remapped payload (files) still works', () => {
  // Insurance: the remap is the very thing this module depends on, so cope
  // with a payload that arrives without it.
  const list = attachmentsFrom({ files: [{ url: 'https://x/y/a.pdf', filename: 'a.pdf' }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'a.pdf');
});

t('attachments_metadata is read as a last resort', () => {
  const list = attachmentsFrom({ attachments_metadata: [{ url: 'https://x/y/b.pdf' }] });
  assert.equal(list[0].name, 'b.pdf');
});

t('THE WEBHOOK SHAPE yields nothing — which is why we fetch at all', () => {
  // Proven rather than assumed: this is the payload the webhook delivers.
  assert.deepEqual(attachmentsFrom({ type: 'OutboundMessage', messageType: 'Email', attachments: null }), []);
  assert.deepEqual(attachmentsFrom({ attachments: undefined }), []);
});

t('a name is derived from the url when none is given', () => {
  const list = attachmentsFrom({ attachments: [{ url: 'https://x/y/z/report final.pdf' }] });
  assert.equal(list[0].name, 'report final.pdf');
});

t('bare URL strings normalise, and the query is kept on the url', () => {
  const list = attachmentsFrom({ attachments: ['https://x/y/photo.jpg?sig=abc'] });
  assert.equal(list[0].name, 'photo.jpg', 'the signature must not appear in the filename');
  assert.equal(list[0].url, 'https://x/y/photo.jpg?sig=abc', 'but the url needs it to fetch');
});

t('an attachment with no url at all still names itself', () => {
  const list = attachmentsFrom({ attachments: [{ filename: 'inline.txt' }] });
  assert.equal(list[0].name, 'inline.txt');
  assert.equal(list[0].url, null);
});

t('a nameless, urlless entry falls back rather than rendering blank', () => {
  const list = attachmentsFrom({ attachments: [{ size: 10 }] });
  assert.equal(list[0].name, 'attachment');
});

t('junk entries are dropped', () => {
  assert.deepEqual(attachmentsFrom({ attachments: [null, undefined, 42, true] }), []);
});

t('non-objects, absent and empty all yield []', () => {
  // The UI maps over this — null or undefined would throw.
  for (const v of [null, undefined, 'str', 42, {}, { attachments: [] }, { attachments: {} }]) {
    assert.deepEqual(attachmentsFrom(v), [], JSON.stringify(v));
  }
});

// ── The contract between the two files ──────────────────────────────────
console.log('\nthe stored payload is readable by the timeline route');

t('extractAttachments reads back what attachEmailFiles stores', () => {
  // messageWriter merges the fetched list into raw.attachments; the route
  // calls extractAttachments(raw_message). Neither file imports the other,
  // so this assertion IS the contract.
  const stored = { subject: 'test email', attachments: attachmentsFrom(ghlMessage) };
  const out = extractAttachments(stored);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.equal(out[0].name, 'quote-v3.pdf');
  assert.equal(out[0].sizeBytes, 284419);
  assert.equal(out[0].contentType, 'application/pdf');
  assert.equal(out[0].url, 'https://msgsndr.example/f/quote-v3.pdf');
  assert.equal(out[1].name, 'schedule.xlsx');
});

t('an email with no attachments yields [] on both sides', () => {
  assert.deepEqual(attachmentsFrom({ subject: 'x' }), []);
  assert.deepEqual(extractAttachments({ subject: 'x' }), []);
});

t('SMS mediaUrls still work — this must not have regressed', () => {
  // extractAttachments is shared with SMS/WhatsApp. Adding email must not
  // change what those rows show.
  const out = extractAttachments({ mediaUrls: ['https://x/y/pic.png'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'pic.png');
});

// ── The endpoint, and the 400 that led to it ────────────────────────────
//
// EMAIL HAS ITS OWN ENDPOINT:
//
//   GET /conversations/messages/email/:emailMessageId   ← correct
//   GET /conversations/messages/:messageId              ← keyed on a MESSAGE id
//
// The email webhook carries no message id — only emailMessageId — so the
// second endpoint answered:
//
//   400 {"statusCode":400,"message":["id must be a mongodb id"]}
//
// on every outbound email. These pin the shape of the right call and the
// response it returns.
console.log('\nthe email endpoint');

// Verbatim from the production log.
const webhookEmail = {
  type: 'OutboundMessage',
  messageType: 'Email',
  emailMessageId: 'wrar6fgvTHPYpnZ59OII',
  conversationId: 'ViWxASykTdIrYoVWsVTB',
  threadId: 'Y0mfq5LQblJFg0xpHDON',
  contactId: 'PzC9uHYa6okhyn7zHlCd',
  subject: 'test'
};

t('the webhook has NO messageId — the root cause of the 400', () => {
  assert.equal(webhookEmail.messageId, undefined);
  assert.equal(webhookEmail.id, undefined);
  // Only this, which belongs to the email collection.
  assert.ok(webhookEmail.emailMessageId);
});

t('THE RESPONSE IS string[] — urls, not objects', () => {
  // The documented shape: "attachments": string[], "An array of attachment
  // URLs". No filenames, no sizes.
  const email = {
    id: 'wrar6fgvTHPYpnZ59OII',
    subject: 'test',
    attachments: [
      'https://msgsndr.example/f/abc/quote-v3.pdf',
      'https://msgsndr.example/f/def/elevation.dwg'
    ]
  };
  const list = attachmentsFrom(email);
  assert.equal(list.length, 2);
  // Names come from the URL, because that is all there is.
  assert.equal(list[0].name, 'quote-v3.pdf');
  assert.equal(list[1].name, 'elevation.dwg');
  // Size is genuinely unknown — null, not 0, so the chip omits it rather
  // than rendering "0 KB" as though the file were empty.
  assert.equal(list[0].sizeBytes, null);
  assert.equal(list[0].url, 'https://msgsndr.example/f/abc/quote-v3.pdf');
});

t('a signed url keeps its query but not in the filename', () => {
  const list = attachmentsFrom({
    attachments: ['https://msgsndr.example/f/x/report.pdf?sig=abc123&exp=999']
  });
  assert.equal(list[0].name, 'report.pdf', 'the signature must not appear as the filename');
  assert.ok(list[0].url.includes('sig=abc123'), 'but the url needs it to fetch');
});

t('an email with no attachments yields []', () => {
  // Every test email so far: the endpoint returns the email, attachments
  // absent or empty.
  assert.deepEqual(attachmentsFrom({ id: 'x', subject: 'test' }), []);
  assert.deepEqual(attachmentsFrom({ id: 'x', attachments: [] }), []);
  assert.deepEqual(attachmentsFrom({ id: 'x', attachments: null }), []);
});

t('the url-string list survives the round trip into the timeline', () => {
  // string[] in, chips out. This is the contract that matters now.
  const stored = {
    subject: 'test',
    attachments: attachmentsFrom({ attachments: ['https://msgsndr.example/f/a/plan.pdf'] })
  };
  const out = extractAttachments(stored);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'plan.pdf');
  assert.equal(out[0].url, 'https://msgsndr.example/f/a/plan.pdf');
  assert.equal(out[0].sizeBytes, null);
});

// ── The source must still call the right endpoint ───────────────────────
const svc = readFileSync(join(here, '..', 'emailAttachments.js'), 'utf8');

t('it calls the EMAIL endpoint, not the message endpoint', () => {
  assert.match(svc, /\/conversations\/messages\/email\/\$\{encodeURIComponent\(emailMessageId\)\}/,
    'the email endpoint is gone — the message endpoint 400s on an email id');
  // And must not have regressed to the message path.
  assert.ok(!/url: `\/conversations\/messages\/\$\{encodeURIComponent\(messageId\)\}`/.test(svc),
    'the message-id endpoint is back — it returns 400 for email ids');
});

t('Version 2021-04-15 is still pinned', () => {
  // The wrong version makes GHL answer 401, which flagged an install and
  // discarded webhooks the last time it happened.
  assert.match(svc, /EMAIL_API_VERSION = '2021-04-15'/);
  assert.match(svc, /headers: \{ Version: EMAIL_API_VERSION \}/);
});

t('the call stays scopeOptional', () => {
  // A 401 from one endpoint must never mark the install reauth_required.
  assert.match(svc, /scopeOptional: true/);
});

t('the catch logs the whole error, not err.message', () => {
  assert.ok(!/err: err\.message/.test(svc),
    'err.message loses GHL ghlBody — pass the error object');
  assert.match(svc, /\{ locationId, emailMessageId, err \}/);
});

// The caller must read emailMessageId from the EVENT, not reuse f.messageId:
// that field is `messageId || emailMessageId || id`, so it would silently
// become a message id the day GHL starts sending one.
const writer = readFileSync(join(here, '..', 'messageWriter.js'), 'utf8');

t('the caller passes event.emailMessageId explicitly', () => {
  assert.match(writer, /const emailMessageId = event\?\.emailMessageId \|\| null/,
    'attachEmailFiles must read emailMessageId from the event');
  assert.match(writer, /fetchEmailAttachments\(install, emailMessageId/);
});

console.log(`\n${n} passed`);
