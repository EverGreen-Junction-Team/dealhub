// backfillOpportunities.js — one-time seed of the opportunities table.
//
// Paginates GHL's opportunity search endpoint and dispatches each opp through
// handleOpportunityEvent with a synthetic 'opportunity_updated' shape — the
// same code path live webhooks use. That means:
//   • All promoted fields populated (client_type/product_system/... as JSONB
//     arrays, why_want/why_buy/why_blocker, forecast fields, lost_reason,
//     opportunity_source, gclid, currency, raw_opportunity)
//   • Lifecycle timestamps (won_at/lost_at/abandoned_at) stamped for closed
//     opps
//   • Associations refreshed, tags reconciled, stage_history handled
//
// Usage:
//   npm run backfill:opportunities -- --location fJNuIdxGgchGpJ9OoBbk
//   npm run backfill:opportunities                           # all active installs
//
// Idempotent: UPSERT semantics + write-once lifecycle timestamps mean
// re-running is safe. Existing rows keep their earliest won_at/lost_at
// values via COALESCE.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import { handleOpportunityEvent } from '../services/stageHistoryWriter.js';
import { logger } from '../utils/logger.js';

function parseArgs(argv) {
  const locations = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--location' && argv[i + 1]) {
      locations.push(argv[++i]);
    }
  }
  return { locations };
}

async function listAllActiveLocations() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL ORDER BY installed_at ASC`
  );
  return rows.map((r) => r.location_id);
}

// GHL opportunity search: GET /opportunities/search?location_id=X&limit=100&startAfter=<epochMs>&startAfterId=<id>
// Returns { opportunities: [...], meta: { startAfter, startAfterId, ... } }.
async function backfillLocation(install) {
  const locationId = install.location_id;
  logger.info({ locationId }, 'opportunityBackfill: starting');

  let total = 0;
  let startAfter = null;
  let startAfterId = null;
  const pageSize = 100;

  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({
      location_id: locationId,
      limit: String(pageSize)
    });
    if (startAfter)   params.set('startAfter', String(startAfter));
    if (startAfterId) params.set('startAfterId', startAfterId);

    let data;
    try {
      const resp = await ghlRequest(install, {
        method: 'GET',
        url: `/opportunities/search?${params.toString()}`
      });
      data = resp.data;
    } catch (err) {
      logger.error(
        { locationId, page, err, status: err.response?.status },
        'opportunityBackfill: page fetch failed — stopping'
      );
      break;
    }

    const opps = Array.isArray(data?.opportunities) ? data.opportunities : [];
    if (opps.length === 0) break;

    for (const raw of opps) {
      try {
        // Wrap the REST-shaped opportunity in a synthetic event and dispatch
        // through the same writer live webhooks use. eventType is
        // 'opportunity_updated' (metadata-only path) — that upserts the row
        // without generating a spurious stage transition.
        const syntheticEvent = {
          type: 'opportunity_updated',
          locationId,
          opportunity: raw,
          opportunityId: raw.id,
          contactId: raw.contactId,
          timestamp: raw.updatedAt || raw.createdAt || new Date().toISOString(),
          _fromBackfill: true
        };
        await handleOpportunityEvent(install, 'opportunity_updated', syntheticEvent);
        total++;
      } catch (err) {
        logger.warn(
          { locationId, opportunityId: raw?.id, err },
          'opportunityBackfill: opp dispatch failed — skipped'
        );
      }
    }

    const last = opps[opps.length - 1];
    startAfter = last?.updatedAt ? new Date(last.updatedAt).getTime()
              : last?.createdAt ? new Date(last.createdAt).getTime()
              : null;
    startAfterId = last?.id || null;

    logger.info({ locationId, page: page + 1, total }, 'opportunityBackfill: page done');
    if (opps.length < pageSize) break;
  }

  logger.info({ locationId, total }, 'opportunityBackfill: complete');
  return { count: total };
}

async function main() {
  const { locations: cli } = parseArgs(process.argv);
  const targets = cli.length ? cli : await listAllActiveLocations();

  if (targets.length === 0) {
    logger.warn('backfillOpportunities: no locations found');
    return;
  }

  logger.info({ targets }, 'backfillOpportunities: starting');

  let totalOpps = 0;
  for (const locationId of targets) {
    const install = await getActiveInstall(locationId);
    if (!install) {
      logger.warn({ locationId }, 'backfillOpportunities: no active install — skipping');
      continue;
    }
    try {
      const { count } = await backfillLocation(install);
      totalOpps += count;
    } catch (err) {
      logger.error({ err, locationId }, 'backfillOpportunities: location failed');
    }
  }

  logger.info({ locations: targets.length, totalOpps }, 'backfillOpportunities: complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfillOpportunities: failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
