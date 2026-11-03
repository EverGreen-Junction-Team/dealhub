#!/usr/bin/env node
//
// Print a ready-to-paste curl for GET /users/{userId}, with a FRESH token.
//
// Usage:
//   node src/scripts/userCurl.js <location_id> [user_id]
//
// Without a user_id it uses the location's own installed-user id — the one
// the session mints, which is what the Co-Pilot sidebar's avatar looks up.
//
// Why a script rather than a hand-written token: ghlRequest refreshes the
// access token when it is close to expiry, so whatever is sitting in the
// install row may already be dead. This makes a REAL call through that path
// first, which both refreshes the row and proves the token works — then
// prints the curl using the token the app would itself send.

import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import { config } from '../config.js';

async function main() {
  const [locationId, userIdArg] = process.argv.slice(2);
  if (!locationId) {
    console.error('Usage: node src/scripts/userCurl.js <location_id> [user_id]');
    process.exit(1);
  }

  const install = await getActiveInstall(locationId);
  if (!install) {
    console.error(`No active install for ${locationId}`);
    process.exit(1);
  }

  const userId = userIdArg || install.user_id;
  if (!userId) {
    console.error('No user id on the install — pass one explicitly.');
    process.exit(1);
  }

  // The call itself, so the token is refreshed and verified before it is
  // printed. A curl built from a dead token looks like an API problem.
  let live = null;
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/users/${encodeURIComponent(userId)}`
    });
    live = data?.user || data || null;
    console.log('// Request succeeded. Response:');
    console.log(`// ${JSON.stringify(live)}`);
  } catch (err) {
    console.log(`// Request FAILED: ${err.response?.status || ''} ${err.message}`);
    console.log('// The curl below still uses a refreshed token — run it to see the raw error.');
  }
  console.log('');

  // Re-read the row: ghlRequest writes the refreshed token back to it.
  const after = await getActiveInstall(locationId);

  console.log(`curl --request GET \\
  --url '${config.ghl.apiBaseUrl}/users/${encodeURIComponent(userId)}' \\
  --header 'Authorization: Bearer ${after.access_token}' \\
  --header 'Version: ${config.ghl.apiVersion}' \\
  --header 'Accept: application/json'`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
