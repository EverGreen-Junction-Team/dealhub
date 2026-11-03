// Tests for services/ghlMessageWrite.js — buildMessageSend.
//
// Run: node src/services/__tests__/ghlMessageWrite.test.mjs
//
// This is the first OUTBOUND-COMMUNICATION write in the app — a bad shape
// here doesn't just corrupt a CRM field, it can send an empty or malformed
// message to a real customer. Every rule below exists to fail HERE, before
// the request ever reaches GHL.

process.env.DATABASE_URL ||= 'postgres://stub/stub';

const { buildMessageSend, MessageWriteError } = await import('../ghlMessageWrite.js');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };
const throws = (fn, match) => {
  try { fn(); return false; }
  catch (e) { return e instanceof MessageWriteError && (!match || match.test(e.message)); }
};

// ── SMS ──────────────────────────────────────────────────────────────
const sms = buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'Hello there' });
t('SMS maps type/contactId/message', sms.type === 'SMS' && sms.contactId === 'c1' && sms.message === 'Hello there');
t('SMS body has no email fields', !('subject' in sms) && !('html' in sms));

t('SMS with no message is refused', throws(() => buildMessageSend({ type: 'SMS', contactId: 'c1' }), /no text/));
t('SMS with a whitespace-only message is refused',
  throws(() => buildMessageSend({ type: 'SMS', contactId: 'c1', message: '   ' }), /no text/));
t('SMS message is trimmed',
  buildMessageSend({ type: 'SMS', contactId: 'c1', message: '  hi  ' }).message === 'hi');

// ── WhatsApp ─────────────────────────────────────────────────────────
const wa = buildMessageSend({ type: 'WhatsApp', contactId: 'c1', message: 'Hello there' });
t('WhatsApp maps type/contactId/message, same shape as SMS',
  wa.type === 'WhatsApp' && wa.contactId === 'c1' && wa.message === 'Hello there');
t('WhatsApp body has no email fields', !('subject' in wa) && !('html' in wa));

t('WhatsApp with no message is refused',
  throws(() => buildMessageSend({ type: 'WhatsApp', contactId: 'c1' }), /no text/));
t('WhatsApp with a whitespace-only message is refused',
  throws(() => buildMessageSend({ type: 'WhatsApp', contactId: 'c1', message: '   ' }), /no text/));
t('WhatsApp message is trimmed',
  buildMessageSend({ type: 'WhatsApp', contactId: 'c1', message: '  hi  ' }).message === 'hi');

// ── Email ────────────────────────────────────────────────────────────
const email = buildMessageSend({
  type: 'Email', contactId: 'c1', subject: 'Order update', html: '<p>Shipped</p>'
});
t('Email maps type/contactId/subject/html', email.subject === 'Order update' && email.html === '<p>Shipped</p>');
t('Email body has no SMS message field', !('message' in email));

t('Email with no subject is refused',
  throws(() => buildMessageSend({ type: 'Email', contactId: 'c1', html: '<p>x</p>' }), /needs a subject/));
t('Email with no content is refused',
  throws(() => buildMessageSend({ type: 'Email', contactId: 'c1', subject: 'Hi' }), /no content/));
t('Email falls back to `message` as plain-text content when html is not given',
  buildMessageSend({ type: 'Email', contactId: 'c1', subject: 'Hi', message: 'plain body' }).html === 'plain body');
t('Email prefers html over message when both are given',
  buildMessageSend({ type: 'Email', contactId: 'c1', subject: 'Hi', html: '<p>a</p>', message: 'b' }).html === '<p>a</p>');

// ── conversationProviderId ───────────────────────────────────────────
// Sending type alone let GHL pick the default provider. On a location with
// native WhatsApp AND a custom provider named "WhatsApp", that silently
// routed through whichever GHL preferred, with nothing in the UI saying so.
t('a provider id is passed through when given',
  buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'x', conversationProviderId: 'abc123' })
    .conversationProviderId === 'abc123');
t('no provider id means the field is absent, not null (GHL then uses the default)',
  !('conversationProviderId' in buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'x' })));
t('an empty provider id is treated as unset, never sent as ""',
  !('conversationProviderId' in buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'x', conversationProviderId: '' })));
t('a whitespace-only provider id is treated as unset',
  !('conversationProviderId' in buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'x', conversationProviderId: '   ' })));
t('a provider id is trimmed',
  buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'x', conversationProviderId: ' abc123 ' })
    .conversationProviderId === 'abc123');
