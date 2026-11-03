// conversationProvidersSync.js — catalogue sync for SMS / Email providers.
//
// GHL endpoint (v2 camelCase path — v3 kebab-case alias exists but the
// camelCase route is what's currently in urlScopeMap, safer for OAuth):
//
//   GET /locations/{locationId}/conversationChannels/SMS
//   GET /locations/{locationId}/conversationChannels/Email
//
// Response shape (both types always present; the queried type is filled):
//   {
//     conversationChannel: {
//       _id, locationId,
//       defaults: { SMS?: <providerId>, Email?: <providerId> },
//       SMS:   [{ conversationProvider: { _id, name, type, default? } }],
//       Email: [{ conversationProvider: { _id, name, type, default? } }]
//     }
//   }
//
// Provider _id conventions:
//   twilio_provider              — native Twilio SMS
//   mailgun_provider             — native Mailgun Email
//   smtp_provider_<smtpId>       — native SMTP account
//   <MongoObjectId>              — custom marketplace / CP provider
//
// This module owns:
//   syncConversationProvidersForLocation(install)
//     — daily catalogue sync. Fetches BOTH SMS and Email. Upserts. Soft-
//     deletes anything we had that no longer appears.
//
//   ensureProviderKnown(install, providerId, channelType)
//     — on-demand hook for messageWriter. Called when a message arrives
//     with a provider_id we haven't seen. Per-location+channel advisory
//     lock + re-check pattern to prevent stampede.

import { rawQuery, pool } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

// The channel types this endpoint actually accepts.
//
// GET /locations/{id}/conversationChannels/{type} validates `type` against a
// server-side enum and answers 422 "type must be a valid enum value" for
// anything else. THREE sources disagree about what that enum contains:
//
//   locations.json (OpenAPI)  SMS, Email, WhatsApp, GMB, IG, FB, Custom, WebChat
//   ConversationChannelService  SMS | Email | WhatsApp
//   the deployed API            SMS, Email          <- measured
//
// Measured wins. A run across four live locations returned 200 for SMS and
// Email and 422 for everything else, WhatsApp included — so the deployed
// validator is narrower than either checked-in definition. An earlier version
// of this list guessed at 'Call', 'RCS', 'TIKTOK' and 'Live_Chat', which are in
// none of the three and simply 422'd nine times per location per run.
//
// This does NOT mean other channels' providers are unreachable. The response to
// an accepted type carries every provider array the location has, not just the
// requested one — fetchChannels reads all of them — so a Call-type provider
// arrives on the SMS call and is stored under its own type. Asking for more
// channel types adds round trips, not rows.
//
// Widen this only with evidence: add a type, run the sync, and keep it only if
// it returns 200. `failedChannels` in the completion log names anything that
// did not.
export const CHANNEL_TYPES = ['SMS', 'Email'];

const NATIVE_ID_PATTERNS = [
  /^twilio_provider$/,
  /^mailgun_provider$/,
  /^smtp_provider_/
];

function isNativeId(providerId) {
  return NATIVE_ID_PATTERNS.some((re) => re.test(providerId || ''));
}

// One roundtrip to GHL. Returns { providers: [{ id, name, type, isDefault, isNative, raw }], defaults }.
async function fetchChannels(install, channelType) {
  const locationId = install.location_id;
  const path = `/locations/${locationId}/conversationChannels/${channelType}`;
  const resp = await ghlRequest(install, { method: 'GET', url: path });
  const channel = resp.data?.conversationChannel || {};
  const defaults = channel.defaults || {};

  // Read EVERY provider array in the response, not just channel[channelType].
  //
  // The response carries one array per channel key and fills the one asked
  // for — but a live response also returned providers of OTHER types in the
  // same payload (Call-type senders alongside SMS ones). Reading a single key
  // silently dropped those: they were fetched, parsed and thrown away, which
  // looks identical to "the location does not have them".
  //
  // Each provider's OWN `type` is what it gets stored as, so a Call provider
  // returned under an SMS request is still stored as Call. The requested type
  // is only a fallback for a provider that declares none.
  const buckets = Object.entries(channel)
    .filter(([, v]) => Array.isArray(v))
    .flatMap(([key, arr]) => arr.map((item) => ({ key, item })));

  const seen = new Set();
  const providers = [];
  for (const { key, item } of buckets) {
    const cp = item?.conversationProvider;
    if (!cp || !cp._id) continue;
    // The same provider can legitimately appear under more than one key.
    // Storing it twice would make the upsert fight itself on the PK.
    if (seen.has(cp._id)) continue;
    seen.add(cp._id);
    const type = cp.type || key || channelType;
    providers.push({
      id:        cp._id,
      name:      cp.name || null,
      type,
      isDefault: cp.default === true || defaults[type] === cp._id,
      isNative:  isNativeId(cp._id),
      raw:       cp
    });
  }

  return { providers, defaults };
}

