// contact_type must hold the CONTACT's type, never the webhook EVENT's.
//
// WHAT HAPPENED. contacts.contact_type showed "ContactUpdate" on records
// whose real type was 'lead'. Reported as "we have type as lead, why is
// ContactUpdate also coming — webhook event types should not be stored".
//
// THE CAUSE. pickContactFields does `const c = payload.contact || payload`.
// On the REST Get Contact shape (the backfill) that is payload.contact and
// c.type is the real 'lead' | 'customer'. On a WEBHOOK there is no `contact`
// wrapper, so `c` is the flat envelope — and the envelope's top-level `type`
// is the EVENT NAME. webhooks.js reads it as exactly that
// (eventType = event.type). So `contactType: c.type` stored the event name.
// The column is plain TEXT with no CHECK, so it landed silently.
//
// THE FIX. The real type is one of two words; anything else is the envelope
// leaking and is sent as null. The upsert's COALESCE then keeps whatever the
// backfill set, rather than overwriting a good 'lead' with an event name.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const writer = readFileSync(join(root, 'src/services/contactWriter.js'), 'utf8');

let pass = 0;
const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// Mirrors the one-line rule in pickContactFields.
const contactTypeOf = (c) => (c.type === 'lead' || c.type === 'customer') ? c.type : null;

// ── The two shapes the picker serves ─────────────────────────────────
t('a webhook envelope type (the event name) is NOT stored',
  contactTypeOf({ type: 'ContactUpdate', id: 'c1' }) === null);
t('ContactCreate is not stored either',
  contactTypeOf({ type: 'ContactCreate' }) === null);
t("the REST shape's real 'lead' is kept", contactTypeOf({ type: 'lead' }) === 'lead');
t("the REST shape's real 'customer' is kept", contactTypeOf({ type: 'customer' }) === 'customer');
t('an absent type is null, not a crash', contactTypeOf({}) === null);

// ── The source must actually use that rule ───────────────────────────
t('the writer guards contactType against the envelope',
  /contactType:\s*\(c\.type === 'lead' \|\| c\.type === 'customer'\) \? c\.type : null/.test(writer));
t('the bare passthrough is gone', !/contactType:\s*c\.type \|\| null/.test(writer));

// ── Why null is SAFE to send ─────────────────────────────────────────
// A webhook that cannot know the real type sends null. If the upsert wrote
// that null, every ContactUpdate would blank a type the backfill had set —
// a different bug with the same symptom. COALESCE keeps the stored value.
t('the upsert preserves the stored type when the incoming one is null',
  /contact_type\s+= COALESCE\(EXCLUDED\.contact_type, contacts\.contact_type\)/.test(writer));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
