#!/usr/bin/env node
//
// One-off backfill for opportunity_contacts.
//
// For every non-deleted opportunity in a location, calls:
//   GET /associations/relations/{opportunityId}?locationId={locationId}
// and upserts every OPPORTUNITIES_CONTACTS_ASSOCIATION row.
//
// Idempotent — safe to re-run. Rows arriving via webhook after this runs
// will overwrite last_seen_via='backfill' with 'webhook' automatically.
//
// Rate: ~10 req/sec per install (GHL's OAuth limit is 100/10s per resource;
// we stay well under). At ~800 opps per location that's ~80s per install.
//
// Usage:
//   node src/scripts/backfillOpportunityContacts.js                # all installs
//   node src/scripts/backfillOpportunityContacts.js <location_id>  # one location

import { rawQuery, withTenant } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import { logger } from '../utils/logger.js';

const OPP_CONTACT_ASSOC = 'OPPORTUNITIES_CONTACTS_ASSOCIATION';

async function backfillLocation(locationId) {
  const install = await getActiveInstall(locationId);
  if (!install) {
    logger.warn({ locationId }, 'backfill.oppContacts: no active install');
    return { attempted: 0, upserted: 0, failed: 0 };
  }

  const { rows: opps } = await rawQuery(
    `SELECT opportunity_id FROM opportunities
      WHERE location_id = $1
        AND is_deleted = false
        AND deleted_at IS NULL
        AND is_ghost   = false
      ORDER BY updated_at_ghl DESC NULLS LAST`,
    [locationId]
  );

  logger.info({ locationId, oppCount: opps.length }, 'backfill.oppContacts: starting');

  let upserted = 0;
  let failed = 0;
  let empty = 0;

  for (const o of opps) {
    try {
      const resp = await ghlRequest(install, {
        method: 'GET',
        url: `/associations/relations/${encodeURIComponent(o.opportunity_id)}?locationId=${encodeURIComponent(locationId)}`
      });
      const relations = Array.isArray(resp.data?.relations) ? resp.data.relations : [];
      // BY OBJECT KEY, NOT BY associationId — the same correction as
      // opportunityContactWriter's. GHL sends an opaque ObjectId here
      // ("6aab95944b0508155d99556b"), never the canonical string, so
      // filtering on the constant matched nothing and this backfill
      // reported every opportunity as having no contacts.
      const oppContactRows = relations.filter((r) => (
        (r.firstObjectKey === 'opportunity' && r.secondObjectKey === 'contact')
        || (r.firstObjectKey === 'contact' && r.secondObjectKey === 'opportunity')
      ));

      if (!oppContactRows.length) {
        empty++;
        continue;
      }

      // All rows for this opp go inside a single tenant transaction so the
      // read-back after upsert can rely on the same policy scope.
      await withTenant(locationId, async (client) => {
        for (const r of oppContactRows) {
          // GHL's docs allow either order — first_object may be opp OR contact.
          const isOppFirst = r.firstObjectKey === 'opportunity';
          const oppId = isOppFirst ? r.firstRecordId : r.secondRecordId;
          const contactId = isOppFirst ? r.secondRecordId : r.firstRecordId;
          if (!oppId || !contactId) continue;

          await client.query(
            `INSERT INTO opportunity_contacts
               (location_id, relation_id, opportunity_id, contact_id,
                is_primary, pipeline_id, association_id,
                last_synced_at, last_seen_via, raw_relation)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'backfill', $8)
             ON CONFLICT (location_id, relation_id) DO UPDATE SET
               opportunity_id = EXCLUDED.opportunity_id,
               contact_id     = EXCLUDED.contact_id,
               is_primary     = EXCLUDED.is_primary,
               pipeline_id    = COALESCE(EXCLUDED.pipeline_id, opportunity_contacts.pipeline_id),
               last_synced_at = now(),
               -- Preserve 'webhook' if we already have it; only upgrade from
               -- 'on_demand' to 'backfill'. Never downgrade webhook rows.
               last_seen_via  = CASE
                 WHEN opportunity_contacts.last_seen_via = 'webhook' THEN 'webhook'
                 ELSE 'backfill'
               END,
               raw_relation   = EXCLUDED.raw_relation`,
            [
              locationId, r.id, oppId, contactId,
              // Normalised to the canonical string, which is what every read
              // site filters on — see opportunityContactWriter.
              !!r.primary, r.pipelineId || null, OPP_CONTACT_ASSOC, r
            ]
          );
          upserted++;
        }
      });
    } catch (err) {
      failed++;
      const status = err.response?.status;
      // 404 = opp deleted between our SELECT and the API call — expected.
      const level = status === 404 ? 'debug' : 'warn';
      logger[level](
        { locationId, oppId: o.opportunity_id, status, err },
        'backfill.oppContacts: opp fetch failed'
      );
    }
  }

  logger.info(
    { locationId, oppCount: opps.length, upserted, failed, empty },
    'backfill.oppContacts: location complete'
  );
  return { attempted: opps.length, upserted, failed, empty };
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const result = await backfillLocation(arg);
    console.log(JSON.stringify({ location_id: arg, ...result }, null, 2));
    return;
  }
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs
      WHERE uninstalled_at IS NULL AND reauth_required_at IS NULL`
  );
  const totals = { locations: rows.length, attempted: 0, upserted: 0, failed: 0, empty: 0 };
  for (const r of rows) {
    const result = await backfillLocation(r.location_id);
    totals.attempted += result.attempted;
    totals.upserted  += result.upserted;
    totals.failed    += result.failed;
    totals.empty     += result.empty;
  }
  console.log(JSON.stringify(totals, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'backfillOpportunityContacts: fatal'); process.exit(1); });