// NOT REACHABLE BY THIS APP — kept for the record, deliberately not called.
//
// VERDICT: /conversations/providers/search is an INTERNAL endpoint. Every
// location answered 401 "The token is not authorized for this scope", through
// a forced token refresh and a retry. It is absent from GHL's public scope map
// (apps/iam/src/v2/const/UrlScopeMap.ts): of 146 entries, the only
// /conversations/providers/* routes are the three live-chat ones. There is no
// scope to add to the app, so reauthorising cannot fix it — the browser call
// in the UI screenshot carries a SESSION token, which a marketplace app has no
// equivalent of.
//
// Consequence for the catalogue: the providers this endpoint returns and
// conversationChannels does not — SMS Android, and the three Call-type Voice
// senders — cannot be fetched by this app at all. They only enter the table
// via ensureProviderKnown when a MESSAGE arrives carrying their id, which is
// why two of them already sit there with name NULL. That is the ceiling until
// GHL exposes this route publicly.
//
// Left in the file rather than deleted so the next person does not rediscover
// the endpoint, wire it up, and get the same 401s.
//
// ORIGINAL NOTE: the custom-provider search.
//
//   GET /conversations/providers/search?locationId=…&type=…
//   -> { conversationProviders: [{ _id, name, alias, icon, type }] }
//
// WHY BOTH. conversationChannels returns the channel's CONFIGURED senders —
// which for this account meant Twilio plus a couple of custom ones, and it
// answered 422 for every type but SMS and Email. The search endpoint returns
// the location's CUSTOM providers and is the one that listed all six for
// fJNuIdxGgchGpJ9OoBbk, Call-type senders included.
//
// Proof they are genuinely different lists, not the same data twice: two ids
// visible in the search response (6a116a69…, 6a22bfc4…) sat in our table with
// name NULL. Only ensureProviderKnown's placeholder path writes a NULL name,
// and it runs when a fetch RETURNED WITHOUT the id — so conversationChannels
// really did omit providers that search returns. Neither endpoint alone is
// the catalogue.
//
// Native senders (twilio_provider, mailgun_provider, smtp_provider_*) come
// only from conversationChannels, so that call stays. This one adds the rest.
async function fetchCustomProviders(install, type) {
  const locationId = install.location_id;
  const resp = await ghlRequest(install, {
    method: 'GET',
    url: '/conversations/providers/search',
    params: { locationId, type },
    // This path is not in the scope map we can check, so a location whose
    // token predates it may 401. scopeOptional keeps that from flagging the
    // whole install reauth_required and halting unrelated syncs — the caller
    // catches it and records the channel in failedSearches instead.
    scopeOptional: true
  });
  const arr = Array.isArray(resp.data?.conversationProviders)
    ? resp.data.conversationProviders
    : [];
  return arr
    .filter((cp) => cp && cp._id)
    .map((cp) => ({
      id:        cp._id,
      name:      cp.name || null,
      // The provider's own type is authoritative — this is how Call-type
      // senders reach the table at all.
      type:      cp.type || type,
      isDefault: false,
      isNative:  isNativeId(cp._id),
      raw:       cp
    }));
}

async function upsertProviders(client, locationId, providers, source /* 'daily_sync' | 'on_demand' */) {
  if (!providers.length) return;
  for (const p of providers) {
    await client.query(
      `INSERT INTO conversation_providers
         (location_id, provider_id, name, type, is_default, is_native,
          is_deleted, deleted_at, last_synced_at, last_seen_via, raw_provider)
       VALUES ($1, $2, $3, $4, $5, $6,
               false, NULL, now(), $7, $8)
       ON CONFLICT (location_id, provider_id) DO UPDATE SET
         -- Preserve the name we already have if the payload lacks one, but
         -- prefer a fresh non-null name.
         name           = COALESCE(EXCLUDED.name, conversation_providers.name),
         type           = COALESCE(EXCLUDED.type, conversation_providers.type),
         -- OR, not overwrite. Two sources now write these rows and only
         -- conversationChannels knows which sender is the default; the
         -- custom-provider search always reports false. Since the search runs
         -- second, a plain assignment would clear Twilio's default flag on
         -- every sync. A default is only ever cleared by the daily prune.
         is_default     = conversation_providers.is_default OR EXCLUDED.is_default,
         is_native      = EXCLUDED.is_native,
         -- Resurrection: if we had marked this deleted and it's back, clear.
         is_deleted     = false,
         deleted_at     = NULL,
         last_synced_at = now(),
         -- A hand-seeded row STAYS 'manual' even when a sync also returns it.
         -- Two of the seeded providers ARE in the channels response, so a plain
         -- assignment would flip them to 'daily_sync' and strip their prune
         -- guard — leaving the seed half-protected, which is the worst state:
         -- some rows survive the next sync and some vanish.
         last_seen_via  = CASE WHEN conversation_providers.last_seen_via = 'manual'
                               THEN 'manual' ELSE EXCLUDED.last_seen_via END,
         raw_provider   = EXCLUDED.raw_provider`,
      [locationId, p.id, p.name, p.type, p.isDefault, p.isNative, source, p.raw]
    );
  }
}

