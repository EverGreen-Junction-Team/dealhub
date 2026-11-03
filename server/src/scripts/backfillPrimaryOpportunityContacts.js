// Put every opportunity's PRIMARY contact into opportunity_contacts.
//
// THE GAP. That table is meant to hold every contact on a deal, but it is
// only ever written by RelationCreate webhooks — and GHL does not send one
// for the primary contact. The primary arrives on the opportunity payload
// itself as `contactId`, and nothing copies it across. Measured on live
// data: 237 of 917 deals (26%) have no row for their own primary contact.
//
// WHY IT MATTERS. attributionEngine.contactOppIds reads opportunity_contacts
// first and falls back to opportunities.contact_id only when the contact has
// NO rows at all:
//
//     if (rows.length > 0) return rows.map(...)   // <- all-or-nothing
//
// So today the fallback quietly covers the gap. But the moment a contact
// gains one row — by being added as a follower to any other deal — the
// fallback switches off and that contact's OWN primary deals become
// invisible. Their messages then attribute to the wrong deal, or to none.
//
// NO API CALLS. We already hold the primary in opportunities.contact_id;
// there is nothing to fetch. (The older backfillOpportunityContacts.js asks
// GHL's associations endpoint, which is a different job and does not carry
// the primary.)
//
// Run: node src/scripts/backfillPrimaryOpportunityContacts.js [--dry-run] [--location=<id>]

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const onlyLocation = args.find((a) => a.startsWith('--location='))?.split('=')[1] || null;
const dryRun = args.includes('--dry-run');

const FIND = `
  SELECT o.location_id, o.opportunity_id, o.contact_id, o.pipeline_id
    FROM opportunities o
   WHERE o.contact_id IS NOT NULL
     AND o.is_deleted = false
     AND o.deleted_at IS NULL
     ${onlyLocation ? 'AND o.location_id = $1' : ''}
     AND NOT EXISTS (
           SELECT 1 FROM opportunity_contacts oc
            WHERE oc.location_id    = o.location_id
              AND oc.opportunity_id = o.opportunity_id
              AND oc.contact_id     = o.contact_id
         )
   ORDER BY o.location_id, o.opportunity_id`;

// A synthetic relation_id, because GHL never issued one for the primary.
//
// Prefixed so it can never collide with a real GHL relation id, and derived
// from the pair so re-running produces the same key — that is what makes the
// ON CONFLICT below a genuine no-op rather than a duplicate.
//
// If GHL later sends a real RelationCreate for this pair, it inserts under
// ITS id and both rows exist. Harmless: contactOppIds selects opportunity_id,
// and a contact linked twice to one deal still yields that deal once through
// rule 1's LIMIT 1.
const INSERT = `
  INSERT INTO opportunity_contacts
    (location_id, relation_id, opportunity_id, contact_id, is_primary,
     pipeline_id, association_id, last_seen_via, raw_relation)
  VALUES ($1, 'primary:' || $2 || ':' || $3, $2, $3, true,
          $4, 'OPPORTUNITIES_CONTACTS_ASSOCIATION', 'backfill', NULL)
  ON CONFLICT (location_id, relation_id) DO NOTHING`;

async function run() {
  const { rows } = await rawQuery(FIND, onlyLocation ? [onlyLocation] : []);
  console.log(`${rows.length} opportunities are missing their primary contact`);
  if (rows.length === 0) return;

  const byLocation = {};
  for (const r of rows) byLocation[r.location_id] = (byLocation[r.location_id] || 0) + 1;
  for (const [loc, n] of Object.entries(byLocation)) console.log(`  ${loc}: ${n}`);

  if (dryRun) {
    console.log('\nDRY RUN — nothing written.');
    console.log('Sample:');
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.opportunity_id} → contact ${r.contact_id}`);
    }
    return;
  }

  let added = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const res = await rawQuery(INSERT, [
        r.location_id, r.opportunity_id, r.contact_id, r.pipeline_id || null
      ]);
      added += res.rowCount || 0;
    } catch (err) {
      // One bad row must not abort the run.
      failed += 1;
      logger.warn(
        { err, locationId: r.location_id, opportunityId: r.opportunity_id },
        'backfillPrimaryOpportunityContacts: row failed'
      );
    }
  }
  console.log(`\nAdded ${added} rows${failed ? `, ${failed} failed` : ''}.`);
  console.log('Re-run safe: the synthetic relation_id is derived from the pair.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'backfillPrimaryOpportunityContacts failed'); process.exit(1); });
