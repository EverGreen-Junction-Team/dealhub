#!/usr/bin/env node
//
// Runs businessesSync end-to-end — GET /businesses/?locationId=X for every
// active install, UPSERTing into the `businesses` table.
//
// Worth running by hand right after migration 056, so the Businesses page has
// data before the 03:00 cron rather than after it.
//
// If this reports a 401/403, the install predates the `businesses.readonly`
// scope: add it in the marketplace app config and reauthorise. Retrying
// without that won't help.
//
// Usage:
//   node src/scripts/syncBusinesses.js                # all installs
//   node src/scripts/syncBusinesses.js <location_id>  # one location

import { syncBusinessesForLocation, syncBusinessesForAllInstalls } from '../services/businessesSync.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { logger } from '../utils/logger.js';

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const install = await getActiveInstall(arg);
    if (!install) {
      console.error(`No active install for ${arg}`);
      process.exit(1);
    }
    const result = await syncBusinessesForLocation(install);
    console.log(JSON.stringify({ location_id: arg, ...result }, null, 2));
  } else {
    const result = await syncBusinessesForAllInstalls();
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'syncBusinesses: fatal');
    process.exit(1);
  });
