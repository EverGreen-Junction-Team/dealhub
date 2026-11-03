import { ghlRequest } from './ghlClient.js';
import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';
import { resolveCustomFieldArray } from './customFieldResolve.js';
import { upsertDefinition } from './customFieldsSync.js';

// Ports the convoVault OSH walker patterns to a per-webhook enrichment layer.
//
// Webhooks give us bare IDs + stage transition. To populate Section 4 of the
// plan (custom fields, monetary value, pipeline/stage names, contact UTMs, etc.)
// we have to hit GHL's REST API after each event arrives.
//
// Caching strategy:
//   - Pipelines + custom-field definitions per location: 1h TTL (rarely change)
//   - User names per (location, userId): 1h TTL
//   - Per-record opportunity / contact fetches: NO cache (always fresh — these
//     are the dynamic fields we want the absolute latest of)

// ---------------------------------------------------------------- cache
// Simple in-memory cache. Wipes on process restart. For multi-instance scale
// later we'd swap to Redis, but Mongo-style "single replica" is fine for V1.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function makeCache() {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at > CACHE_TTL_MS) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { at: Date.now(), value });
    },
    clear() { store.clear(); }
  };
}

const pipelineCache = makeCache();      // key: locationId        → { stageById, pipelineById }
const cfMapCache = makeCache();         // key: locationId        → { contactCfMap, opportunityCfMap }
const userNameCache = makeCache();      // key: `${loc}:${userId}` → user name string

// Pull the most stable JSON-key name out of a GHL custom-field definition.
// Priority: fieldKey (unchanged, with prefix) > name > id.
// We keep the full fieldKey (e.g. `contact.pincode`, `opportunity.meddic_1`)
// because it's GHL's canonical identifier — easier to grep, no ambiguity
// between a contact and an opp field with the same short name.
function friendlyKeyFromCfDef(f) {
  return f.fieldKey || f.name || f.id;
}

// Decide which model a custom-field definition belongs to. GHL's response
// shape varies: some payloads have `model: "contact"|"opportunity"`, some
// have `objectKey`/`modelType`, and a few omit it entirely. The most stable
// signal is the fieldKey prefix (`contact.X` / `opportunity.X`) — that's
// always there. Fall back to the explicit model fields if fieldKey isn't.
function detectCfModel(f) {
  if (typeof f.fieldKey === 'string') {
    const k = f.fieldKey.toLowerCase();
    if (k.startsWith('contact.')) return 'contact';
    if (k.startsWith('opportunity.')) return 'opportunity';
  }
  const explicit = (f.model || f.objectKey || f.modelType || '').toString().toLowerCase();
  if (explicit.includes('opportunit')) return 'opportunity';
  if (explicit.includes('contact')) return 'contact';
  return null;
}

// ---------------------------------------------------------------- pipelines
// Returns:
//   {
//     stageById: { [pipelineStageId]: { stageName, pipelineId, pipelineName } },
//     pipelineById: { [pipelineId]: { pipelineName, stages: [{id, name}] } }
//   }
export async function getPipelineLookup(install) {
  const cached = pipelineCache.get(install.location_id);
  if (cached) return cached;
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/opportunities/pipelines?locationId=${encodeURIComponent(install.location_id)}`
    });
    const pipelines = data?.pipelines || [];
    const stageById = {};
    const pipelineById = {};
    for (const p of pipelines) {
      pipelineById[p.id] = { pipelineName: p.name, stages: p.stages || [] };
      for (const s of (p.stages || [])) {
        stageById[s.id] = {
          stageName: s.name,
          pipelineId: p.id,
          pipelineName: p.name
        };
      }
    }
    const result = { stageById, pipelineById };
    pipelineCache.set(install.location_id, result);
    logger.debug(
      { locationId: install.location_id, pipelineCount: pipelines.length },
      'enrichment.pipelines: fetched + cached'
    );
    return result;
  } catch (err) {
    logger.warn({ err, locationId: install.location_id }, 'enrichment.pipelines: fetch failed');
    return { stageById: {}, pipelineById: {} };
  }
}

// ---------------------------------------------------------------- cf maps
// Returns: { contactCfMap: {fieldId: fieldName}, opportunityCfMap: {fieldId: fieldName} }
// GHL exposes definitions via /locations/{loc}/customFields filtered by model.
//
// REQUIRED SCOPE: `locations/customFields.readonly` (NOT `locations.readonly`).
// If that scope wasn't granted at install time, GHL returns 401 here. We cache
// the empty result and skip future retries until the cache TTL expires (1h) —
// otherwise every single webhook hammers this endpoint.
// Write definitions GHL returned that we have no row for.
//
// NEW ONLY — an existing row is left alone. The daily sync owns updates and
// the soft-delete pass that retires a field removed in GHL; doing either from
// here would mean two writers racing over the same rows on every webhook.
// This closes the gap until that runs, it does not maintain the table.
//
// The two cannot conflict: a row inserted here carries last_synced_at = now(),
// always later than the daily run's startedAt, so that run's soft-delete pass
// (last_synced_at < startedAt) cannot retire a row this path just added.
//
// Never throws: enrichment must keep working if this fails. A definition we
// could not store is one the editor cannot show yet, which is exactly the
// state we were already in.
async function backfillDefinitions(locationId, allFields) {
  if (!Array.isArray(allFields) || allFields.length === 0) return;
  try {
    const ids = allFields.map((f) => f.id).filter(Boolean);
    if (ids.length === 0) return;

    const known = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT field_id FROM ghl_custom_field_definitions
          WHERE location_id = $1 AND field_id = ANY($2::text[])`,
        [locationId, ids]
      );
      return new Set(rows.map((r) => r.field_id));
    });

    const missing = allFields.filter((f) => f.id && !known.has(f.id));
    if (missing.length === 0) return;

    for (const f of missing) {
      // `model` is what upsertDefinition keys object_type on, and GHL omits it
      // on some responses — detectCfModel reads the fieldKey prefix instead,
      // which is the same rule the name map above uses.
      await upsertDefinition(locationId, { ...f, model: detectCfModel(f) || f.model });
    }

    logger.info(
      { locationId, added: missing.length, names: missing.map((f) => f.name).slice(0, 10) },
      'enrichment.cfMaps: stored custom field definitions that were missing'
    );
  } catch (err) {
    logger.warn(
      { locationId, err },
      'enrichment.cfMaps: could not store missing custom field definitions'
    );
  }
}

