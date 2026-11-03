// businessesSync.js — daily catalogue sync for the `businesses` table.
//
// GHL fires no webhooks for businesses: nothing arrives when one is created,
// renamed or deleted. Full daily reconciliation is the only reliable path —
// same pattern as tagsSync / customFieldsSync / pipelinesSync.
//
// Source: GET /businesses/?locationId=X (API version 2021-04-15). The ten
// "Company Info" fields GHL shows as custom fields on the Business object come
// back as native properties, so they map straight onto columns.
//
// Deletes are soft. A business that vanishes from GHL is marked
// is_active = false rather than removed, because contacts still carry its
// business_id and a hard delete would strip the link with no way to explain a
// suddenly-empty page.
//
// Idempotent: re-running is safe, renames propagate through the UPSERT.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';
import { shouldReconcileDeletes } from './businessesReconcile.js';

// GHL's documented default is 100. Kept explicit so a change to their default
// can't silently halve our page size.
const PAGE_SIZE = 100;

// Guard against an unbounded loop if the endpoint ever ignores `skip` and keeps
// returning a full page — 200 pages is 20k businesses, far beyond any real
// sub-account.
const MAX_PAGES = 200;

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function upsertBusiness(locationId, biz) {
  const businessId = biz?.id || biz?._id;
  if (!businessId) return false;

  await rawQuery(
    `INSERT INTO businesses (
       location_id, business_id, name, description, website, email, phone,
       address, city, state, postal_code, country,
       domain_name, company_logo,
       created_by, updated_by, raw_business, is_active,
       created_at_ghl, updated_at_ghl, last_synced_at, imported_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14,
       $15, $16, $17, true,
       $18, $19, now(), now(), now()
     )
     ON CONFLICT (location_id, business_id) DO UPDATE SET
       name           = EXCLUDED.name,
       description    = EXCLUDED.description,
       website        = EXCLUDED.website,
       email          = EXCLUDED.email,
       phone          = EXCLUDED.phone,
       address        = EXCLUDED.address,
       city           = EXCLUDED.city,
       state          = EXCLUDED.state,
       postal_code    = EXCLUDED.postal_code,
       country        = EXCLUDED.country,
       -- Promoted out of raw_business by migration 059. Assigned outright, not
       -- COALESCEd: clearing a domain in GHL must clear it here.
       domain_name    = EXCLUDED.domain_name,
       company_logo   = EXCLUDED.company_logo,
       created_by     = EXCLUDED.created_by,
       updated_by     = EXCLUDED.updated_by,
       raw_business   = EXCLUDED.raw_business,
       -- Resurrect a business that came back in GHL after being soft-deleted.
       is_active      = true,
       created_at_ghl = EXCLUDED.created_at_ghl,
       updated_at_ghl = EXCLUDED.updated_at_ghl,
       last_synced_at = now(),
       updated_at     = now()`,
    [
      locationId,
      businessId,
      biz.name ?? null,
      biz.description ?? null,
      biz.website ?? null,
      biz.email ?? null,
      biz.phone ?? null,
      biz.address ?? null,
      biz.city ?? null,
      biz.state ?? null,
      // GHL's field is postalCode; snake_case checked too in case the shape
      // differs between the list and detail endpoints.
      biz.postalCode ?? biz.postal_code ?? null,
      biz.country ?? null,
      // Both documented on the business DTO but never stored until migration
      // 059. Without them here the nightly sync would blank whatever an edit
      // through this app had just written.
      biz.domainname ?? biz.domainName ?? null,
      Array.isArray(biz.companylogo) && biz.companylogo.length
        ? JSON.stringify(biz.companylogo)
        : null,
      biz.createdBy ? JSON.stringify(biz.createdBy) : null,
      biz.updatedBy ? JSON.stringify(biz.updatedBy) : null,
      JSON.stringify(biz),
      toTimestamp(biz.createdAt),
      toTimestamp(biz.updatedAt)
    ]
  );
  return true;
}

// Mark every business we did NOT see this run as inactive.
//
// Only runs on a fully successful page walk with a NON-EMPTY list. A partial
// list would deactivate businesses that are perfectly fine; an empty one would
// deactivate all of them, since NOT (id = ANY('{}')) matches every row. The
// caller enforces both preconditions.
async function deactivateMissing(locationId, seenIds) {
  const { rows } = await rawQuery(
    `UPDATE businesses
        SET is_active = false, updated_at = now()
      WHERE location_id = $1
        AND is_active = true
        AND NOT (business_id = ANY($2::text[]))
      RETURNING business_id`,
    [locationId, seenIds]
  );
  return rows.length;
}

