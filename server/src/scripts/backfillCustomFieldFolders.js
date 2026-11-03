#!/usr/bin/env node
//
// Group custom fields into their GHL folders — and say plainly why if it
// cannot.
//
// ═══════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS WHEN THE DAILY SYNC ALREADY DOES IT
// ═══════════════════════════════════════════════════════════════════════
//
// It does, and running `syncCustomFields.js` is enough in the normal case.
// This script is for the situation where the UI still shows every field
// under "Other fields" and it is not obvious which of three things is wrong:
//
//   A. migration 064 has not run       -> no parent_id column to fill
//   B. the folder endpoint failed      -> ids stored, no folder NAMES
//   C. GHL sends no parentId at all    -> nothing to group by
//
// Those need different fixes, and "run the sync again" only helps with B.
// So this reports the state first, then syncs, then reports again — the
// difference tells you which case you are in.
//
// USAGE
//   node src/scripts/backfillCustomFieldFolders.js                 # all
//   node src/scripts/backfillCustomFieldFolders.js <location_id>   # one
//   node src/scripts/backfillCustomFieldFolders.js --check         # report only

import { rawQuery } from '../db.js';
import { syncCustomFieldsForLocation } from '../services/customFieldsSync.js';
import { getActiveInstall } from '../services/ghlClient.js';
import { logger } from '../utils/logger.js';

async function report(locationId, label) {
  const { rows } = await rawQuery(
    `SELECT
       d.object_type,
       count(*)::int                                             AS fields,
       count(*) FILTER (WHERE d.parent_id IS NOT NULL)::int       AS with_parent,
       count(*) FILTER (WHERE d.raw_definition ? 'parentId')::int AS ghl_sent_parent,
       count(*) FILTER (WHERE f.folder_id IS NOT NULL)::int       AS resolves_to_folder
     FROM ghl_custom_field_definitions d
     LEFT JOIN ghl_custom_field_folders f
       ON  f.location_id = d.location_id
       AND f.object_type = d.object_type
       AND f.folder_id   = d.parent_id
       AND f.is_active
     WHERE d.location_id = $1 AND d.is_active
     GROUP BY d.object_type
     ORDER BY d.object_type`,
    [locationId]
  );

  const { rows: folders } = await rawQuery(
    `SELECT object_type, count(*)::int AS n
       FROM ghl_custom_field_folders
      WHERE location_id = $1 AND is_active
      GROUP BY object_type`,
    [locationId]
  );
  const folderCount = Object.fromEntries(folders.map((r) => [r.object_type, r.n]));

  console.log(`\n  ${label}`);
  if (rows.length === 0) {
    console.log('    no active custom field definitions');
    return rows;
  }
  for (const r of rows) {
    console.log(
      `    ${r.object_type.padEnd(12)} fields=${String(r.fields).padStart(3)}`
      + `  with parent_id=${String(r.with_parent).padStart(3)}`
      + `  GHL sent parentId=${String(r.ghl_sent_parent).padStart(3)}`
      + `  folders=${String(folderCount[r.object_type] || 0).padStart(2)}`
      + `  grouped=${String(r.resolves_to_folder).padStart(3)}`
    );
  }
  return rows;
}

// The diagnosis, in the terms the reader needs to act on.
function diagnose(rows) {
  const out = [];
  for (const r of rows) {
    const t = r.object_type;
    if (r.fields === 0) continue;
    if (r.resolves_to_folder === r.fields) {
      out.push(`  OK    ${t}: every field is in a folder.`);
    } else if (r.with_parent === 0 && r.ghl_sent_parent === 0) {
      // Case C — the one no amount of re-running fixes.
      out.push(
        `  ISSUE ${t}: GHL returned no parentId for any field. The folder`
        + ' endpoint may be unavailable for this location, or these fields'
        + ' genuinely sit outside any folder in the CRM. Check the CRM first.'
      );
    } else if (r.with_parent > 0 && r.resolves_to_folder === 0) {
      // Case B — ids stored but no names to render.
      out.push(
        `  ISSUE ${t}: fields carry a folder id but no folder was stored.`
        + ' The folder fetch failed — look for "folder fetch failed" in the'
        + ' logs, and confirm the app has the custom-fields read scope.'
      );
    } else {
      out.push(
        `  PART  ${t}: ${r.resolves_to_folder} of ${r.fields} grouped.`
        + ' The rest sit outside a folder in the CRM and render under'
        + ' "Other fields", which is correct.'
      );
    }
  }
  return out;
}

async function run(locationId) {
  console.log(`\n── ${locationId} ${'─'.repeat(Math.max(0, 46 - locationId.length))}`);
  const before = await report(locationId, 'before');

  const install = await getActiveInstall(locationId);
  if (!install) {
    console.log('    SKIPPED — no active install for this location');
    return;
  }

  console.log('\n    syncing…');
  await syncCustomFieldsForLocation(install);

  const after = await report(locationId, 'after');
  console.log('');
  for (const line of diagnose(after)) console.log(line);

  // The whole point of running it: did anything change?
  const gained = after.reduce((n, r) => n + r.resolves_to_folder, 0)
    - before.reduce((n, r) => n + r.resolves_to_folder, 0);
  if (gained > 0) console.log(`\n  ${gained} field(s) newly grouped.`);
  else if (before.length) console.log('\n  No change from this run.');
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const target = args.find((a) => !a.startsWith('--'));

  // Migration 064 adds these. Checking first turns case A from a confusing
  // "0 grouped" into a one-line instruction.
  const { rows: cols } = await rawQuery(
    `SELECT
       to_regclass('public.ghl_custom_field_folders') IS NOT NULL AS has_folders,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ghl_custom_field_definitions'
            AND column_name = 'parent_id'
       ) AS has_parent_id`
  );
  if (!cols[0].has_folders || !cols[0].has_parent_id) {
    console.error(
      '\nMigration 064 has not been applied — there is no folders table or'
      + '\nparent_id column to fill. Run `npm run migrate` first.\n'
    );
    process.exit(1);
  }

  let locations = [];
  if (target) {
    locations = [target];
  } else {
    const { rows } = await rawQuery(
      `SELECT location_id FROM installs
        WHERE uninstalled_at IS NULL
        ORDER BY location_id`
    );
    locations = rows.map((r) => r.location_id);
  }

  if (checkOnly) {
    for (const loc of locations) {
      console.log(`\n── ${loc} ──`);
      const rows = await report(loc, 'current');
      console.log('');
      for (const line of diagnose(rows)) console.log(line);
    }
  } else {
    for (const loc of locations) await run(loc);
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'backfillCustomFieldFolders: failed');
    process.exit(1);
  });
