// opportunitiesSync.js — daily reconciliation sweep for opportunities.
//
// Catches dropped opportunity webhooks. Uses sweep_cursors.object_type =
// 'opportunities' to remember the last safely reconciled point. Runs from
// the same daily cron as messagesSync + contactsSync.
//
// Approach: paginate GET /opportunities/search ordered by updatedAt ASC.
// Dispatch each opp through handleOpportunityEvent with 'opportunity_updated'
// type (metadata-only path — refreshes the opportunities row without
// generating a spurious stage_history transition).
//
// DELETIONS. A deal deleted in GHL is simply ABSENT from the search results,
// and for a long time absence was read as nothing: the only thing that ever
// set is_deleted was the OpportunityDelete webhook. Miss that one event —
// the server was restarting, the subscription lacked it, the deal went with
// a contact merge or a bulk delete that fires no per-deal event — and the
// row stayed open for good: in the pipeline, in forecasts, and offered to
// the AI as a deal to update (which then 404s). The sweep already walks the
// whole location, so after a COMPLETE walk every live local deal GHL did not
// return is one GHL no longer has. Same rule tasksSync and businessesSync
// apply, with the same guard against an empty or truncated listing.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { handleOpportunityEvent } from './stageHistoryWriter.js';
import { getCursor, computeWindow, advanceCursor } from './sweepCursors.js';
import { shouldReconcileDeletes } from './businessesReconcile.js';
import { recordSyncRun } from './syncRunLog.js';
import { logger } from '../utils/logger.js';

const OBJECT_TYPE = 'opportunities';
const PAGE_SIZE = 100;
const MAX_PAGES = 500;   // 50 000 opps per sweep

export async function syncOpportunitiesForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();

  const cursor = await getCursor(locationId, OBJECT_TYPE);
  const { windowStart, windowEnd } = computeWindow(cursor, startedAt);

  let upserted = 0;
  let deleted = 0;
  let startAfterId = null;
  let startAfter = null;
  // Every id GHL returned, whatever its updatedAt — the delete reconcile
  // below needs the whole live set, not just the window's changes. A Set:
  // a cursor that fails to advance returns the same page again, and the
  // repeats must not count as progress.
  const seenIds = new Set();
  // A walk that stopped early (page failure, page cap) has not seen
  // everything, and "not seen" must not become "deleted".
  let truncated = false;

  try {
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        location_id: locationId,
        limit: String(PAGE_SIZE)
      });
      if (startAfterId) params.set('startAfterId', startAfterId);
      if (startAfter)   params.set('startAfter', String(startAfter));

      let data;
      try {
        const resp = await ghlRequest(install, {
          method: 'GET',
          url: `/opportunities/search?${params.toString()}`
        });
        data = resp.data;
      } catch (err) {
        logger.warn(
          { locationId, page, err, status: err.response?.status },
          'opportunitiesSync: page fetch failed — stopping'
        );
        truncated = true;
        break;
      }

      const opps = Array.isArray(data?.opportunities) ? data.opportunities : [];
      if (opps.length === 0) break;

      // CYCLE GUARD. A page with nothing new means the cursor is not moving
      // and the next 499 pages would be this one again — which is how one
      // location walked 50,000 rows for 1,500 deals, hit the page cap, and
      // lost its delete reconciliation. Stop here and say so.
      const before = seenIds.size;
      for (const raw of opps) if (raw?.id) seenIds.add(raw.id);
      if (seenIds.size === before) {
        logger.warn({ locationId, page, startAfterId, startAfter },
          'opportunitiesSync: page repeated — cursor not advancing, stopping');
        truncated = true;
        break;
      }

      for (const raw of opps) {
        const updated = raw.updatedAt || raw.createdAt;
        const ts = updated ? new Date(updated) : null;
        if (ts && ts < windowStart) continue;

        try {
          const syntheticEvent = {
            type: 'opportunity_updated',
            locationId,
            opportunity: raw,
            opportunityId: raw.id,
            contactId: raw.contactId,
            timestamp: raw.updatedAt || raw.createdAt || new Date().toISOString(),
            _fromSync: true
          };
          await handleOpportunityEvent(install, 'opportunity_updated', syntheticEvent);
          upserted++;
        } catch (err) {
          logger.warn(
            { locationId, opportunityId: raw?.id, err },
            'opportunitiesSync: opp dispatch failed — skipped'
          );
        }
      }

      // The NEXT cursor, as GHL hands it back. The search endpoint returns
      // meta.startAfterId / meta.startAfter for exactly this; deriving the
      // cursor from the last row's updatedAt assumed the list was sorted by
      // updatedAt, and when it is not the cursor points sideways and the
      // same page comes back. The derived value stays as the fallback for a
      // response that carries no meta.
      const meta = data?.meta || {};
      const last = opps[opps.length - 1];
      startAfterId = meta.startAfterId || last?.id || null;
      startAfter   = meta.startAfter != null ? meta.startAfter
                    : last?.updatedAt ? new Date(last.updatedAt).getTime()
                    : last?.createdAt ? new Date(last.createdAt).getTime()
                    : null;
      if (opps.length < PAGE_SIZE) break;
      if (meta.nextPage === null && meta.nextPageUrl === null) break;
    }
    if (page >= MAX_PAGES) truncated = true;

    deleted = await reconcileDeletedOpportunities(install, [...seenIds], truncated);

    await advanceCursor(locationId, OBJECT_TYPE, windowEnd);

    logger.info({ locationId, upserted, deleted, windowStart, windowEnd }, 'opportunitiesSync: location synced');
    await recordSyncRun({
      jobName: 'opportunitiesSync', objectType: OBJECT_TYPE,
      locationId, scope: 'location', status: 'success',
      startedAt, finishedAt: new Date(),
      windowStart, windowEnd,
      stats: { upserted, deleted }
    });
    return { upserted, deleted };
  } catch (err) {
    logger.error({ locationId, err }, 'opportunitiesSync: location failed');
    await recordSyncRun({
      jobName: 'opportunitiesSync', objectType: OBJECT_TYPE,
      locationId, scope: 'location', status: 'failed',
      startedAt, finishedAt: new Date(),
      windowStart, windowEnd,
      stats: { upserted }, error: err.message
    });
    return { upserted, error: err.message };
  }
}

