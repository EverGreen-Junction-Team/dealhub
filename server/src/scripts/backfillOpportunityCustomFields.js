#!/usr/bin/env node
//
// One-off backfill after Fix #1 (customFieldsSync fetches opportunity fields).
//
// For every opportunity in the DB:
//   1. Read raw `custom_fields` JSONB (keyed either by field_id — old backfill
//      shape — or by friendly key — enriched-webhook shape).
//   2. Resolve each entry using ghl_custom_field_definitions
//      (WHERE object_type='opportunity').
//   3. Populate the promoted columns: lead_source_opportunity, client_type,
//      product_system, product_type, first_contact_method, postcode, inquiry,
//      forecast_probability, forecast_expected_close_date, upload_from_enquiry,
//      gclid, meddic_1..meddic_11.
//
// Idempotent — running twice is a no-op. Only fills NULL cells; never
// overwrites a value already resolved. Runs per-location so RLS constraints
// don't apply (uses the pooled service-role connection).
//
// Usage:
//   node src/scripts/backfillOpportunityCustomFields.js               # all installs
//   node src/scripts/backfillOpportunityCustomFields.js <location_id> # one location

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

// Promoted columns and the fieldKey / friendly-key they map from in
// custom_fields JSONB. GHL is inconsistent on the "double underscore" for
// first_contact — we accept either variant.
//
// `jsonb: true` means this column is JSONB and the value must be a JSON
// array (checkbox-style multi-select in GHL). String values get wrapped in
// a single-element array.
const COLUMN_MAP = [
  { col: 'lead_source_opportunity',    keys: ['lead_source_opportunity', 'opportunity.lead_source_opportunity'] },
  { col: 'client_type',                keys: ['client_type', 'opportunity.client_type'],                                                                                            jsonb: true },
  { col: 'product_system',             keys: ['product_system', 'opportunity.product_system'],                                                                                      jsonb: true },
  { col: 'product_type',               keys: ['product_type', 'opportunity.product_type'],                                                                                          jsonb: true },
  { col: 'first_contact_method',       keys: ['first_contact__method', 'first_contact_method', 'opportunity.first_contact__method', 'opportunity.first_contact_method'],            jsonb: true },
  { col: 'postcode',                   keys: ['postcode', 'opportunity.postcode'] },
  { col: 'inquiry',                    keys: ['inquiry', 'opportunity.inquiry'] },
  { col: 'gclid',                      keys: ['gclid', 'opportunity.gclid'] },
  { col: 'upload_from_enquiry',        keys: ['upload_from_enquiry', 'opportunity.upload_from_enquiry'] },
];

const MEDDIC_COLS = Array.from({ length: 11 }, (_, i) => ({
  col: `meddic_${i + 1}`,
  keys: [`meddic_${i + 1}`, `opportunity.meddic_${i + 1}`]
}));

const NUMERIC_COLS = [
  { col: 'forecast_probability', keys: ['forecast_probability', 'opportunity.forecast_probability'], parse: (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; } }
];

const DATE_COLS = [
  { col: 'forecast_expected_close_date', keys: ['forecast_expected_close_date', 'opportunity.forecast_expected_close_date'], parse: (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); } }
];

// Resolve a value out of custom_fields, trying friendly-key AND field_id
// variants. cfById is { fieldId: friendlyKey } — used when custom_fields
// happens to be keyed by ID rather than name.
function resolveValue(cf, keys, defs) {
  if (!cf || typeof cf !== 'object') return null;
  // Try direct key lookups first.
  for (const k of keys) {
    if (cf[k] !== undefined && cf[k] !== null && cf[k] !== '') return cf[k];
  }
  // Fall through: cf might be keyed by field_id. Reverse-lookup the id
  // whose friendly name matches one of our keys.
  for (const d of defs) {
    const friendly = (d.field_key || d.display_name || '').toLowerCase();
    if (!friendly) continue;
    const bare = friendly.replace(/^opportunity\./, '');
    if (keys.some((k) => k.toLowerCase() === friendly || k.toLowerCase() === bare)) {
      const v = cf[d.field_id];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return null;
}

// Normalise checkbox-style values. GHL sends them as either:
//   ["Crittall"]                          (real array)
//   "[\"Crittall\"]"                      (JSON-encoded string)
//   "Crittall"                            (plain string, single selection)
// For JSONB columns we return a real array of strings (never null-inside-array).
// For TEXT columns we return a comma-joined string.
function coerceArray(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const filtered = v.filter((x) => x != null && x !== '').map(String);
    return filtered.length ? filtered : null;
  }
  if (typeof v === 'string' && v.startsWith('[') && v.endsWith(']')) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((x) => x != null && x !== '').map(String);
        return filtered.length ? filtered : null;
      }
    } catch (_) { /* fall through */ }
  }
  return [String(v)];
}

