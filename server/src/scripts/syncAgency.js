#!/usr/bin/env node
//
// Re-sync the sub-accounts an AGENCY install covers.
//
//   npm run sync:agency -- <company_id>
//
// Mints a token for every sub-account the agency has the app enabled on
// that we do not already hold, and marks uninstalled any agency-minted row
// whose sub-account was removed. The OAuth callback does this once at
// install time and INSTALL webhooks cover additions; this is for when one
// was missed, or after setting GHL_APP_ID for the first time.

import 'dotenv/config';
import { pool } from '../db.js';
import { syncAgencyLocations, getAgencyInstall } from '../services/agencyInstall.js';

async function main() {
  const [companyId] = process.argv.slice(2);
  if (!companyId) { console.log('usage: npm run sync:agency -- <company_id>'); return; }
  const agency = await getAgencyInstall(companyId);
  if (!agency) { console.log(`${companyId}: no active agency install — install the app at agency level first`); return; }
  const r = await syncAgencyLocations(companyId);
  console.log(`${companyId}: ${r.wanted} enabled, ${r.minted} minted, ${r.kept} already connected, ${r.removed} removed` +
    (r.failed.length ? `, failed: ${r.failed.join(', ')}` : ''));
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
