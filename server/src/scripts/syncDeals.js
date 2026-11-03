#!/usr/bin/env node
//
// One-time (or any-time) deals sweep, for every active install — or one
// location.
//
//   npm run sync:deals                                   # every active install
//   npm run sync:deals -- <location_id>                  # one location
//   npm run sync:deals -- <location_id> --probe <deal_id> # ask GHL about ONE deal
//
// --probe asks GHL directly whether that deal still exists and, on a 404,
// marks it deleted here. For the deal that the sweep did not catch because
// GHL's search still lists it while the record itself is gone.
//
// The SAME function the nightly cron runs (orphanSweep →
// syncOpportunitiesForAllInstalls) and the Control panel's Deals → Sync now
// button runs for one location: refreshes every deal GHL lists, and marks
// deleted every live local deal GHL no longer returns (see
// opportunitiesSync.js, "DELETIONS"). Run it by hand when a deal deleted in
// GHL is still showing here and you do not want to wait for tonight.

import 'dotenv/config';
import { pool } from '../db.js';
import { getActiveInstall } from '../services/ghlClient.js';
import {
  syncOpportunitiesForLocation, syncOpportunitiesForAllInstalls,
  probeOpportunity, markOpportunityDeletedLocally
} from '../services/opportunitiesSync.js';

async function main() {
  const args = process.argv.slice(2);
  const probeAt = args.indexOf('--probe');
  const probeId = probeAt >= 0 ? args[probeAt + 1] : null;
  const [locationId] = args.filter((a, i) => a !== '--probe' && i !== probeAt + 1);
  if (locationId) {
    const install = await getActiveInstall(locationId);
    if (!install) { console.log(`${locationId}: no active install`); return; }
    if (probeId) {
      const verdict = await probeOpportunity(install, probeId);
      if (verdict === 'gone') {
        const ok = await markOpportunityDeletedLocally(install, probeId, { via: 'sync:deals --probe' });
        console.log(`${probeId}: GHL says gone (404) — ${ok ? 'marked deleted here' : 'could not mark locally, see log'}`);
      } else {
        console.log(`${probeId}: GHL says ${verdict} — left as is`);
      }
      return;
    }
    const r = await syncOpportunitiesForLocation(install);
    console.log(`${locationId}: ${r.upserted} deals refreshed, ${r.deleted || 0} marked deleted` +
      (r.error ? ` — failed: ${r.error}` : ''));
    return;
  }
  const r = await syncOpportunitiesForAllInstalls();
  console.log(`${r.locations} locations, ${r.totalUpserted} deals refreshed` +
    (r.totalDeleted != null ? `, ${r.totalDeleted} marked deleted` : ''));
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