t('a provider id works on Email too',
  buildMessageSend({ type: 'Email', contactId: 'c1', subject: 'S', html: '<p>b</p>', conversationProviderId: 'mailgun_provider' })
    .conversationProviderId === 'mailgun_provider');
t('a provider id works on WhatsApp too',
  buildMessageSend({ type: 'WhatsApp', contactId: 'c1', message: 'x', conversationProviderId: 'wa1' })
    .conversationProviderId === 'wa1');

// ── Custom provider sends ────────────────────────────────────────────
// GHL's enum carries both 'WhatsApp' and 'Custom', and they mean different
// things: 'WhatsApp' is the NATIVE integration, while a message routed
// through a marketplace provider — "WhatsApp QR", "SMS Android", "iMessage" —
// is 'Custom' plus the provider's id. Sending the channel type WITH a custom
// provider id asks for the native channel and names a sender that is not on
// it.
const viaCustom = buildMessageSend({
  type: 'WhatsApp', contactId: 'c1', message: 'hi',
  conversationProviderId: '6a22bfc4fcbd457e97784fbb'
});
t('a custom provider send becomes type Custom', viaCustom.type === 'Custom');
t('the provider id still goes with it',
  viaCustom.conversationProviderId === '6a22bfc4fcbd457e97784fbb');
t('the body is unchanged — still a plain message', viaCustom.message === 'hi');

// The body must be shaped by the ORIGINAL channel, not by 'Custom': an email
// through a custom provider still needs a subject and html.
const customEmail = buildMessageSend({
  type: 'Email', contactId: 'c1', subject: 'S', html: '<p>b</p>',
  conversationProviderId: '6a99'
});
t('a custom Email send is type Custom', customEmail.type === 'Custom');
t('it keeps the subject', customEmail.subject === 'S');
t('it keeps the html', customEmail.html === '<p>b</p>');
t('it has no SMS message field', !('message' in customEmail));

// An email with no subject must still be REFUSED when a provider is named —
// the validation runs on the real channel, before the type is rewritten.
t('a custom Email with no subject is still refused',
  throws(() => buildMessageSend({
    type: 'Email', contactId: 'c1', html: '<p>x</p>', conversationProviderId: '6a99'
  }), /needs a subject/));

// Native providers keep their real type: twilio_provider IS the native path,
// and the id says which account, not a different kind of send.
for (const [id, type] of [
  ['twilio_provider', 'SMS'], ['mailgun_provider', 'Email'], ['smtp_provider_9', 'Email']
]) {
  const b = buildMessageSend(
    type === 'Email'
      ? { type, contactId: 'c1', subject: 'S', html: '<p>b</p>', conversationProviderId: id }
      : { type, contactId: 'c1', message: 'hi', conversationProviderId: id }
  );
  t(`${id} keeps type ${type}, not Custom`, b.type === type);
  t(`${id} still carries its id`, b.conversationProviderId === id);
}

// No provider at all is unchanged — the common case must not move.
t('no provider means the channel type is kept',
  buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'x' }).type === 'SMS');

// ── Cross-cutting ────────────────────────────────────────────────────
t('an unknown type is refused', throws(() => buildMessageSend({ type: 'Facebook', contactId: 'c1', message: 'x' }), /Unsupported/));
t('no type at all is refused', throws(() => buildMessageSend({ contactId: 'c1', message: 'x' })));
t('no contactId is refused', throws(() => buildMessageSend({ type: 'SMS', message: 'x' }), /contact is required/));

// ── Error messages a rep can act on ──────────────────────────────────
// GHL returned 404 "No conversation provider found with id: twilio_provider".
// It fell past every branch to a catch-all that said "Could not send — try
// again" with status 502; the route dropped the message; and the dashboard
// turned a statusless 502 into "Couldn't reach the server — check your
// connection". Three layers each made it worse: wrong cause, wrong fix, and
// it hid the one thing the rep could actually do — pick another sender.
const { readFileSync } = await import('node:fs');
const writeSrc = readFileSync(
  new URL('../ghlMessageWrite.js', import.meta.url), 'utf8');

