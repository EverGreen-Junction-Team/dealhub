// ghlMessageWrite.js — send a message (SMS or email) through GHL on a
// rep's behalf.
//
// The first OUTBOUND-COMMUNICATION write in this app. Every write before
// this one changed internal CRM state (a contact's fields, a deal's owner,
// an association) — this one puts something in front of a customer. It
// reaches GHL the exact same way every other write does: POST first,
// nothing local written until the matching webhook/sync reflects it back
// (an outbound send shows up the same way any other outbound message does
// — see messageWriter.js's OutboundMessage handling).
//
// SCOPE: needs conversations/message.write, which is NEWER than every
// other scope this app requests (see README's scope list) — some installed
// locations may not have re-authorised to grant it yet. Passed as
// scopeOptional so a location without the scope gets a clear "reauthorise"
// error on THIS call only, rather than the whole install being flagged
// reauth_required and halting unrelated syncs (see ghlClient.js's own
// comment on exactly this failure mode).

import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

export class MessageWriteError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'MessageWriteError';
    this.status = status;
  }
}

// GHL's own `type` enum (send-message-dto.ts, per the guide's field cheat
// sheet). SMS, Email and WhatsApp are the three this app can compose a body
// for — IG/FB/etc. would need their own compose UI and are not something
// Co-Pilot proposes. WhatsApp is a plain-text conversational channel like
// SMS (a `message` field, no subject) — GHL's own API shapes it identically
// to an SMS send, just with type: 'WhatsApp'.
const ALLOWED_TYPES = new Set(['SMS', 'Email', 'WhatsApp']);

// GHL's own naming for its built-in senders. Matches conversationProvidersSync
// exactly — a send and the catalogue must agree on what "native" means, or a
// message goes out as Custom against a provider id GHL treats as native.
const NATIVE_PROVIDER_PATTERNS = [
  /^twilio_provider$/,
  /^mailgun_provider$/,
  /^smtp_provider_/
];

