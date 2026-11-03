#!/usr/bin/env node
//
// Sweep pass — fetch recording URLs + transcriptions for every is_call=true
// message we don't already have a row for. Never retries on error except
// 429 (handled transparently by ghlClient's axios-retry).
//
// Usage:
//   node src/scripts/syncCallRecordings.js                # all installs
//   node src/scripts/syncCallRecordings.js <location_id>  # one install
//
// To force a re-attempt on a failed row, DELETE the row from call_recordings
// or call_transcriptions manually — the candidate query will re-pick it up.

import { syncCallMediaForLocation, syncCallMediaForAllInstalls } from '../services/callRecordingSync.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { logger } from '../utils/logger.js';

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const install = await getActiveInstall(arg);
    if (!install) { console.error(`No active install for ${arg}`); process.exit(1); }
    const result = await syncCallMediaForLocation(install);
    console.log(JSON.stringify({ location_id: arg, ...result }, null, 2));
  } else {
    const result = await syncCallMediaForAllInstalls();
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'syncCallRecordings: fatal'); process.exit(1); });