t('a missing sender is named as such', /That sender no longer exists in the CRM/.test(writeSrc));
t('it tells the rep what to do instead', /pick a different one from Send via/.test(writeSrc));
t('it is NOT advice to retry',
  !/try again/i.test((writeSrc.match(/That sender no longer exists[^']*/) || [''])[0]));
t('a 404 is distinguished from a missing contact',
  /could not find this contact/.test(writeSrc));
t('the provider case is matched on GHL\'s own code',
  /CONVERSATIONS_MSG_PROVIDER_NOT_FOUND/.test(writeSrc));
t('rate limiting is its own message, where retrying IS right',
  /rate-limiting us right now/.test(writeSrc));
t('a 5xx says nothing was sent', /the message was not sent/.test(writeSrc));
t('the status is preserved, not flattened to 502', /status: status \|\| 502/.test(writeSrc));

// Every rejection must answer two questions a rep actually has: did it go
// out, and what do I do now. "The CRM rejected this message — check the
// recipient and content" answered neither: it left the state ambiguous, and
// "check the content" is a guess when GHL had already said what was wrong.
t('a rejection says nothing was sent', /nothing was sent/i.test(writeSrc));
t("GHL's own reason is surfaced when it reads as prose",
  /would not accept this message: \$\{usable\}/.test(writeSrc));
t('an internal code is not shown to a rep',
  /detail\.length <= 160 && \/\\s\/\.test\(detail\)/.test(writeSrc));
t('a long detail is not dumped onto the card', /<= 160/.test(writeSrc));
t('an invalid number says where to fix it', /Check the number on the contact/.test(writeSrc));
t('a disconnected channel points at the picker',
  /not connected in the CRM — nothing was sent\. Pick a different one/.test(writeSrc));
t('the last-resort message still offers a way forward',
  /send it from the CRM directly/.test(writeSrc));
// DND is a policy, not a mistake — editing the message cannot fix it, so it
// must not be lumped in with "edit it above and try again".
t('DND is named before the generic path', /const dnd = /.test(writeSrc)
  && writeSrc.indexOf('const dnd =') < writeSrc.indexOf('usable'));

// ── CC / BCC (Deal Hub composer) ─────────────────────────────────────
const ccMail = buildMessageSend({
  type: 'Email', contactId: 'c1', subject: 'Hi', html: '<p>x</p>',
  emailCc: 'a@x.com; A@x.com, b@y.co', emailBcc: ['  c@z.io  ', '']
});
t('CC accepts a pasted list and de-duplicates case-insensitively',
  JSON.stringify(ccMail.emailCc) === JSON.stringify(['a@x.com', 'b@y.co']));
t('BCC is trimmed and blank-free', JSON.stringify(ccMail.emailBcc) === JSON.stringify(['c@z.io']));
t('no CC/BCC means no keys on the body',
  !('emailCc' in buildMessageSend({ type: 'Email', contactId: 'c1', subject: 'Hi', html: 'x' })));
t('a bad CC address is refused and named',
  throws(() => buildMessageSend({ type: 'Email', contactId: 'c1', subject: 'Hi', html: 'x', emailCc: ['nope'] }), /"nope" in CC/));
t('CC is ignored on SMS — it has no email fields',
  !('emailCc' in buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'hi', emailCc: ['a@x.com'] })));

// ── Attachments (composer paperclip) ─────────────────────────────────
const withFile = buildMessageSend({
  type: 'Email', contactId: 'c1', subject: 'Quote', html: '<p>see attached</p>',
  attachments: ['https://cdn.ghl/q.pdf', { url: 'https://cdn.ghl/p.png' }, '']
});
t('attachment URLs (strings or {url}) reach the body',
  JSON.stringify(withFile.attachments) === JSON.stringify(['https://cdn.ghl/q.pdf', 'https://cdn.ghl/p.png']));
t('no attachments means no key',
  !('attachments' in buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'hi' })));
t('a photo alone is a valid SMS/WhatsApp message',
  buildMessageSend({ type: 'WhatsApp', contactId: 'c1', attachments: ['https://cdn.ghl/p.png'] }).attachments.length === 1);
t('a non-URL attachment is refused',
  throws(() => buildMessageSend({ type: 'SMS', contactId: 'c1', message: 'hi', attachments: ['C:\\q.pdf'] }), /did not upload/));

const { checkFiles, AttachmentError } = await import('../messageAttachmentUpload.js');
const refuses = (files, re) => { try { checkFiles(files); return false } catch (e) { return e instanceof AttachmentError && re.test(e.message) } };
t('an accepted type passes', (() => { try { checkFiles([{ originalname: 'Quote.PDF', size: 10 }]); return true } catch { return false } })());
t('an unsupported type is refused by name', refuses([{ originalname: 'tool.exe', size: 10 }], /"tool\.exe" cannot be attached/));
t('over 25 MB is refused', refuses([{ originalname: 'big.zip', size: 26 * 1024 * 1024 }], /over 25 MB/));
t('more than ten files is refused', refuses(Array.from({ length: 11 }, (_, i) => ({ originalname: `${i}.png`, size: 1 })), /At most 10/));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