export async function getCustomFieldNameMaps(install) {
  const cached = cfMapCache.get(install.location_id);
  if (cached) return cached;
  const result = { contactCfMap: {}, opportunityCfMap: {} };
  try {
    // Two passes: GHL's `/locations/{loc}/customFields` endpoint historically
    // returns contact fields by default. To pull opportunity fields you have
    // to pass `?model=opportunity` (some GHL versions need it explicitly).
    // We hit both so neither flavour is missing.
    const baseUrl = `/locations/${encodeURIComponent(install.location_id)}/customFields`;
    const responses = await Promise.all([
      ghlRequest(install, { method: 'GET', url: baseUrl }).catch((e) => ({ error: e })),
      ghlRequest(install, { method: 'GET', url: `${baseUrl}?model=opportunity` }).catch((e) => ({ error: e }))
    ]);
    // Merge fields from both responses, dedup by id.
    const allFields = [];
    const seenIds = new Set();
    for (const r of responses) {
      const fs = r?.data?.customFields || [];
      for (const f of fs) {
        if (!f?.id || seenIds.has(f.id)) continue;
        seenIds.add(f.id);
        allFields.push(f);
      }
    }

    // One-time sanity log: what does GHL actually return per field? Surfaces
    // any unexpected shape (missing fieldKey, weird model name, etc.) so we
    // can adjust without guessing.
    if (allFields.length > 0) {
      const sample = allFields.slice(0, 3).map((f) => ({
        id: f.id, name: f.name, fieldKey: f.fieldKey,
        model: f.model, objectKey: f.objectKey, modelType: f.modelType,
        dataType: f.dataType
      }));
      logger.info({ locationId: install.location_id, sample, totalFields: allFields.length }, 'enrichment.cfMaps: raw shape sample');
    }

    for (const f of allFields) {
      const friendly = friendlyKeyFromCfDef(f);
      const model = detectCfModel(f);
      if (model === 'opportunity') result.opportunityCfMap[f.id] = friendly;
      else if (model === 'contact') result.contactCfMap[f.id] = friendly;
      // If model is null (shouldn't happen — every GHL cf has either a
      // fieldKey prefix or a model field), the field is silently skipped.
    }
    // Store any definition we do not already hold.
    //
    // WHY HERE. ghl_custom_field_definitions is refreshed by the DAILY cron
    // (03:00, orphanSweep.js), and that is its only refresh — so a field
    // created in GHL at 09:00 has no row for eighteen hours, and the editor
    // cannot render it at all in that window. Not "renders empty": the field
    // is absent, because the editor builds its grid from the definitions.
    //
    // Its VALUE still arrives and is still stored — customFieldResolve keeps
    // an unknown id under the bare id rather than dropping it — so the data
    // was never lost, only unreachable.
    //
    // This function already fetches every definition from GHL on each cache
    // miss to build the id→name map. Writing them costs one upsert per field
    // we have not seen, at most once an hour per location (the cache TTL),
    // and it means a new field appears by itself instead of waiting for
    // someone to remember the script.
    await backfillDefinitions(install.location_id, allFields);

    cfMapCache.set(install.location_id, result);
    logger.info(
      {
        locationId: install.location_id,
        opportunityFields: Object.keys(result.opportunityCfMap).length,
        contactFields: Object.keys(result.contactCfMap).length
      },
      'enrichment.cfMaps: fetched + cached'
    );
    return result;
  } catch (err) {
    const status = err.response?.status;
    // Cache the empty result regardless of which error — this prevents the
    // same broken request from firing 100s of times per minute. Cache TTL
    // is 1h so we'll retry naturally after that (gives time to fix scopes).
    cfMapCache.set(install.location_id, result);
    if (status === 401 || status === 403) {
      logger.error(
        { locationId: install.location_id, status, ghlMessage: err.response?.data?.message },
        'enrichment.cfMaps: missing scope — add `locations/customFields.readonly` to the GHL Marketplace app + have client reinstall. Custom field names will be stored as IDs until then.'
      );
    } else {
      logger.warn({ err, locationId: install.location_id }, 'enrichment.cfMaps: fetch failed');
    }
    return result;
  }
}