// Soft-delete, locally, every live deal GHL no longer lists.
//
// Goes through handleOpportunityEvent as a synthetic OpportunityDelete rather
// than a bare UPDATE, so the open stage_history row is closed the same way a
// real delete closes it and nothing downstream can tell the difference.
async function reconcileDeletedOpportunities(install, seenIds, truncated) {
  const locationId = install.location_id;
  const verdict = shouldReconcileDeletes({ seenCount: seenIds.length, truncated });
  if (!verdict.reconcile) {
    logger.warn(
      { locationId, seenCount: seenIds.length, truncated, reason: verdict.reason },
      'opportunitiesSync: skipping delete reconciliation'
    );
    return 0;
  }

  const { rows } = await rawQuery(
    `SELECT opportunity_id, contact_id FROM opportunities
      WHERE location_id = $1
        AND is_deleted = false AND deleted_at IS NULL
        AND NOT (opportunity_id = ANY($2::text[]))`,
    [locationId, seenIds]
  );
  if (!rows.length) return 0;

  // A second guard, ours: if GHL's list is missing MOST of what we hold, the
  // listing is more likely wrong (a permission change, a half-failed page)
  // than half the pipeline deleted overnight. Log and leave it for a human.
  const { rows: [{ live }] } = await rawQuery(
    `SELECT count(*)::int AS live FROM opportunities
      WHERE location_id = $1 AND is_deleted = false AND deleted_at IS NULL`,
    [locationId]
  );
  if (rows.length > 25 && rows.length > live / 2) {
    logger.error(
      { locationId, missing: rows.length, live, seen: seenIds.length },
      'opportunitiesSync: refusing to delete — more than half the local deals are missing from GHL\'s list'
    );
    return 0;
  }

  // Absent from the list is the SIGNAL; GHL's own answer for the record is
  // the PROOF. One GET per candidate (they are few) and only a 404 deletes —
  // a deal the listing skipped for any other reason is left alone and named
  // in the log.
  let deleted = 0;
  const kept = [];
  for (const r of rows) {
    const verdict = await probeOpportunity(install, r.opportunity_id);
    if (verdict !== 'gone') { kept.push({ id: r.opportunity_id, verdict }); continue; }
    const ok = await markOpportunityDeletedLocally(install, r.opportunity_id, {
      contactId: r.contact_id, via: 'opportunitiesSync'
    });
    if (ok) deleted++;
  }
  if (kept.length) {
    logger.warn({ locationId, kept },
      'opportunitiesSync: deals missing from the list but not confirmed gone by GHL — left live');
  }
  if (deleted) {
    logger.info({ locationId, deleted, ids: rows.map((r) => r.opportunity_id) },
      'opportunitiesSync: deals missing from GHL marked deleted');
  }
  return deleted;
}

