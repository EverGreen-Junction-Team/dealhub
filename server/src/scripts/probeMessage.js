#!/usr/bin/env node
//
// Ask GHL what became of one message.
//
//   npm run probe:message -- <location_id> <message_id> [<message_id> ...]
//
// Our outbound rows carry no delivery status — GHL's OutboundMessage webhook
// does not include one — so "it shows in the conversation but never arrived"
// cannot be diagnosed from our tables. GHL's message endpoints can: the
// message record carries `status` (sent / delivered / failed / undelivered…)
// and, for email, a separate email record with the provider's own error and
// the From/To/CC it actually used. Prints both, raw, for each id.

import 'dotenv/config';
import { pool } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';

async function fetchOrErr(install, url) {
  try {
    const { data } = await ghlRequest(install, { method: 'GET', url });
    return data;
  } catch (err) {
    return { __error: err.response?.status || null, body: err.response?.data || err.message };
  }
}

async function main() {
  const [locationId, ...ids] = process.argv.slice(2);
  if (!locationId || !ids.length) {
    console.log('usage: npm run probe:message -- <location_id> <message_id> [...]');
    return;
  }
  const install = await getActiveInstall(locationId);
  if (!install) { console.log(`${locationId}: no active install`); return; }

  for (const id of ids) {
    console.log(`\n=== message ${id}`);
    const msg = await fetchOrErr(install, `/conversations/messages/${encodeURIComponent(id)}`);
    const m = msg?.message || msg;
    console.log(JSON.stringify({
      status: m?.status, direction: m?.direction, type: m?.messageType || m?.type,
      source: m?.source, userId: m?.userId, dateAdded: m?.dateAdded,
      conversationProviderId: m?.conversationProviderId,
      meta: m?.meta, error: m?.error || m?.__error ? (m?.error || m) : undefined
    }, null, 2));

    // The email record, when there is one: this is where Gmail/Mailgun's
    // verdict and the real From/To/CC live.
    const emailId = m?.meta?.email?.messageIds?.[0] || m?.emailMessageId || id;
    const email = await fetchOrErr(install, `/conversations/messages/email/${encodeURIComponent(emailId)}`);
    const e = email?.emailMessage || email;
    console.log('--- email record', emailId);
    console.log(JSON.stringify({
      status: e?.status, from: e?.from, to: e?.to, cc: e?.cc, bcc: e?.bcc,
      subject: e?.subject, provider: e?.provider, threadId: e?.threadId,
      replyToMessageId: e?.replyToMessageId, dateAdded: e?.dateAdded,
      error: e?.error || e?.__error ? (e?.error || e) : undefined
    }, null, 2));
  }
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