function isNativeProviderId(id) {
  return NATIVE_PROVIDER_PATTERNS.some((re) => re.test(id || ''));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lower-cased, trimmed, de-duplicated and blank-free. Accepts an array of
// addresses or of recipient objects ({ email }, as Co-Pilot's card sends), or
// a comma/semicolon list — a pasted "a@x.com; b@y.com" is how people actually
// fill a CC row.
function addressList(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = new Set();
  for (const v of raw) {
    const s = typeof v === 'string' ? v : (v?.email || '');
    for (const part of String(s).split(/[,;]/)) {
      const a = part.trim().toLowerCase();
      if (a) out.add(a);
    }
  }
  return [...out];
}

/**
 * Validate and shape a send-message request. Dependency-free — no network,
 * no config — so it can be unit-tested the same way contactPatch.js's
 * buildContactPatch is: this is where a missing subject or an empty body
 * would otherwise reach GHL as a confusing 400, or worse, silently send an
 * empty message.
 */
export function buildMessageSend(input = {}) {
  const type = String(input.type || '').trim();
  if (!ALLOWED_TYPES.has(type)) {
    throw new MessageWriteError(`Unsupported message type: ${type || '(none)'}`, { status: 400 });
  }
  if (!input.contactId) {
    throw new MessageWriteError('A contact is required', { status: 400 });
  }

  const body = { type, contactId: input.contactId };
  // The sending user — see actionExecutor's send_message case. Optional:
  // a send with no confirming user (none today) still goes out, as the app.
  const userId = String(input.userId || '').trim();
  if (userId) body.userId = userId;

  // Which sender carries this message.
  //
  // Omitting it lets GHL fall back to the location's default provider for the
  // type — fine when there is only one, actively wrong when a location runs
  // native WhatsApp alongside a custom provider also called "WhatsApp". In
  // that case the rep picked one in the composer and we must honour it;
  // sending type alone silently routed through whichever GHL considered
  // default, with nothing in the UI revealing which.
  //
  // Still optional: when a channel has no ambiguity the composer sends no id
  // and GHL's default is exactly what we want. An empty string would be a
  // rejected id rather than "unset", so it is normalised away here.
  let providerId = String(input.conversationProviderId || '').trim();
  // A TWO-WAY-SYNC MAILBOX as the sender. The providers route lists a rep's
  // connected Gmail/Outlook as an Email sender with the synthetic id
  // "emailfrom:<address>"; GHL's send API takes that as `emailFrom` on a
  // plain Email send, not as a conversationProviderId. Only honoured for
  // Email — on any other channel the id is dropped and the native path is
  // used.
  if (providerId.startsWith('emailfrom:')) {
    const from = providerId.slice('emailfrom:'.length).trim();
    if (type === 'Email' && from) body.emailFrom = from;
    providerId = '';
  }
  if (providerId) {
    body.conversationProviderId = providerId;
    // A custom provider send is type 'Custom', NOT the channel's own type.
    //
    // GHL's enum (SendMessageBodyDto) carries both, and they mean different
    // things: 'WhatsApp' is the NATIVE WhatsApp integration, while a message
    // routed through a marketplace provider — "WhatsApp QR", "SMS Android",
    // "iMessage" — is 'Custom' plus the provider's id. Sending
    // type: 'WhatsApp' WITH a custom provider id asks GHL for the native
    // channel and names a sender that does not belong to it.
    //
    // The body shape is unchanged: a `message` for conversational channels, a
    // subject and html for email. Only the type differs.
    //
    // NATIVE providers keep their real type. twilio_provider and
    // mailgun_provider ARE the native path — the id identifies which account,
    // not a different kind of send.
    if (!isNativeProviderId(providerId)) body.type = 'Custom';
  }
  // ATTACHMENTS: URLs GHL already holds, from POST /conversations/messages/
  // upload (messageAttachmentUpload.js). Anything that is not an http(s) URL
  // is refused — a local path or a data: URI would be sent as text.
  const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
    .map((a) => String(typeof a === 'string' ? a : a?.url || '').trim())
    .filter(Boolean);
  const notUrl = attachments.find((a) => !/^https?:\/\//i.test(a));
  if (notUrl) throw new MessageWriteError('An attachment did not upload — remove it and attach it again', { status: 400 });
  if (attachments.length) body.attachments = attachments;

  if (type === 'SMS' || type === 'WhatsApp') {
    const message = String(input.message || '').trim();
    // A photo on its own is a real message (MMS / WhatsApp media).
    if (!message && !attachments.length) throw new MessageWriteError('The message has no text', { status: 400 });
    if (message) body.message = message;
  } else {
    const subject = String(input.subject || '').trim();
    const html = String(input.html || input.message || '').trim();
    if (!subject) throw new MessageWriteError('The email needs a subject', { status: 400 });
    if (!html) throw new MessageWriteError('The email has no content', { status: 400 });
    body.subject = subject;
    body.html = html;
    // RECIPIENTS beyond the contact. GHL's send takes ONE emailTo (the
    // conversation's contact is the default) and LISTS for emailCc and
    // emailBcc — so a group email is one To plus CCs, never several Tos.
    // Lower-cased and de-duplicated across the three; a CC that is also the
    // To is dropped, since the To already has it.
    //
    // A malformed CC/BCC is REFUSED with the address named, not silently
    // dropped: a rep who typed a CC and saw "Sent" would assume that person
    // got it. A typo is a 400 here rather than GHL's generic rejection.
    const checked = (value, label) => {
      const list = addressList(value);
      const bad = list.find((a) => !EMAIL_RE.test(a));
      if (bad) throw new MessageWriteError(`"${bad}" in ${label} is not an email address`, { status: 400 });
      return list;
    };
    const to = String(input.emailTo || '').trim().toLowerCase();
    if (to) body.emailTo = to;
    const cc = checked(input.emailCc, 'CC').filter((x) => x !== to);
    const bcc = checked(input.emailBcc, 'BCC').filter((x) => x !== to && !cc.includes(x));
    if (cc.length) body.emailCc = cc;
    if (bcc.length) body.emailBcc = bcc;
    // A REPLY: GHL threads it onto the existing email conversation when
    // given the thread, the message being answered and the mode. Without
    // these the same subject goes out as a brand-new email, which the
    // customer's mail client shows as a separate conversation.
    const replyMessageId = String(input.replyMessageId || '').trim();
    if (replyMessageId) {
      body.replyMessageId = replyMessageId;
      if (input.threadId) body.threadId = String(input.threadId);
      body.emailReplyMode = input.emailReplyMode === 'reply_all' ? 'reply_all' : 'reply';
    }
  }
  return body;
}

/**
 * @param {object} install
 * @param {object} input
 * @param {string} input.type        'SMS' | 'Email'
 * @param {string} input.contactId
 * @param {string} [input.message]   SMS body / plain-text fallback
 * @param {string} [input.subject]   Email only
 * @param {string} [input.html]      Email only
 * @param {string} [input.conversationProviderId] Specific sender to route
 *   through. Omit to use the location's default provider for the type.
 * @param {string}   [input.emailTo]   Email only — the To address, when it is
 *   not the contact's default one.
 * @param {string[]} [input.emailCc]   Email only — CC addresses.
 * @param {string[]} [input.emailBcc]  Email only — BCC addresses.
 */
export async function sendGhlMessage(install, input) {
  const body = buildMessageSend(input);

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: '/conversations/messages',
      data: body,
      scopeOptional: true
    });
    // The whole response, not just the ids: GHL's immediate `status` and
    // any provider note are the first evidence when a message shows in the
    // conversation but never reaches the inbox, and the outbound webhook
    // that follows carries no status at all.
    logger.info(
      { contactId: input.contactId, type: body.type,
        emailFrom: body.emailFrom, emailTo: body.emailTo, emailCc: body.emailCc,
        replyMessageId: body.replyMessageId, response: data },
      'ghlMessageWrite: message sent via GHL'
    );
    return {
      messageId: data?.messageId || null,
      emailMessageId: data?.emailMessageId || null,
      conversationId: data?.conversationId || null,
      status: data?.status || null
    };
  } catch (err) {
    throw translateMessageError(err, { contactId: input.contactId, type: body.type });
  }
}

