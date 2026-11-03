#!/usr/bin/env node
//
// One-time (or any-time) user sync via GET /users/search, for every active
// install — or one location.
//
//   npm run sync:users                      # every active install
//   npm run sync:users -- <location_id>     # one location
//
// Writes the full record per user: name, email, role, agency/account type,
// sub-account membership (roles.locationIds), the agency id (company_id) and
// two-way email sync. This is the SAME function the nightly cron runs
// (orphanSweep → syncUsersForAllInstalls) and the Control panel's
// Users → Sync now button runs for one location — so running it by hand
// after a migration, or after changing a rep's role in GHL, gives the same
// result the next night would.
//
// Supersedes syncUserRoles.js, which read GET /users/{id} per user and knew
// nothing about company_id or twoWaySync.

import 'dotenv/config';
import { pool } from '../db.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { backfillUsersForLocation } from '../services/userWriter.js';
import { syncUsersForAllInstalls } from '../services/usersSync.js';

async function main() {
  const [locationId] = process.argv.slice(2);
  if (locationId) {
    const install = await getActiveInstall(locationId);
    if (!install) { console.log(`${locationId}: no active install`); return; }
    const { count } = await backfillUsersForLocation(install);
    console.log(`${locationId}: ${count} users synced`);
    return;
  }
  const r = await syncUsersForAllInstalls();
  console.log(`${r.locations} locations, ${r.totalUsers} users synced` +
    (r.locationsFailed ? `, ${r.locationsFailed} location(s) failed — see log` : ''));
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
