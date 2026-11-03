#!/usr/bin/env node
//
// SUPERSEDED by syncUsers.js (npm run sync:users), which reads GET
// /users/search and also stores company_id and two-way email sync. This
// script's own UPSERT writes neither, so running it after migration 140
// leaves those columns empty. Kept for the one case search cannot cover:
// an install with no company_id, where GET /users/{id} still answers.
//
// Fetch GET /users/{id} per user and store roles.type, roles.role and
// roles.locationIds.
//
// Usage:
//   node src/scripts/syncUserRoles.js                          # every active install
//   node src/scripts/syncUserRoles.js <location_id>            # one location
//   node src/scripts/syncUserRoles.js <location_id> <user_id>  # one user, even
//                                                              # if not a member
//
// ── WHY A SEPARATE SCRIPT ────────────────────────────────────────────
//
// backfillUsersForLocation reads GET /users/?locationId=…, which returns only
// users who are MEMBERS of that sub-account. An agency admin who owns the
// location is absent from it — so no row is ever written for them, and
// nothing in our database can answer "what is this person's name?".
//
// That is not hypothetical: the Deal hub's Co-Pilot sidebar resolves the
// signed-in user's name by matching their id against that same list, and for
// an agency user it came back null and the avatar rendered as a bare dot.
//
// GET /users/{id} answers for ANY user the token can see, member or not, and
// it is the only call that carries roles.locationIds.

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import { logger } from '../utils/logger.js';

// The three fields this exists to capture, read exactly as userWriter reads
// them — both the object GHL sends and the array an older writer expected.
function rolesOf(payload) {
  const roles = payload?.roles;
  const obj = roles && !Array.isArray(roles) && typeof roles === 'object' ? roles : null;
  const first = Array.isArray(roles) ? roles[0] : null;
  const src = obj || first || null;
  const ids = src?.locationIds;
  return {
    userType: src?.type || null,
    role: src?.role || null,
    // NULL, not [], when the payload said nothing — "attached to nowhere" is
    // a different claim from "no list was sent".
    locationIds: Array.isArray(ids)
      ? ids.filter((id) => typeof id === 'string' && id)
      : null
  };
}

