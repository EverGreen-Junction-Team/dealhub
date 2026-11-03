// cpAlloSyncUsers.js — Allo users → call_user_map (auto, matched by email).
//
//   npm run cp:allo:sync-users -- --location <locationId>
//
// Prints who matched and who did not. Unmatched Allo users need a manual
// row (PUT /api/calls/user-map) or a matching email on the GHL user.

import { pool } from '../db.js';
import { syncProviderUsers } from '../conversationPoint/userSync.js';

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const locationId = arg('location');
  if (!locationId) throw new Error('--location <locationId> is required');
  const r = await syncProviderUsers(locationId, 'allo');
  console.log(`Allo users: ${r.remote}, matched to GHL by email: ${r.matched}, map rows written: ${r.written}`);
  if (r.unmatched.length) {
    console.log('Unmatched (no GHL user with this email):');
    for (const u of r.unmatched) console.log(`  ${u.id}  ${u.email || '(no email)'}  ${u.name || ''}`);
  }
}

main()
  .catch((err) => { console.error(err.message, err.body || ''); process.exitCode = 1; })
  .finally(() => pool.end());
