// customFieldsSync.js — daily catalogue sync for ghl_custom_field_definitions.
//
// GHL has no webhook when a custom field definition is added, renamed, or
// deleted. So we run two API calls per location per day (one per model):
//
//   GET /locations/{locationId}/customFields?model=contact
//   GET /locations/{locationId}/customFields?model=opportunity
//     → { customFields: [{ id, name, fieldKey, dataType, model, ... }, ...] }
//
// Contra to earlier assumption: GHL does NOT return both models in a single
// call. Without ?model=opportunity, the endpoint defaults to contact and the
// 21 opportunity custom fields (lead_source_opportunity, client_type,
// product_type, etc.) never enter our definitions table. Consequence was
// that vw_opportunity_flat's promoted opportunity columns stayed 100% NULL
// while the values sat in opportunities.custom_fields — see audit v2, D1.
//
// We UPSERT every row and then soft-deactivate any existing row for this
// location that wasn't touched this run — that's how we detect deletions.
//
// Soft-delete philosophy: we NEVER drop rows. Historical customFields
// JSONB blobs on contacts / opportunities reference these IDs long after
// the field is retired; analytics needs to remain able to translate them.
//
// Runs from the same daily cron as orphanSweep and tagsSync.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';

function normaliseType(dataType) {
  // GHL returns 'TEXT', 'DROPDOWN', 'CHECKBOX', etc. Guard against non-string
  // just in case the response shape drifts.
  return typeof dataType === 'string' ? dataType.toUpperCase() : null;
}

function buildOptions(def) {
  // Only picklist-style types carry options. Empty arrays get stored as
  // NULL to keep the table lean — a NULL `options` column means "no picklist
  // choices" rather than "field never had any".
  const values = Array.isArray(def.picklistOptions) ? def.picklistOptions : [];
  const images = Array.isArray(def.picklistImageOptions) ? def.picklistImageOptions : [];
  if (values.length === 0 && images.length === 0) return null;
  return { values, images };
}

// GHL's ordering key, kept as a number or dropped entirely.
//
// NOT `Number.isFinite(Number(v))`: Number(null) and Number('') are both 0,
// so a field with no position would store as 0 and sort to the TOP of its
// folder rather than being unknown. Guarding on the raw value first keeps
// absent meaning absent.
//
// Fractional by design — GHL uses a float so a field dragged between two
// others takes the midpoint (see migration 065).
function positionOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsertFolder(locationId, objectType, folder) {
  await rawQuery(
    `INSERT INTO ghl_custom_field_folders
       (location_id, object_type, folder_id, name, position,
        is_active, last_synced_at, raw_folder, imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,now(),$6, now(), now())
     ON CONFLICT (location_id, object_type, folder_id) DO UPDATE SET
       name           = COALESCE(EXCLUDED.name, ghl_custom_field_folders.name),
       position       = EXCLUDED.position,
       is_active      = true,
       last_synced_at = now(),
       raw_folder     = EXCLUDED.raw_folder,
       updated_at     = now()`,
    [
      locationId, objectType, folder.id,
      folder.name || null,
      positionOf(folder.position),
      folder
    ]
  );
}

/**
 * Folders for one object type.
 *
 * THE ENDPOINT, established by trying them against the live API rather than
 * inferring from docs — the previous two guesses were both wrong:
 *
 *   /custom-fields/object-key/:objectKey
 *       400 "Api does not support objectKey of type contact or opportunity"
 *       That route is for CUSTOM OBJECTS, not the standard models.
 *
 *   /locations/:id/customFields/search?documentType=folder&model=…
 *       correct. Returns { customFieldFolders: [...], totalItems }.
 *
 * `model` matters. `model=contact` returns only that model's folders;
 * `model=all&includeStandards=true` returns all 19 including the custom
 * objects (projects, jobs) and the STANDARD folders — "Contact", "General
 * Info", "Additional Info" — which are the ones most fields actually sit in.
 * Without includeStandards those are missing, and 19 of the 42 contact fields
 * would still land in "Other fields".
 *
 * Failure here is not fatal: the fields still sync and render ungrouped.
 */