// Sync one location, walking every page.
export async function syncBusinessesForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();
  const seenIds = [];
  let pages = 0;
  let truncated = false;

  try {
    for (let skip = 0; ; skip += PAGE_SIZE) {
      if (pages >= MAX_PAGES) {
        truncated = true;
        logger.warn({ locationId, pages }, 'businessesSync: hit page cap — list truncated');
        break;
      }

      const { data } = await ghlRequest(install, {
        method: 'GET',
        url: '/businesses/',
        params: { locationId, limit: String(PAGE_SIZE), skip: String(skip) }
      });

      const batch = Array.isArray(data?.businesses) ? data.businesses
        : (Array.isArray(data) ? data : []);
      pages++;

      for (const biz of batch) {
        const wrote = await upsertBusiness(locationId, biz);
        if (wrote) seenIds.push(biz.id || biz._id);
      }

      // A short page means the last page. An empty one means we're past the end.
      if (batch.length < PAGE_SIZE) break;
    }

    const decision = shouldReconcileDeletes({ seenCount: seenIds.length, truncated });
    let deactivated = 0;
    if (decision.reconcile) {
      deactivated = await deactivateMissing(locationId, seenIds);
    } else {
      logger.warn({ locationId, reason: decision.reason },
        'businessesSync: skipping delete reconciliation');
    }

    logger.info(
      { locationId, synced: seenIds.length, deactivated, pages, truncated },
      'businessesSync: location synced'
    );
    await recordSyncRun({
      jobName: 'businessesSync', objectType: 'businesses',
      locationId, scope: 'location',
      status: truncated ? 'partial' : 'success',
      startedAt,
      stats: { synced: seenIds.length, deactivated, pages, truncated }
    });
    return { synced: seenIds.length, deactivated };
  } catch (err) {
    const status = err.response?.status;

    // 401/403 almost certainly means the install predates the
    // `businesses.readonly` scope — the app has to be reauthorised, which no
    // amount of retrying fixes. Say so explicitly rather than logging an
    // opaque auth failure once a day forever.
    const scopeIssue = status === 401 || status === 403;
    logger.warn(
      {
        err, locationId, status,
        hint: scopeIssue
          ? 'businesses.readonly scope missing — reauthorise the app for this location'
          : undefined
      },
      'businessesSync: location failed'
    );
    await recordSyncRun({
      jobName: 'businessesSync', objectType: 'businesses',
      locationId, scope: 'location', status: 'failed',
      startedAt, error: scopeIssue ? `${err.message} (businesses.readonly scope?)` : err.message
    });
    // Partial page walk: leave is_active alone. Deactivating from an
    // incomplete list would empty the Businesses page on a transient 500.
    return { synced: 0, error: err.message };
  }
}

// Sync every active install. Called from the daily cron. One location failing
// doesn't stop the others.
export async function syncBusinessesForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('businessesSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'businessesSync', objectType: 'businesses',
      scope: 'all', status: 'success', startedAt,
      stats: { locations: 0, businessesSynced: 0 }
    });
    return { locations: 0, businessesSynced: 0 };
  }

  let totalSynced = 0;
  let totalDeactivated = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { synced, deactivated, error } = await syncBusinessesForLocation(install);
    totalSynced += synced;
    totalDeactivated += deactivated || 0;
    if (error) locationsFailed++;
  }

  logger.info(
    {
      locations: rows.length, businessesSynced: totalSynced,
      deactivated: totalDeactivated, locationsFailed,
      durationMs: Date.now() - startedAt.getTime()
    },
    'businessesSync: complete'
  );
  await recordSyncRun({
    jobName: 'businessesSync', objectType: 'businesses',
    scope: 'all',
    status: locationsFailed === 0
      ? 'success'
      : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt,
    stats: {
      locations: rows.length, businessesSynced: totalSynced,
      deactivated: totalDeactivated, locationsFailed
    }
  });
  return { locations: rows.length, businessesSynced: totalSynced };
}