/**
 * Ask GHL directly whether a deal still exists.
 *
 * @returns {Promise<'present'|'gone'|'unknown'>} 'gone' only on a 404 —
 *   anything else (a 5xx, a timeout, a 401) is 'unknown', and unknown never
 *   deletes.
 */
export async function probeOpportunity(install, opportunityId) {
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/opportunities/${encodeURIComponent(opportunityId)}`
    });
    const opp = data?.opportunity || data;
    return opp && opp.id ? 'present' : 'gone';
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return 'gone';
    logger.warn({ locationId: install.location_id, opportunityId, status, err },
      'opportunitiesSync: probe failed — treating as unknown');
    return 'unknown';
  }
}

/**
 * Record that GHL no longer has this deal — the same write a real
 * OpportunityDelete webhook performs. Called by the sweep above and by the
 * opportunity write path when GHL answers 404, so a deal found to be gone
 * is marked gone the moment anyone notices rather than at the next sweep.
 *
 * Never throws. Returns true when the row was marked.
 */
export async function markOpportunityDeletedLocally(install, opportunityId, { contactId = null, via = 'unknown' } = {}) {
  const locationId = install.location_id;
  try {
    let cid = contactId;
    if (!cid) {
      const { rows } = await rawQuery(
        `SELECT contact_id FROM opportunities WHERE location_id = $1 AND opportunity_id = $2`,
        [locationId, opportunityId]
      );
      if (!rows.length) return false;
      cid = rows[0].contact_id;
    }
    if (cid) {
      await handleOpportunityEvent(install, 'opportunity_deleted', {
        type: 'opportunity_deleted',
        locationId,
        id: opportunityId,
        opportunityId,
        contactId: cid,
        timestamp: new Date().toISOString(),
        _fromSync: true,
        _via: via
      });
    } else {
      // No contact on the row: the writer would drop the event, so mark the
      // deal directly. The stage row stays as it is — there is no contact to
      // close it against, and the deal is already excluded everywhere by
      // is_deleted.
      await rawQuery(
        `UPDATE opportunities
            SET is_deleted = true, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
          WHERE location_id = $1 AND opportunity_id = $2`,
        [locationId, opportunityId]
      );
    }
    logger.info({ locationId, opportunityId, via }, 'opportunities: deal marked deleted locally');
    return true;
  } catch (err) {
    logger.warn({ err, locationId, opportunityId, via }, 'opportunities: could not mark deal deleted locally');
    return false;
  }
}

export async function syncOpportunitiesForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('opportunitiesSync: no active installs — skipping');
    return { locations: 0 };
  }

  let totalUpserted = 0;
  let totalDeleted = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { upserted, deleted, error } = await syncOpportunitiesForLocation(install);
    totalUpserted += upserted || 0;
    totalDeleted += deleted || 0;
    if (error) locationsFailed++;
  }

  logger.info(
    { locations: rows.length, totalUpserted, totalDeleted, locationsFailed },
    'opportunitiesSync: complete'
  );
  await recordSyncRun({
    jobName: 'opportunitiesSync', objectType: OBJECT_TYPE,
    scope: 'all',
    status: locationsFailed === 0 ? 'success' : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt, finishedAt: new Date(),
    stats: { locations: rows.length, totalUpserted, totalDeleted, locationsFailed }
  });
  return { locations: rows.length, totalUpserted, totalDeleted };
}