async function syncFolders(install, locationId, objectType) {
  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/locations/${encodeURIComponent(locationId)}/customFields/search`
        + `?documentType=folder&model=${encodeURIComponent(objectType)}`
        // Standard folders — "Contact", "General Info", "Additional Info",
        // "Opportunity Details" — hold most of the fields. Omitting them
        // leaves the majority ungrouped.
        + '&includeStandards=true',
      scopeOptional: true
    });

    const folders = Array.isArray(data?.customFieldFolders)
      ? data.customFieldFolders
      : Array.isArray(data?.folders) ? data.folders : [];

    let stored = 0;
    for (const f of folders) {
      // The response carries both `id` and `_id` with the same value; `id` is
      // the one a field's parentId matches.
      const id = f?.id || f?._id;
      if (!id) continue;
      // A folder belongs to ONE model, and the match must be EXACT.
      //
      // Mapping "anything not opportunity" to contact was wrong: this
      // location has custom objects, and `custom_objects.projects_tmpl`
      // folders — "Project Info", "Job Info", "Financials" — would have been
      // filed as contact folders and rendered as sections on every contact.
      if (f.model && f.model !== objectType) continue;
      await upsertFolder(locationId, objectType, { ...f, id });
      stored++;
    }

    logger.info(
      { locationId, objectType, folders: stored, returned: folders.length },
      'customFieldsSync: folders stored'
    );
    return { count: stored };
  } catch (err) {
    logger.warn({ locationId, objectType, err },
      'customFieldsSync: folder fetch failed — fields will render ungrouped');
    return { count: 0 };
  }
}

// Exported so the ENRICHMENT path can store a definition it has just seen.
//
// The full sync runs only when someone invokes the script, so a field created
// in GHL afterwards has no row here and the editor cannot render it — there is
// nothing to render. The webhook path already fetches every definition to build
// its id→name map, so it can fill that gap as it goes, using this same writer
// rather than a second one that could drift on column defaults.
export async function upsertDefinition(locationId, def) {
  // `model` is authoritative — no more inference from fieldKey prefix.
  // Anything other than 'opportunity' falls into 'contact' (defensive:
  // GHL has only ever returned these two values here).
  const objectType = def.model === 'opportunity' ? 'opportunity' : 'contact';
  const options = buildOptions(def);
  await rawQuery(
    `INSERT INTO ghl_custom_field_definitions
       (location_id, object_type, field_id, field_key, display_name,
        field_type, options, placeholder, parent_id, position,
        is_active, last_synced_at, raw_definition, imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,now(),$11, now(), now())
     ON CONFLICT (location_id, object_type, field_id) DO UPDATE SET
       field_key      = COALESCE(EXCLUDED.field_key, ghl_custom_field_definitions.field_key),
       display_name   = COALESCE(EXCLUDED.display_name, ghl_custom_field_definitions.display_name),
       field_type     = COALESCE(EXCLUDED.field_type, ghl_custom_field_definitions.field_type),
       options        = EXCLUDED.options,
       -- Assigned, not COALESCEd: clearing a placeholder in GHL must clear it
       -- here, or the Control centre keeps showing text the user deleted.
       placeholder    = EXCLUDED.placeholder,
       -- Assigned, not COALESCEd: moving a field OUT of a folder in GHL must
       -- ungroup it here too, and COALESCE would keep the stale folder.
       parent_id      = EXCLUDED.parent_id,
       position       = EXCLUDED.position,
       is_active      = true,
       last_synced_at = now(),
       raw_definition = EXCLUDED.raw_definition,
       updated_at     = now()`,
    [
      locationId, objectType, def.id,
      def.fieldKey || null, def.name || null,
      normaliseType(def.dataType), options,
      // GHL has used both spellings across API versions.
      def.placeholder || def.placeHolder || null,
      // The folder this field belongs to. Present in the API response all
      // along; migration 064 gave it a column so the contact editor can
      // render one section per folder rather than a flat list.
      def.parentId || null,
      positionOf(def.position),
      def
    ]
  );
}

export async function syncCustomFieldsForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();

  try {
    // FOLDERS FIRST, so their field→folder map is in hand before the field
    // rows are written. Previously this ran after, which meant parent_id
    // could only come from whatever the old field endpoint happened to
    // include — and if it includes nothing, every field lands in "Other
    // fields" with no way to tell why.
    const contactFolders = await syncFolders(install, locationId, 'contact');
    const oppFolders = await syncFolders(install, locationId, 'opportunity');

    // Two calls, one per model. Merge the results. If GHL omits `model` on
    // a row (defensive), we tag it based on which call it came from.
    let contactFields = [];
    let oppFields = [];
    try {
      const { data } = await ghlRequest(install, {
        method: 'GET',
        url: `/locations/${encodeURIComponent(locationId)}/customFields?model=contact`
      });
      contactFields = Array.isArray(data?.customFields) ? data.customFields : [];
    } catch (err) {
      logger.warn({ locationId, model: 'contact', err }, 'customFieldsSync: contact fetch failed');
    }
    try {
      const { data } = await ghlRequest(install, {
        method: 'GET',
        url: `/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`
      });
      oppFields = Array.isArray(data?.customFields) ? data.customFields : [];
    } catch (err) {
      logger.warn({ locationId, model: 'opportunity', err }, 'customFieldsSync: opportunity fetch failed');
    }

    // Tag each row with its source model so upsertDefinition's model check
    // is authoritative even if GHL omits the field on individual rows.
    // parentId comes straight off the field row. Confirmed against the live
    // API: /locations/:id/customFields?model=… returns it on every field —
    //   { "id": "...", "name": "utm_term", "parentId": "zfYYpsc...", ... }
    // The folder call supplies only the NAMES.
    const fields = [
      ...contactFields.map((f) => ({
        ...f,
        model: f.model || 'contact',
        parentId: f.parentId || null
      })),
      ...oppFields.map((f) => ({
        ...f,
        model: f.model || 'opportunity',
        parentId: f.parentId || null
      }))
    ];

    let contactCount = 0;
    let oppCount = 0;
    for (const f of fields) {
      if (!f?.id) continue;
      await upsertDefinition(locationId, f);
      if (f.model === 'opportunity') oppCount++; else contactCount++;
    }

    // Same soft-delete pass for folders as for fields: a folder deleted in
    // GHL must stop appearing as a section, but the row stays so an old
    // field still resolves its name.
    await rawQuery(
      `UPDATE ghl_custom_field_folders
          SET is_active = false, updated_at = now()
        WHERE location_id = $1
          AND (last_synced_at IS NULL OR last_synced_at < $2)
          AND is_active = true`,
      [locationId, startedAt]
    );

    // Soft-delete pass: any row for this location not touched this run
    // has been removed in GHL. We never DROP — historical customFields
    // JSONB blobs on contacts + opportunities still reference these IDs
    // and need to remain resolvable.
    const { rowCount: deactivated } = await rawQuery(
      `UPDATE ghl_custom_field_definitions
          SET is_active = false, updated_at = now()
        WHERE location_id = $1
          AND (last_synced_at IS NULL OR last_synced_at < $2)
          AND is_active = true`,
      [locationId, startedAt]
    );

    logger.info(
      {
        locationId, contactFields: contactCount, opportunityFields: oppCount,
        contactFolders: contactFolders.count,
        opportunityFolders: oppFolders.count,
        deactivated
      },
      'customFieldsSync: location synced'
    );
    await recordSyncRun({
      jobName: 'customFieldsSync', objectType: 'custom_fields',
      locationId, scope: 'location', status: 'success',
      startedAt, stats: { synced: fields.length, contactFields: contactCount, opportunityFields: oppCount, deactivated }
    });
    return { synced: fields.length, contactCount, oppCount, deactivated };
  } catch (err) {
    logger.warn(
      { err, locationId, status: err.response?.status },
      'customFieldsSync: location failed'
    );
    await recordSyncRun({
      jobName: 'customFieldsSync', objectType: 'custom_fields',
      locationId, scope: 'location', status: 'failed',
      startedAt, error: err.message
    });
    return { synced: 0, error: err.message };
  }
}

// Sync every active install. Called from the daily cron. Failures on one
// location don't stop the others.
export async function syncCustomFieldsForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('customFieldsSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'customFieldsSync', objectType: 'custom_fields',
      scope: 'all', status: 'success', startedAt,
      stats: { locations: 0, fieldsSynced: 0 }
    });
    return { locations: 0, fieldsSynced: 0 };
  }

  let totalFields = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { synced, error } = await syncCustomFieldsForLocation(install);
    totalFields += synced;
    if (error) locationsFailed++;
  }
  logger.info(
    { locations: rows.length, fieldsSynced: totalFields, locationsFailed, durationMs: Date.now() - startedAt.getTime() },
    'customFieldsSync: complete'
  );
  await recordSyncRun({
    jobName: 'customFieldsSync', objectType: 'custom_fields',
    scope: 'all',
    status: locationsFailed === 0 ? 'success' : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt,
    stats: { locations: rows.length, fieldsSynced: totalFields, locationsFailed }
  });
  return { locations: rows.length, fieldsSynced: totalFields };
}