function coerceText(v) {
  const arr = coerceArray(v);
  if (!arr) return null;
  return arr.join(', ');
}

async function loadOpportunityDefinitions(locationId) {
  const { rows } = await rawQuery(
    `SELECT field_id, field_key, display_name
       FROM ghl_custom_field_definitions
      WHERE location_id = $1 AND object_type = 'opportunity'`,
    [locationId]
  );
  return rows;
}

async function backfillLocation(locationId) {
  const defs = await loadOpportunityDefinitions(locationId);
  if (defs.length === 0) {
    logger.warn({ locationId }, 'backfillOppCF: no opportunity definitions — run customFieldsSync first');
    return { attempted: 0, updated: 0 };
  }

  const { rows } = await rawQuery(
    `SELECT opportunity_id, custom_fields
       FROM opportunities
      WHERE location_id = $1
        AND custom_fields IS NOT NULL
        AND jsonb_typeof(custom_fields) = 'object'`,
    [locationId]
  );

  let updated = 0;
  for (const opp of rows) {
    const cf = opp.custom_fields;
    const patch = {};

    for (const { col, keys, jsonb } of COLUMN_MAP) {
      const raw = resolveValue(cf, keys, defs);
      if (raw == null) continue;
      if (jsonb) {
        const arr = coerceArray(raw);
        // Postgres jsonb type wants JSON text at the parameter — pg will
        // serialise arrays/objects for us if we pass them through, but the
        // driver has been treating strings as JSON literals here (the
        // 22P02 error), so serialise explicitly.
        if (arr && arr.length) patch[col] = { __json: JSON.stringify(arr) };
      } else {
        const t = coerceText(raw);
        if (t != null) patch[col] = t;
      }
    }
    for (const { col, keys } of MEDDIC_COLS) {
      // meddic_1..11 are TEXT columns.
      const t = coerceText(resolveValue(cf, keys, defs));
      if (t != null) patch[col] = t;
    }
    for (const { col, keys, parse } of NUMERIC_COLS) {
      const v = resolveValue(cf, keys, defs);
      const parsed = parse(v);
      if (parsed != null) patch[col] = parsed;
    }
    for (const { col, keys, parse } of DATE_COLS) {
      const v = resolveValue(cf, keys, defs);
      const parsed = parse(v);
      if (parsed != null) patch[col] = parsed;
    }

    const patchKeys = Object.keys(patch);
    if (!patchKeys.length) continue;

    // Only fill NULL cells — don't clobber anything already resolved.
    // For JSONB columns, cast the parameter with ::jsonb so pg serialises
    // the JSON string literally instead of interpreting it as text.
    const setClauses = patchKeys.map((k, i) => {
      const v = patch[k];
      const cast = (v && typeof v === 'object' && v.__json != null) ? '::jsonb' : '';
      return `${k} = COALESCE(${k}, $${i + 3}${cast})`;
    }).join(', ');
    const params = [
      locationId,
      opp.opportunity_id,
      ...patchKeys.map((k) => {
        const v = patch[k];
        return (v && typeof v === 'object' && v.__json != null) ? v.__json : v;
      })
    ];
    const { rowCount } = await rawQuery(
      `UPDATE opportunities
          SET ${setClauses}, updated_at = now()
        WHERE location_id = $1 AND opportunity_id = $2`,
      params
    );
    if (rowCount > 0) updated++;
  }

  logger.info({ locationId, attempted: rows.length, updated, defs: defs.length }, 'backfillOppCF: location complete');
  return { attempted: rows.length, updated };
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const result = await backfillLocation(arg);
    console.log(JSON.stringify({ location_id: arg, ...result }, null, 2));
    return;
  }
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  const totals = { attempted: 0, updated: 0 };
  for (const r of rows) {
    const result = await backfillLocation(r.location_id);
    totals.attempted += result.attempted;
    totals.updated   += result.updated;
  }
  console.log(JSON.stringify({ locations: rows.length, ...totals }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'backfillOppCF: fatal'); process.exit(1); });
