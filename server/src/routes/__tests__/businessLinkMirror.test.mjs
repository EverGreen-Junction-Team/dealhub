// The business link must be recorded in OUR database at write time.
//
// WHAT HAPPENED. "Add business" PATCHes the contact with businessId. GHL
// accepted it (200), the deal painted it — and switching tabs brought back a
// deal with no business on it. The link was real in GHL and invisible here.
//
// WHY. contacts.business_id is how a deal reaches a business — GHL has no
// opportunities.business_id (migration 056). But this route only forwarded
// to GHL and returned its echo; nothing wrote our row. We waited on a
// webhook, and GHL fires NO ContactUpdate for a business-link change. It
// emits a BUSINESSES_CONTACTS_ASSOCIATION relation swap instead, which
// businessContactRelationWriter now handles — but a webhook that is slow,
// dropped or retried out of order leaves the link invisible until the daily
// sync. A tab switch re-reads from our database, finds nothing, and the
// business is gone.
//
// THE FIX. We know what we wrote and GHL accepted it, so we record it
// ourselves. The webhook stays the authority for links made IN GHL and
// simply writes the same value again; this only closes the window.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const contacts = readFileSync(join(root, 'src/routes/contacts.js'), 'utf8');

let pass = 0;
const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

const patch = contacts.slice(
  contacts.indexOf("contactsRouter.patch('/:id'"),
  contacts.indexOf("contactsRouter.put('/:id/dnd'")
);

// ── The mirror exists, and writes the right column ───────────────────
t('the PATCH writes contacts.business_id itself', /SET business_id = \$3/.test(patch));
t('it runs AFTER GHL has accepted the change',
  patch.indexOf('await updateGhlContact') < patch.indexOf('SET business_id = $3'));

// ── null is an UNLINK, undefined is "not mentioned" ──────────────────
// A truthy check would make clearing a business impossible: the column would
// keep the old id while GHL had none.
t('it keys on the property being PRESENT, not truthy',
  /hasOwnProperty\.call\(req\.body, 'businessId'\)/.test(patch));
t('null clears the column', /req\.body\.businessId \|\| null/.test(patch));

// ── Scoping and safety ───────────────────────────────────────────────
t('the write is tenant-scoped under RLS', /withTenant\(locationId/.test(patch));
t('it matches on location AND contact', /WHERE location_id = \$1 AND contact_id = \$2/.test(patch));
t('a soft-deleted contact is left alone', /deleted_at IS NULL/.test(patch));

// ── A failed mirror must not fail the save ───────────────────────────
// GHL already has the change. Reporting a failure would tell the rep to
// retry a write that already succeeded.
t('a mirror failure is logged, not thrown',
  /business link saved in GHL but the local row did not follow/.test(patch));
t('the response is still the GHL echo', /res\.json\(\{ contact, source: 'ghl' \}\)/.test(patch));

// ── The READ side ────────────────────────────────────────────────────
// A write the UI cannot see is only half a feature: the contact API returned
// company_name (free text) but never business_id, so nothing could show
// which business record a contact belonged to — or offer to change it.
{
  const detail = contacts.slice(contacts.indexOf('      id: c.contact_id,'), contacts.indexOf('contactsRouter.patch'));
  t('the contact detail exposes the LINK, not just the typed name',
    /businessId: c\.business_id \|\| null/.test(detail));
  t('the free-text company name is still sent alongside it',
    /business: c\.company_name/.test(detail));
  t("the linked business's name is resolved for display",
    /businessName: result\.businessName \|\| null/.test(detail));
  // Looked up, not stored on the contact: renaming a business must not
  // leave a stale copy behind.
  t('the name comes from the businesses table at read time',
    /SELECT name FROM businesses/.test(contacts));
  t('only an ACTIVE business resolves', /AND is_active = true/.test(contacts));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