// Soft-delete anything we had for (location, type) that GHL didn't return
// this run. Only called from the daily sync — an on-demand fetch might not
// cover the full picture (rare timing), so we don't prune off it.
// Prune ONCE, after every channel has been fetched — not per channel.
//
// Per-channel pruning stopped being safe when fetchChannels started keeping
// every provider in a response rather than one key's worth. A request for SMS
// can return Call-type providers too, so the ids seen during the SMS round no
// longer correspond to the SMS bucket. Pruning `type='SMS' AND id NOT IN
// (those ids)` would then delete genuine SMS providers that simply were not in
// that particular response.
//
// So: collect every id seen across the whole run, and only prune within the
// channel types that actually ANSWERED. A channel whose fetch failed is not in
// `syncedTypes`, so its rows are left alone — a transient 404 must never look
// like "these providers were removed".
async function softDeleteMissing(client, locationId, syncedTypes, seenIds) {
  if (!syncedTypes.length) return 0;
  const { rowCount } = await client.query(
    `UPDATE conversation_providers
        SET is_deleted = true,
            deleted_at = COALESCE(deleted_at, now()),
            last_synced_at = now()
      WHERE location_id = $1
        AND type        = ANY($2::text[])
        AND is_deleted  = false
        AND provider_id <> ALL($3::text[])
        -- Hand-seeded rows are never pruned. The providers this app cannot
        -- fetch (Call-type senders, and any custom provider that
        -- conversationChannels omits) are put there by
        -- scripts/seedConversationProviders.js. Pruning on "the API did not
        -- return it" would delete exactly the rows that exist BECAUSE the API
        -- does not return them — the sync would undo the seed on its next run.
        AND last_seen_via IS DISTINCT FROM 'manual'`,
    [locationId, syncedTypes, seenIds]
  );
  return rowCount || 0;
}

