// userWriter.js — handles UserCreate / UserUpdate / UserDelete webhooks and
// the one-time users backfill. Writes to the `users` table (migration 014).
//
// Design notes:
//   - UserDelete is a SOFT delete. We set active=false + stamp deleted_at,
//     never DROP the row. Tasks/opportunities/stage_history reference the
//     user_id long after the user leaves.
//   - GHL user payload shape varies slightly across event vs. API responses.
//     We use the full raw payload as `raw_user` JSONB so any field we didn't
//     promote is still recoverable.
//   - Name resolution: `firstName + lastName` if both present, else `name`
//     if GHL sends it, else email as a last-resort display value.

import { rawQuery } from '../db.js';
import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { getUserFull, searchUsers } from './ghlEnrichment.js';

// --- Helpers -----------------------------------------------------------

function pickUserFields(payload) {
  // GHL's user shape (both webhook + REST):
  //   { id, firstName, lastName, name?, email, phone?, role?/roles?/permissions?,
  //     dateAdded?, dateUpdated? }
  // Role is inconsistent — sometimes a flat string, sometimes a role object,
  // sometimes a permissions array. Store the raw payload for future use;
  // promote a best-effort role string only.
  const first = payload.firstName || '';
  const last = payload.lastName || '';
  const composed = [first, last].filter(Boolean).join(' ').trim();
  const name = composed || payload.name || payload.email || null;

  // ROLE AND TYPE ARE DIFFERENT QUESTIONS.
  //
  //   roles.role — 'admin' | 'user'    → how much they can do
  //   roles.type — 'account' | 'agency' → WHO they work for
  //
  // GHL sends roles as an OBJECT:
  //   "roles": { "role": "admin", "type": "agency", "locationIds": [...] }
  //
  // This read roles as an ARRAY (roles[0].type), which matches no payload GHL
  // currently sends — so `role` came out NULL for every user and `type` was
  // never read at all. Both shapes are handled now: the object, and the array
  // in case an older or different endpoint still returns one.
  const roles = payload.roles;
  const rolesObj = roles && !Array.isArray(roles) && typeof roles === 'object' ? roles : null;
  const rolesFirst = Array.isArray(roles) ? roles[0] : null;

  // EVERY sub-account this user is attached to — roles.locationIds.
  //
  // 133 promoted roles.type and repaired roles.role; this is the third field
  // of the same object, and the one that says whether the user is actually a
  // MEMBER of a given sub-account. An agency admin who owns a location can be
  // absent from that location's own user list, which is why the Co-Pilot
  // sidebar could not resolve their name.
  //
  // Both shapes, as above: the object GHL sends and the array an older writer
  // expected. Anything that is not an array of strings is left NULL rather
  // than coerced — "the payload said nothing" and "attached to nowhere" are
  // different claims.
  const rawLocIds = rolesObj?.locationIds ?? rolesFirst?.locationIds ?? null;
  const locationIds = Array.isArray(rawLocIds)
    ? rawLocIds.filter((id) => typeof id === 'string' && id)
    : null;

  let role = null;
  if (typeof payload.role === 'string') role = payload.role;
  else if (payload.role?.type) role = payload.role.type;
  else if (rolesObj?.role) role = rolesObj.role;
  else if (rolesFirst) {
    role = typeof rolesFirst === 'string' ? rolesFirst : (rolesFirst.type || null);
  }

  // 'account' = works for this sub-account (a sales rep).
  // 'agency'  = works for the agency that owns it — attached to several
  //             sub-accounts at once, and not a rep for any of them.
  // NULL when the payload says nothing. Deliberately NOT defaulted to
  // 'account': assuming an unknown user is a rep is what put an agency user
  // in every owner dropdown.
  // Last resort when no roles object arrived: the ENVELOPE shape.
  //
  //   agency user  → companyId (and often a `locations` array)
  //   account user → locationId
  //
  // Only consulted when roles said nothing, and only in the direction that is
  // safe to infer. companyId WITHOUT locationId is an agency user — that is
  // the whole reason the event names a company rather than a location.
  //
  // The reverse is NOT inferred. A payload carrying locationId is not thereby
  // an account user: an agency user restricted to specific sub-accounts
  // (roles.restrictSubAccount, as in the sample) arrives with BOTH, and
  // reading locationId as "account" would type exactly the person this
  // feature exists to exclude. Unknown stays NULL, and NULL shows in the
  // dropdown — the safe direction to be wrong.
  const envelopeType = (payload.companyId && !payload.locationId) ? 'agency' : null;

  const userType = rolesObj?.type
    ?? (typeof rolesFirst === 'object' ? rolesFirst?.type : null)
    ?? payload.role?.type
    ?? envelopeType
    ?? null;

  return {
    userId: payload.id || payload.userId,
    name,
    email: payload.email || null,
    phone: payload.phone || null,
    role,
    userType,
    locationIds,
    // The agency, and the user's two-way mailbox. Both come from
    // /users/search (the webhook payload carries neither); null means "not
    // in this payload", and the upsert COALESCEs so it never blanks a value
    // we already hold.
    companyId: payload.companyId || null,
    twoWaySync: payload.twoWaySync && typeof payload.twoWaySync === 'object' ? payload.twoWaySync : null,
    twoWaySyncEmail: payload.twoWaySync?.gmail?.email || payload.twoWaySync?.outlook?.email || null,
    createdAtGhl: payload.dateAdded ? new Date(payload.dateAdded) : null,
    updatedAtGhl: payload.dateUpdated ? new Date(payload.dateUpdated) : null,
    raw: payload
  };
}

