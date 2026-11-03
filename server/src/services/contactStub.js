// contactStub.js — shared helper to ensure a contacts row exists before
// FK-dependent writes (messages, tasks, notes).
//
// Root cause it addresses (QA finding H5): webhooks for related entities
// (TaskCreate, NoteCreate, InboundMessage) can arrive BEFORE the parent
// contact's ContactCreate — either because GHL delivers out of order or
// because we're a lead that pre-exists in GHL but was never captured on
// our side. The FK from tasks/notes/messages → contacts blocks the insert,
// GHL retries, we drop the record.
//
// Fix: INSERT a stub contact row (PK columns + from_backfill=true only)
// with ON CONFLICT DO NOTHING. If the contact already exists, this is a
// no-op. If it doesn't, we get a stub that lets the child row insert
// succeed. The daily contactsSync cron enriches the stub with all the
// promoted fields (COALESCE on every column means the stub NULLs get
// filled in, never overwriting real data).

import { rawQuery } from '../db.js';

export async function ensureContactExists(locationId, contactId) {
  if (!locationId || !contactId) return;
  await rawQuery(
    `INSERT INTO contacts (location_id, contact_id, imported_at, updated_at, from_backfill)
     VALUES ($1, $2, now(), now(), true)
     ON CONFLICT (location_id, contact_id) DO NOTHING`,
    [locationId, contactId]
  );
}
