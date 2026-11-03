#!/usr/bin/env node
//
// Runs customFieldsSync end-to-end. After migration 045 this fetches BOTH
// model=contact AND model=opportunity per location, populating
// ghl_custom_field_definitions with all 21 opportunity fields that were
// previously missing (audit v2, D1).
//
// Usage:
//   node src/scripts/syncCustomFields.js                # all installs
//   node src/scripts/syncCustomFields.js <location_id>  # one location

import { syncCustomFieldsForLocation, syncCustomFieldsForAllInstalls } from '../services/customFieldsSync.js';
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
    const result = await syncCustomFieldsForLocation(install);
    console.log(JSON.stringify({ location_id: arg, ...result }, null, 2));
  } else {
    const result = await syncCustomFieldsForAllInstalls();
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'syncCustomFields: fatal');
    process.exit(1);
  });