// ---------------------------------------------------------------- helpers
// Convert GHL's customFields array to a `{ fieldName: value }` object using
// the name map. Falls back to the field id when the name is unknown
// (better to surface the raw id than to silently drop the value).
// Delegates to the shared resolver so the enriched path and the raw-webhook
// path agree on both the key format and the value precedence.
//
// The key format was the bug. This function used the map's value verbatim, and
// the map stores GHL's FULL fieldKey (`opportunity.client_type`, built by
// friendlyKeyFromCfDef). Every consumer reads the bare name — the promoted
// block in stageHistoryWriter asks for `cf.client_type` — so a resolved field
// never matched, and the promoted columns stayed empty on the enriched path
// exactly as they did on the raw one. resolveCustomFieldArray strips the
// prefix.
function resolveCustomFields(rawFields, idToName) {
  return resolveCustomFieldArray(rawFields, idToName);
}

// ---------------------------------------------------------------- opportunity
// Returns the full opportunity with customFields RESOLVED to a friendly object,
// or null if the fetch fails (caller should fall back to webhook data).
export async function getOpportunityFull(install, opportunityId) {
  if (!opportunityId) return null;
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/opportunities/${encodeURIComponent(opportunityId)}`
    });
    const opp = data?.opportunity || data;
    if (!opp || !opp.id) {
      logger.debug({ opportunityId }, 'enrichment.opportunity: empty response (likely deleted)');
      return null;
    }
    const { opportunityCfMap } = await getCustomFieldNameMaps(install);
    const customFieldsResolved = resolveCustomFields(opp.customFields, opportunityCfMap);
    return { ...opp, customFieldsResolved };
  } catch (err) {
    // 404 = deleted/inaccessible. Don't log loud — happens with ghost opps.
    const status = err.response?.status;
    const level = status === 404 ? 'debug' : 'warn';
    logger[level]({ err, opportunityId, status }, 'enrichment.opportunity: fetch failed');
    return null;
  }
}

// ---------------------------------------------------------------- contact
export async function getContactFull(install, contactId) {
  if (!contactId) return null;
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/contacts/${encodeURIComponent(contactId)}`
    });
    const contact = data?.contact || data;
    if (!contact || !contact.id) {
      logger.debug({ contactId }, 'enrichment.contact: empty response');
      return null;
    }
    const { contactCfMap } = await getCustomFieldNameMaps(install);
    const customFieldsResolved = resolveCustomFields(contact.customFields, contactCfMap);
    return { ...contact, customFieldsResolved };
  } catch (err) {
    const status = err.response?.status;
    const level = status === 404 ? 'debug' : 'warn';
    logger[level]({ err, contactId, status }, 'enrichment.contact: fetch failed');
    return null;
  }
}

// ---------------------------------------------------------------- user name
// For James's "filter by Sales Manager" use case. assigned_to → human name.
// Cached aggressively; only fetched once per (location, user) per hour.
/**
 * The full GHL user record — specifically for `roles`, which webhooks omit.
 *
 * A UserCreate/UserUpdate webhook carries id, name, email and the EVENT type
 * ("UserUpdate"), but no `roles` object. So the one field that says whether
 * someone is an agency user or a sub-account rep is absent from exactly the
 * event that would tell us about a new one. Without this call, user_type
 * only ever gets set by migration 133's backfill — and every user created
 * afterwards reads as NULL, which the dropdown treats as "show them".
 *
 * Returns null rather than throwing: a user whose type we cannot determine
 * is written with type NULL and shows in the dropdown, which is the safe
 * failure. Hiding a real rep because an API call timed out would be worse.
 */