// Public: daily sync entry point. Called from a scheduler or manual script.
export async function syncConversationProvidersForLocation(install) {
  const locationId = install.location_id;
  const started = Date.now();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Per-channel counts rather than two hardcoded variables. With nine
    // channels, "smsCount/emailCount" told us nothing about the seven others
    // — including Call, the channel whose absence started this.
    const byChannel = {};
    const failedChannels = [];
    const seenIds = new Set();
    const syncedTypes = new Set();
    const storedByType = {};
    const seenBefore = new Set();
    let deletedCount = 0;

    for (const channelType of CHANNEL_TYPES) {
      let fetched;
      try {
        fetched = await fetchChannels(install, channelType);
      } catch (err) {
        // Expected, not exceptional: a location without Mailgun, without a
        // TikTok connection, or on a plan that lacks RCS will 404/403 that
        // channel while the rest work. Skipping WITHOUT pruning matters —
        // treating a failed fetch as "GHL returned nothing" would soft-delete
        // every provider on that channel and blank the picker.
        failedChannels.push(channelType);
        logger.warn(
          { locationId, channelType, err: err.response?.data || err.message },
          'conversationProvidersSync: fetch failed — skipping channel (not pruning)'
        );
        continue;
      }

      await upsertProviders(client, locationId, fetched.providers, 'daily_sync');

      // A channel that ANSWERED is prunable, even if it answered with nothing
      // — that is a real "this location has no providers here". A channel that
      // FAILED is not in this set, so its rows survive untouched.
      syncedTypes.add(channelType);
      for (const p of fetched.providers) {
        seenIds.add(p.id);
        // A provider can arrive under a request for a different channel, so
        // its own type is what must be prunable, not the one we asked for.
        if (p.type) syncedTypes.add(p.type);
      }
      byChannel[channelType] = fetched.providers.length;

      // NOT called: /conversations/providers/search is not reachable by a
      // marketplace app. See fetchCustomProviders' note — every location
      // answered 401 "The token is not authorized for this scope", and the
      // endpoint has no scope in GHL's public map to request. Retrying it
      // only burns two round trips and a token refresh per location per run.

      // What was actually STORED, keyed by each provider's own type. byChannel
      // counts what a REQUEST returned, so a response carrying Call providers
      // on the SMS call reported "SMS: 3" and said nothing about the Call rows
      // — the exact question "are all my providers in the DB?" needs answered.
      for (const p of fetched.providers) {
        storedByType[p.type] = (storedByType[p.type] || 0) + (seenBefore.has(p.id) ? 0 : 1);
        seenBefore.add(p.id);
      }
    }

    // One prune, after every channel has had its say.
    deletedCount = await softDeleteMissing(
      client, locationId, [...syncedTypes], [...seenIds]
    );

    await client.query('COMMIT');
    const total = Object.values(byChannel).reduce((a, b) => a + b, 0);
    logger.info(
      { locationId, byChannel, storedByType, distinct: seenIds.size, total,
        failedChannels, softDeleted: deletedCount, durationMs: Date.now() - started },
      'conversationProvidersSync: daily sync complete'
    );
    return {
      byChannel, storedByType, distinct: seenIds.size, total,
      failedChannels, softDeleted: deletedCount
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// Public: on-demand hook. Called from messageWriter when an incoming message
// carries a provider_id we haven't seen. Locks per (location, channelType)
// so 20 messages arriving in a burst don't fire 20 GHL calls — the first
// call fills the DB with the whole list, the rest hit the cache.
//
// If after the fetch the requested id STILL isn't in our DB, stamp a
// placeholder row with is_deleted=true so subsequent messages with the same
// dead id don't retry the API forever.
export async function ensureProviderKnown(install, providerId, channelType) {
  if (!providerId || !channelType) return;
  const locationId = install.location_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Per-location-per-channel advisory lock. Two workers hitting the same
    // (location, channel) miss serialise here.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`convprov:${locationId}:${channelType}`]
    );

    // Re-check inside the lock — another worker may have just filled it.
    const { rowCount: alreadyPresent } = await client.query(
      `SELECT 1 FROM conversation_providers
        WHERE location_id = $1 AND provider_id = $2`,
      [locationId, providerId]
    );
    if (alreadyPresent) {
      await client.query('COMMIT');
      return;
    }

    let fetched;
    try {
      fetched = await fetchChannels(install, channelType);
    } catch (err) {
      logger.warn(
        { locationId, providerId, channelType, err: err.response?.data || err.message },
        'ensureProviderKnown: fetch failed — stamping unknown-deleted placeholder'
      );
      // Placeholder so we don't retry on every subsequent message.
      await client.query(
        `INSERT INTO conversation_providers
           (location_id, provider_id, name, type,
            is_default, is_native, is_deleted, deleted_at,
            last_synced_at, last_seen_via, raw_provider)
         VALUES ($1, $2, NULL, $3, false, $4, true, now(), now(), 'on_demand', NULL)
         ON CONFLICT (location_id, provider_id) DO NOTHING`,
        [locationId, providerId, channelType, isNativeId(providerId)]
      );
      await client.query('COMMIT');
      return;
    }

    await upsertProviders(client, locationId, fetched.providers, 'on_demand');

    // If the id we came in for isn't in the fetched list, it was deleted in
    // GHL after the message was sent (or is a genuinely unknown/malformed id).
    // Stamp a placeholder — name null distinguishes "we never knew it" from
    // "we knew it and it's gone".
    const found = fetched.providers.some((p) => p.id === providerId);
    if (!found) {
      await client.query(
        `INSERT INTO conversation_providers
           (location_id, provider_id, name, type,
            is_default, is_native, is_deleted, deleted_at,
            last_synced_at, last_seen_via, raw_provider)
         VALUES ($1, $2, NULL, $3, false, $4, true, now(), now(), 'on_demand', NULL)
         ON CONFLICT (location_id, provider_id) DO NOTHING`,
        [locationId, providerId, channelType, isNativeId(providerId)]
      );
      logger.info(
        { locationId, providerId, channelType },
        'ensureProviderKnown: id not in GHL list — stamped placeholder'
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.warn({ err, locationId, providerId, channelType }, 'ensureProviderKnown: failed (non-fatal)');
  } finally {
    client.release();
  }
}

// Convenience for scripts / manual runs across all installs.
export async function syncConversationProvidersAllInstalls() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL AND reauth_required_at IS NULL`
  );
  let ok = 0, fail = 0;
  for (const r of rows) {
    const install = await getActiveInstall(r.location_id);
    if (!install) continue;
    try {
      await syncConversationProvidersForLocation(install);
      ok++;
    } catch (err) {
      logger.error({ err, locationId: r.location_id }, 'conversationProvidersSync: install failed');
      fail++;
    }
  }
  return { ok, fail, total: rows.length };
}