function translateMessageError(err, { contactId, type }) {
  const status = err.response?.status;
  const body = err.response?.data;

  if (status === 401 || status === 403) {
    return new MessageWriteError(
      'This app cannot send messages yet — the conversations write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (status === 400 || status === 422) {
    const detail = body?.message || body?.error
      || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);

    logger.warn({ status, contactId, type, detail, body }, 'ghlMessageWrite: rejected by the CRM');

    // GHL usually says exactly what it disliked — "phone number is invalid",
    // "message body exceeds the limit". Throwing that away for a generic
    // "check the recipient and content" leaves a rep guessing at which of the
    // two is wrong, when the answer was in the response.
    //
    // Named cases first, because those carry advice GHL's own wording does
    // not: DND is a policy, not a mistake, and no amount of editing fixes it.
    const dnd = /dnd|do\s*not\s*disturb/i.test(detail || '');
    const badNumber = /phone|number|msisdn|recipient/i.test(detail || '')
      && /invalid|not valid|malformed|missing/i.test(detail || '');
    const noChannel = /not connected|not configured|not enabled|no .*integration/i.test(detail || '');

    // A model-written detail can be long; a card is not the place for a
    // paragraph. Trimmed to one sentence, and only used when it reads like
    // prose rather than an internal code.
    const usable = detail && detail.length <= 160 && /\s/.test(detail)
      ? detail.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
      : null;

    return new MessageWriteError(
      dnd
        ? 'This contact has do-not-disturb active for this channel — the message was not sent'
        : badNumber
          ? "That contact's phone number is not valid for this channel — nothing was sent. Check the number on the contact."
          : noChannel
            ? 'That channel is not connected in the CRM — nothing was sent. Pick a different one from Send via.'
            : usable
              // GHL's own words, framed so a rep knows the state and that the
              // card is still editable.
              ? `The CRM would not accept this message: ${usable}. Nothing was sent — edit it above and try again.`
              : 'The CRM would not accept this message — nothing was sent. Check the recipient and the wording, then try again.',
      { status: 422 }
    );
  }
  // 404 — GHL could not find something we named. Almost always the sender:
  // "No conversation provider found with id: twilio_provider" means our
  // conversation_providers table lists a sender GHL no longer has. Retrying
  // cannot fix that, so "try again" is the worst possible advice; the rep
  // needs to pick a different sender, which they can do on this very card.
  if (status === 404) {
    const missingProvider = /conversation provider/i.test(body?.message || '')
      || body?.canonicalCode === 'CONVERSATIONS_MSG_PROVIDER_NOT_FOUND';
    logger.error({ status, contactId, type, body }, 'ghlMessageWrite: not found');
    return new MessageWriteError(
      missingProvider
        ? 'That sender no longer exists in the CRM — pick a different one from Send via, or use the native channel'
        : 'The CRM could not find this contact — it may have been deleted',
      { status: 404 }
    );
  }

  // 429 — rate limited. Retrying IS the right advice here, unlike above.
  if (status === 429) {
    logger.warn({ status, contactId, type }, 'ghlMessageWrite: rate limited');
    return new MessageWriteError(
      'The CRM is rate-limiting us right now — wait a moment and send again',
      { status: 429 }
    );
  }

  logger.error({ err, status, contactId, type, body }, 'ghlMessageWrite: failed');
  return new MessageWriteError(
    status >= 500
      ? 'The CRM is not responding right now — the message was not sent. Try again shortly.'
      : 'Could not send this message — nothing was sent to the contact. Try a different sender from Send via, or send it from the CRM directly.',
    { status: status || 502 }
  );
}
