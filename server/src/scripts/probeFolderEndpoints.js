#!/usr/bin/env node
//
// Which endpoint returns custom-field FOLDER names?
//
// /custom-fields/object-key/:objectKey answers:
//   400 "Api does not support objectKey of type contact or opportunity"
//
// so that route is for CUSTOM OBJECTS, not the standard contact/opportunity
// fields. Folder names have to come from somewhere else — and rather than
// guess a third time, this asks the live API and prints what comes back.
//
// Read-only: every call is a GET.
//
//   node src/scripts/probeFolderEndpoints.js <location_id>

import { ghlRequest } from '../services/ghlClient.js';
import { getActiveInstall } from '../services/ghlClient.js';

const CANDIDATES = (loc) => ([
  // The v1 field list we already use — does it carry folders alongside?
  ['old field list (contact)', `/locations/${loc}/customFields?model=contact`],
  // Documented for custom objects; 400s for contact/opportunity.
  ['object-key (contact)', `/custom-fields/object-key/contact?locationId=${loc}`],
  // Plausible folder routes.
  ['customFields/folders', `/locations/${loc}/customFields/folders`],
  ['custom-fields/folders', `/custom-fields/folders?locationId=${loc}`],
  ['customFieldFolders', `/locations/${loc}/customFieldFolders`],
  ['object-key contact.folder', `/custom-fields/object-key/contact.folder?locationId=${loc}`]
]);

async function probe(install, label, url) {
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET', url, scopeOptional: true
    });
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    const folders = Array.isArray(data?.folders) ? data.folders : null;
    console.log(`\n  OK   ${label}`);
    console.log(`       ${url}`);
    console.log(`       top-level keys: ${keys.join(', ') || '(none)'}`);
    if (folders) {
      console.log(`       folders: ${folders.length}`);
      for (const f of folders.slice(0, 5)) {
        console.log(`         - ${f.id}  ${JSON.stringify(f.name || f.label || '')}`);
      }
    }
    // Does any field row carry a parent, and is there a name anywhere?
    const rows = Array.isArray(data?.customFields) ? data.customFields
      : Array.isArray(data?.fields) ? data.fields : [];
    if (rows.length) {
      const sample = rows[0];
      console.log(`       field rows: ${rows.length}`);
      console.log(`       sample keys: ${Object.keys(sample).join(', ')}`);
      const withParent = rows.filter((r) => r.parentId || r.folderId).length;
      console.log(`       rows with a parent id: ${withParent}`);
    }
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(`\n  ${String(status || 'ERR').padEnd(4)} ${label}`);
    console.log(`       ${url}`);
    console.log(`       ${typeof body === 'object' ? JSON.stringify(body) : String(body || err.message).slice(0, 160)}`);
  }
}

async function main() {
  const loc = process.argv[2];
  if (!loc) {
    console.error('\nUsage: node src/scripts/probeFolderEndpoints.js <location_id>\n');
    process.exit(1);
  }
  const install = await getActiveInstall(loc);
  if (!install) {
    console.error(`\nNo active install for ${loc}\n`);
    process.exit(1);
  }
  console.log(`\nProbing folder endpoints for ${loc}`);
  for (const [label, url] of CANDIDATES(loc)) {
    await probe(install, label, url);
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
