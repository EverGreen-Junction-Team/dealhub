#!/usr/bin/env node
//
// Daily catalogue sync for conversation_providers. Idempotent — safe to
// re-run mid-day if a new provider was added. Bolted onto the existing
// daily sync entry (whichever schedule runs contactsSync / tagsSync /
// pipelinesSync).
//
// Usage:
//   node src/scripts/syncConversationProviders.js               # all installs
//   node src/scripts/syncConversationProviders.js <location_id> # one install

import { syncConversationProvidersForLocation, syncConversationProvidersAllInstalls } from '../services/conversationProvidersSync.js';
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
    const result = await syncConversationProvidersForLocation(install);
    console.log(JSON.stringify({ location_id: arg, ...result }, null, 2));
  } else {
    const result = await syncConversationProvidersAllInstalls();
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'syncConversationProviders: fatal');
    process.exit(1);
  });