// --- Writers -----------------------------------------------------------

async function upsertUser(locationId, u, { markInactive = false, fromBackfill = false } = {}) {
  // UPSERT: an existing row gets its user-facing fields refreshed. active is
  // set based on markInactive (UserDelete sets it false; every other event
  // brings it back to true — a "resurrection" is treated as a new hire).
  await rawQuery(
    `INSERT INTO users (
       location_id, user_id, name, email, phone, role, user_type, location_ids,
       active, raw_user, from_backfill,
       created_at_ghl, updated_at_ghl,
       deleted_at, company_id, two_way_sync, two_way_sync_email,
       imported_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), now())
     ON CONFLICT (location_id, user_id) DO UPDATE SET
       company_id         = COALESCE(EXCLUDED.company_id, users.company_id),
       -- two_way_sync is REPLACED when the payload carries the block, so a
       -- disconnected mailbox clears; left alone when the payload is a
       -- webhook that never mentions it.
       two_way_sync       = CASE WHEN EXCLUDED.two_way_sync IS NOT NULL THEN EXCLUDED.two_way_sync ELSE users.two_way_sync END,
       two_way_sync_email = CASE WHEN EXCLUDED.two_way_sync IS NOT NULL THEN EXCLUDED.two_way_sync_email ELSE users.two_way_sync_email END,
       name           = COALESCE(EXCLUDED.name, users.name),
       email          = COALESCE(EXCLUDED.email, users.email),
       phone          = COALESCE(EXCLUDED.phone, users.phone),
       role           = COALESCE(EXCLUDED.role, users.role),
       -- COALESCE, like the others: a payload that omits the type must not
       -- blank a type we already know. A user who genuinely moves from agency
       -- to account arrives with the new value, which wins.
       user_type      = COALESCE(EXCLUDED.user_type, users.user_type),
       -- COALESCE for the same reason: a payload with no roles object must
       -- not blank the membership list we already hold.
       location_ids   = COALESCE(EXCLUDED.location_ids, users.location_ids),
       active         = EXCLUDED.active,
       raw_user       = EXCLUDED.raw_user,
       updated_at_ghl = COALESCE(EXCLUDED.updated_at_ghl, users.updated_at_ghl),
       deleted_at     = EXCLUDED.deleted_at,
       updated_at     = now()`,
    [
      locationId, u.userId, u.name, u.email, u.phone, u.role, u.userType,
      u.locationIds,
      !markInactive,
      u.raw, fromBackfill,
      u.createdAtGhl, u.updatedAtGhl,
      markInactive ? new Date() : null,
      u.companyId, u.twoWaySync ? JSON.stringify(u.twoWaySync) : null, u.twoWaySyncEmail
    ]
  );
}

// --- Public API --------------------------------------------------------

// Called from the webhook router for UserCreate + UserUpdate.
// The rep's connected mailbox (two-way sync), looked up BY USER, not by
// location row.
//
// users is keyed (location_id, user_id): an agency admin on four
// sub-accounts has four rows, and which of them carries twoWaySync depends
// on which was synced after the mailbox was connected. The composer used to
// read only the current location's row and showed no Gmail sender while
// another row for the same person had it. The mailbox belongs to the user
// — so take any row of theirs in the same company, preferring the current
// location's when it has one. rawQuery, because users is tenant-isolated
// by location and this read deliberately crosses that line.
export async function mailboxForUser(locationId, userId) {
  if (!locationId || !userId) return null;
  const { rows } = await rawQuery(
    `SELECT two_way_sync_email AS email, two_way_sync AS sync
       FROM users
      WHERE user_id = $2 AND two_way_sync_email IS NOT NULL AND deleted_at IS NULL
        AND (location_id = $1
             OR company_id = (SELECT company_id FROM installs WHERE location_id = $1))
      ORDER BY (location_id = $1) DESC, updated_at DESC
      LIMIT 1`,
    [locationId, userId]
  );
  const r = rows[0];
  if (!r?.email) return null;
  const kind = r.sync?.gmail ? 'Gmail' : r.sync?.outlook ? 'Outlook' : 'Mailbox';
  return { email: r.email, kind };
}