// GET /users/search — the FULL user record, as the UI's own user list sees
// it: roles (type, role, locationIds), twoWaySync, permissions. GET /users/{id}
// carries roles but not twoWaySync, and the per-location list carries
// neither. One page per call; `ids` narrows to specific users (the webhook
// path), omitted it walks the location's users (the backfill).
//
// Needs the agency id — the install row's company_id — which the OAuth
// token response gave us at install time.
// `twoWaySync: true` adds enabled2waySync=true — the form of the call that
// is known to return the twoWaySync block for a user (it is the exact curl
// that was verified by hand). Used on the per-user fetch, not the page list.
export async function searchUsers(install, { ids = null, limit = 100, skip = 0, twoWaySync = false } = {}) {
  const companyId = install.company_id;
  if (!companyId) {
    logger.warn({ locationId: install.location_id }, 'enrichment.searchUsers: install has no company_id');
    return null;
  }
  const q = new URLSearchParams({
    companyId,
    locationId: install.location_id,
    limit: String(limit),
    skip: String(skip)
  });
  if (ids?.length) q.set('ids', ids.join(','));
  if (twoWaySync) q.set('enabled2waySync', 'true');
  try {
    const url = `/users/search?${q}`;
    const { data } = await ghlRequest(install, { method: 'GET', url });
    const users = Array.isArray(data?.users) ? data.users : [];
    // Loud when the answer is empty: a sync that reports "0 users" needs to
    // say whether GHL returned none or returned them under a key we do not
    // read. `count` is GHL's own total for the query.
    if (!users.length) {
      logger.warn(
        { locationId: install.location_id, companyId, skip, limit,
          ghlCount: data?.count ?? null, keys: Object.keys(data || {}) },
        'enrichment.searchUsers: empty page'
      );
    } else if (ids?.length) {
      // Per-user fetch: print what came back, field by field, so a sync that
      // writes no mailbox can be read straight off the log.
      logger.debug({
        locationId: install.location_id, ids,
        twoWaySync: users.map((u) => ({ id: u.id, hasMailbox: !!u.twoWaySync }))
      }, 'enrichment.searchUsers: user');
    } else {
      logger.info({ locationId: install.location_id, skip, got: users.length, ghlCount: data?.count ?? null,
        twoWaySyncOnPage: users.filter((u) => u.twoWaySync).length },
        'enrichment.searchUsers: page');
    }
    // Stamp the agency on each row — the payload does not repeat it.
    return users.map((u) => ({ ...u, companyId }));
  } catch (err) {
    // WARN, not debug. This is the call the whole user sync now rests on; a
    // 4xx here silently became "0 users" on the Control panel.
    logger.warn(
      { locationId: install.location_id, companyId,
        status: err?.response?.status, body: err?.response?.data },
      'enrichment.searchUsers: fetch failed — falling back to the location list'
    );
    return null;
  }
}

export async function getUserFull(install, userId) {
  if (!userId) return null;
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/users/${encodeURIComponent(userId)}`
    });
    return data?.user || data || null;
  } catch (err) {
    // A 404 is not a failure, it is an ANSWER: "The user does not exist."
    // Callers that write a user row need to tell that apart from a timeout —
    // one means delete the row, the other means try again later. The marker
    // is a property rather than a throw, so every existing caller keeps
    // treating it as "no user" exactly as before.
    if (err?.response?.status === 404) {
      logger.debug({ userId }, 'enrichment.userFull: user does not exist in GHL');
      return { __notFound: true };
    }
    logger.debug({ err, userId }, 'enrichment.userFull: fetch failed');
    return null;
  }
}

export async function getUserName(install, userId) {
  if (!userId) return null;
  const key = `${install.location_id}:${userId}`;
  const cached = userNameCache.get(key);
  if (cached !== null) return cached;

  // Local `users` table first (migration 014's intent). It's kept current by
  // the UserCreate/Update/Delete webhooks + backfill:users, so it's both
  // cheaper and more reliable than the API — a soft-deleted user still
  // resolves here, where GET /users/{id} would 404 and leave the owner blank.
  try {
    const local = await withTenant(install.location_id, (client) =>
      client.query(
        `SELECT name, email FROM users
          WHERE location_id = $1 AND user_id = $2`,
        [install.location_id, userId]
      )
    );
    const row = local.rows[0];
    const localName = row ? row.name || row.email : null;
    if (localName) {
      userNameCache.set(key, localName);
      return localName;
    }
  } catch (err) {
    logger.debug({ err, userId }, 'enrichment.userName: local lookup failed');
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/users/${encodeURIComponent(userId)}`
    });
    const user = data?.user || data;
    const name = user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || userId
      : null;
    if (name) userNameCache.set(key, name);
    return name;
  } catch (err) {
    logger.debug({ err, userId }, 'enrichment.userName: fetch failed');
    return null;
  }
}

// Useful for tests / admin endpoints (e.g. "force re-fetch all pipelines").
export function __clearAllCaches() {
  pipelineCache.clear();
  cfMapCache.clear();
  userNameCache.clear();
}
