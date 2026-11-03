#!/usr/bin/env node
//
// Pull one contact's messages from GHL into our messages table.
//
//   npm run sync:contact-messages -- <location_id> <contact_id> [days=30]
//
// The nightly message sweep is paused (orphanSweep.js), so a message GHL
// never sends by webhook — a "Form submitted" activity entry, for one — has
// no way in. This fetches every message in the contact's conversations
// from the last <days> days through the same mapper and writer the sweep
// uses. Existing rows are left as they are (dedup on message_id); only the
// missing ones are added.

import 'dotenv/config';
import { pool } from '../db.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { syncMessagesForContact } from '../services/messagesSync.js';

async function main() {
  const [locationId, contactId, daysArg] = process.argv.slice(2);
  if (!locationId || !contactId) {
    console.log('usage: npm run sync:contact-messages -- <location_id> <contact_id> [days=30]');
    return;
  }
  const days = Number(daysArg) > 0 ? Number(daysArg) : 30;
  const install = await getActiveInstall(locationId);
  if (!install) { console.log(`${locationId}: no active install`); return; }
  const since = new Date(Date.now() - days * 86400000);
  const r = await syncMessagesForContact(install, contactId, { since });
  console.log(`${contactId}: ${r.conversationsScanned} conversation(s) scanned, ${r.messagesUpserted} message(s) written (since ${since.toISOString().slice(0, 10)})`);
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