// Is this address a rep's connected mailbox on this company? Used when
// replying: if the original email went out from (or came in to) a rep's
// Gmail, the reply should leave from that same mailbox.
export async function mailboxByAddress(locationId, address) {
  const a = String(address || '').trim().toLowerCase();
  if (!locationId || !a) return null;
  const { rows } = await rawQuery(
    `SELECT two_way_sync_email AS email, two_way_sync AS sync
       FROM users
      WHERE lower(two_way_sync_email) = $2 AND deleted_at IS NULL
        AND (location_id = $1
             OR company_id = (SELECT company_id FROM installs WHERE location_id = $1))
      ORDER BY (location_id = $1) DESC, updated_at DESC
      LIMIT 1`,
    [locationId, a]
  );
  const r = rows[0];
  if (!r?.email) return null;
  const kind = r.sync?.gmail ? 'Gmail' : r.sync?.outlook ? 'Outlook' : 'Mailbox';
  return { email: r.email, kind };
}

export async function handleUserUpsert(install, event) {
  const locationId = install.location_id;
  const fromEvent = pickUserFields(event);
  if (!fromEvent.userId) {
    logger.warn({ event }, 'userWriter: event missing user id — dropping');
    return;
  }

  // ── THE WEBHOOK DOES NOT CARRY `roles` ──────────────────────────────
  //
  // A UserCreate/UserUpdate payload has id, name, email and `type` — but
  // `type` there is the EVENT NAME ("UserUpdate"), not the user's kind. The
  // `roles` object, which holds roles.type = 'agency' | 'account', is only on
  // the API record.
  //
  // Without this fetch, user_type would be set once by migration 133's
  // backfill and never again: every user created or changed afterwards would
  // read NULL, and the owner dropdown — which shows NULL — would quietly fill
  // back up with agency users.
  //
  // Only fetched when the event cannot already answer, so a payload that
  // gains the fields later costs nothing. A failed fetch returns null and the
  // user is written from the event alone, with type NULL: they appear in the
  // dropdown, which is the safe direction to fail.
  //
  // THE TEST IS `roles.locationIds`, NOT `role`. A payload carrying a bare
  // role string ("admin") satisfied the old `!event.role` check and skipped
  // the fetch — but a string has no locationIds, so that column stayed NULL
  // for exactly the users whose membership we most need to know. Only the
  // roles OBJECT carries all three fields, so only its presence can stand in
  // for the API record.
  const eventRoles = event.roles && !Array.isArray(event.roles)
    ? event.roles
    : (Array.isArray(event.roles) ? event.roles[0] : null);
  const eventHasFullRoles = !!eventRoles
    && Array.isArray(eventRoles.locationIds)
    && !!eventRoles.type;

  // ALWAYS fetch the full record on a webhook. The event payload carries no
  // twoWaySync, and roles only sometimes — and /users/search is the one call
  // that returns both. getUserFull is the fallback when search is unavailable
  // (no company_id on the install) and still answers roles.
  let u = fromEvent;
  {
    // THE MAILBOX-REPORTING FORM FIRST. Only the enabled2waySync=true call
    // returns a user's twoWaySync block (see searchUsers); the plain call
    // returns the user without it, and a row refreshed from that answer
    // lost its connected Gmail — the Send via picker then fell back to
    // "Email (native)" for a rep whose mailbox was connected all along.
    // A user the filtered call does not list has no enabled mailbox, so the
    // plain call then supplies the record and the mailbox is cleared on
    // purpose, not by accident.
    const withBox = await searchUsers(install, { ids: [fromEvent.userId], limit: 1, twoWaySync: true });
    let hit = Array.isArray(withBox) ? withBox.find((x) => x.id === fromEvent.userId) : null;
    let found = withBox;
    if (!hit) {
      found = await searchUsers(install, { ids: [fromEvent.userId], limit: 1 });
      const plain = Array.isArray(found) ? found.find((x) => x.id === fromEvent.userId) : null;
      // Listed, but not among mailbox users: record "no mailbox" explicitly.
      if (plain && Array.isArray(withBox)) hit = { ...plain, twoWaySync: {} };
      else hit = plain;
    }
    if (hit) {
      u = pickUserFields({ ...fromEvent.raw, ...hit });
    } else if (Array.isArray(found)) {
      // Search answered and did not list them: gone from GHL.
      await upsertUser(locationId, fromEvent, { markInactive: true });
      logger.info({ locationId, userId: fromEvent.userId, eventType: event.type },
        'userWriter: user not in /users/search — soft-deleted');
      return;
    }
  }
  if (u === fromEvent && !eventHasFullRoles) {
    const full = await getUserFull(install, fromEvent.userId);

    // 404 — GHL says this user does not exist, which happens when they are
    // deleted between the event being queued and us reading it. Writing them
    // back as active would resurrect a row the next sweep has to clean up
    // again, so this takes the same soft-delete path UserDelete does.
    if (full?.__notFound) {
      await upsertUser(locationId, fromEvent, { markInactive: true });
      logger.info(
        { locationId, userId: fromEvent.userId, eventType: event.type },
        'userWriter: user no longer exists in GHL — soft-deleted'
      );
      return;
    }

    if (full) {
      // The API record wins on the fields it carries; the event supplies
      // anything the API omits. raw_user ends up as the richer of the two.
      u = pickUserFields({ ...event, ...full });
    }
  }

  await upsertUser(locationId, u);
  logger.info(
    { locationId, userId: u.userId, name: u.name, eventType: event.type },
    'userWriter: user upserted'
  );
}