// One location's users. Returns { updated, failed, total } so the all-installs
// loop can total them without re-reading anything.
async function syncLocation(locationId, oneUserId) {
  const install = await getActiveInstall(locationId);
  if (!install) {
    console.log(`  ${locationId}: no active install, skipped`);
    return { updated: 0, failed: 0, total: 0 };
  }

  let ids;
  if (oneUserId) {
    ids = [oneUserId];
  } else {
    const { rows } = await rawQuery(
      `SELECT user_id FROM users WHERE location_id = $1 ORDER BY user_id`,
      [locationId]
    );
    ids = rows.map((r) => r.user_id);
    // The INSTALLING user too, who may not be a member of the sub-account —
    // the case this script exists for.
    if (install.user_id && !ids.includes(install.user_id)) ids.push(install.user_id);
  }

  if (ids.length === 0) {
    console.log(`  ${locationId}: no users to sync`);
    return { updated: 0, failed: 0, total: 0 };
  }

  let updated = 0;
  let removed = 0;
  let failed = 0;
  for (const userId of ids) {
    try {
      const { data } = await ghlRequest(install, {
        method: 'GET',
        url: `/users/${encodeURIComponent(userId)}`
      });
      const payload = data?.user || data;
      if (!payload?.id) { failed++; continue; }
      const { userType, role, locationIds } = rolesOf(payload);

      // UPSERT, not UPDATE: a user absent from the location's own list has no
      // row yet, and that absence is the whole problem.
      //
      // COALESCE on the way in, matching userWriter — a payload that omits a
      // field must not blank one we already hold.
      await rawQuery(
        `INSERT INTO users (
           location_id, user_id, name, email, role, user_type, location_ids,
           active, raw_user, imported_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, true, $8, now(), now())
         ON CONFLICT (location_id, user_id) DO UPDATE SET
           name         = COALESCE(EXCLUDED.name, users.name),
           email        = COALESCE(EXCLUDED.email, users.email),
           role         = COALESCE(EXCLUDED.role, users.role),
           user_type    = COALESCE(EXCLUDED.user_type, users.user_type),
           location_ids = COALESCE(EXCLUDED.location_ids, users.location_ids),
           raw_user     = EXCLUDED.raw_user,
           updated_at   = now()`,
        [
          locationId, payload.id,
          payload.name || [payload.firstName, payload.lastName].filter(Boolean).join(' ') || null,
          payload.email || null,
          role, userType, locationIds,
          payload
        ]
      );
      updated++;
      console.log(
        `  ${payload.name || payload.id}  type=${userType || '—'}  role=${role || '—'}  ` +
        `locations=${locationIds ? locationIds.length : '—'}` +
        `${locationIds?.includes(locationId) ? '' : '  (NOT a member of this sub-account)'}`
      );
    } catch (err) {
      // 404 = "The user does not exist." — deleted in GHL, still in our table.
      //
      // WHY THE WEBHOOK DID NOT CLEAR THEM. UserDelete IS handled
      // (userWriter.handleUserDelete, webhooks.js), but a webhook only fires
      // for a deletion that happens WHILE the app is installed and
      // subscribed. A user removed before install — or during a gap in
      // delivery — leaves a row nothing will ever revisit, because every
      // other path reads a list that no longer mentions them.
      //
      // SOFT delete, matching the webhook exactly: active=false and a
      // deleted_at stamp, not a DELETE. Opportunities, tasks and notes still
      // carry assigned_to pointing at this id, and the owner name on a closed
      // deal from last year should not become blank because the rep has since
      // left. /deals/users already filters on active = true, so they drop out
      // of every dropdown.
      if (err?.response?.status === 404) {
        await rawQuery(
          `UPDATE users
              SET active = false, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
            WHERE location_id = $1 AND user_id = $2`,
          [locationId, userId]
        );
        removed++;
        console.log(`  ${userId}  deleted in GHL — marked inactive`);
        continue;
      }
      failed++;
      logger.warn({ err, userId }, 'syncUserRoles: fetch failed');
    }
  }

  return { updated, removed, failed, total: ids.length };
}

async function main() {
  const [locationArg, oneUserId] = process.argv.slice(2);

  // No location named? Every active install.
  //
  // The roles payload is per USER, not per location, so this is the shape the
  // job actually wants: an agency admin attached to four sub-accounts is
  // missing from all four user lists, and fixing one of them by hand leaves
  // the other three with the same blank avatar.
  let locations;
  if (locationArg) {
    locations = [locationArg];
  } else {
    const { rows } = await rawQuery(
      `SELECT location_id FROM installs
        WHERE uninstalled_at IS NULL
        ORDER BY installed_at ASC`
    );
    locations = rows.map((r) => r.location_id);
    console.log(`${locations.length} active install${locations.length === 1 ? '' : 's'}.\n`);
  }

  if (locations.length === 0) {
    console.log('No active installs.');
    return;
  }

  let updated = 0;
  let removed = 0;
  let failed = 0;
  let total = 0;
  for (const locationId of locations) {
    if (!locationArg) console.log(`${locationId}:`);
    // One location's failure must not abandon the rest — a dead token on an
    // old sub-account would otherwise stop the whole sweep.
    try {
      const r = await syncLocation(locationId, oneUserId);
      updated += r.updated; removed += r.removed; failed += r.failed; total += r.total;
    } catch (err) {
      failed++;
      console.log(`  ${locationId}: FAILED — ${err?.message || err}`);
    }
  }

  console.log(
    `\n${updated} updated, ${removed} marked inactive (deleted in GHL), ` +
    `${failed} failed, ${total} total.`
  );
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err?.message || err); pool.end(); process.exit(1); });