// Called from the webhook router for UserDelete.
export async function handleUserDelete(install, event) {
  const locationId = install.location_id;
  const u = pickUserFields(event);
  if (!u.userId) {
    logger.warn({ event }, 'userWriter: UserDelete missing user id — dropping');
    return;
  }
  await upsertUser(locationId, u, { markInactive: true });
  logger.info({ locationId, userId: u.userId }, 'userWriter: user soft-deleted');
}

// One-time backfill helper — called from a script (see scripts/backfillUsers.js).
// Paginates GHL's /users endpoint for a location and upserts every user.
export async function backfillUsersForLocation(install) {
  const locationId = install.location_id;
  logger.info({ locationId }, 'userBackfill: starting');

  // /users/search, paged — the full record per user in one call per page:
  // roles (type, role, locationIds), twoWaySync and the agency id. The old
  // per-location list carried none of those and cost a GET /users/{id} per
  // user to fill them in. Falls back to that path only when search is
  // unavailable (an install with no company_id).
  const PAGE = 100;
  let users = [];
  let viaSearch = true;
  for (let skip = 0; ; skip += PAGE) {
    const page = await searchUsers(install, { limit: PAGE, skip });
    if (page === null) { viaSearch = false; break; }
    users.push(...page);
    if (page.length < PAGE) break;
  }
  if (!viaSearch) {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/users/?locationId=${encodeURIComponent(locationId)}`
    });
    users = Array.isArray(data?.users) ? data.users : [];
    logger.info({ locationId, got: users.length }, 'userBackfill: location list (fallback)');
  }

  // ONE BY ONE. The page list identifies who is on the location; each
  // user's record is then fetched on its own, with enabled2waySync=true —
  // the per-user form of the call that is verified to return the twoWaySync
  // block. The page list alone was observed to leave it out on a server-side
  // run while the same code from a script got it, and a per-user fetch is
  // the one shape we have seen work in every case. One extra call per user,
  // once a night or on a button press.
  let count = 0;
  for (const raw of users) {
    const u = pickUserFields(raw);
    if (!u.userId) continue;
    let merged = u;
    if (viaSearch) {
      const one = await searchUsers(install, { ids: [u.userId], limit: 1, twoWaySync: true });
      const full = Array.isArray(one) ? one.find((x) => x.id === u.userId) : null;
      if (full) merged = pickUserFields({ ...raw, ...full });
    } else if (!raw.roles) {
      // The fallback list lacks roles; GET /users/{id} still answers them.
      const full = await getUserFull(install, u.userId);
      if (full && !full.__notFound) merged = pickUserFields({ ...raw, ...full });
    }
    logger.debug({
      locationId, userId: merged.userId, userType: merged.userType,
      twoWaySyncEmail: merged.twoWaySyncEmail, viaSearch
    }, 'userBackfill: writing user');
    await upsertUser(locationId, merged, { fromBackfill: true });
    count++;
  }

  logger.info({ locationId, count, viaSearch }, 'userBackfill: complete');
  return { count };
}
