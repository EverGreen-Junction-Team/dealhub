// opportunityFields.js — the opportunity's CUSTOM fields as one vocabulary.
//
// Three readers used to each hold a piece of this: routes/deals.js knew which
// columns are promoted and how to merge them into the blob, the deal editor
// knew the field definitions (labels, picklist options), and the AI knew
// nothing — it could rename a deal or move its stage, but "set the product
// type to bifolds" had no write path at all, because propose_update_deal only
// carried name / value / stage. This file is where a field NAME a rep says
// ("buyer type", "how they found us", "the enquiry") becomes a GHL field id
// with a validated value, so the AI, the editor and the deal response all
// agree on what a field is.
//
// Nothing here writes to GHL. updateGhlOpportunity does, with the
// `customFields: [{ id, field_value }]` shape this file produces.

import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';

// Promoted columns on `opportunities` — custom fields that got a column of
// their own (migrations 027, 136) because the deal list filters and sorts on
// them. The blob still carries them when GHL sends them; the column is the
// fallback when it does not.
export const PROMOTED_CUSTOM_FIELDS = [
  'client_type',
  'product_system',
  'product_type',
  'first_contact_method',
  'lead_source_opportunity',
  'master_initial_enquiry',
  'inquiry',
  'postcode',
  'gclid',
  'upload_from_enquiry'
];

// GHL's key for "first contact method" has a double underscore (the field
// was created with a trailing space in its name). The column is spelt sanely.
export const PROMOTED_KEY_ALIASES = {
  first_contact_method: ['first_contact__method']
};

// Merge the promoted columns into the blob the editor renders from.
//
// The BLOB WINS where it has a value: it is what a save writes back, so
// treating the column as authoritative would make an edit appear to revert
// until the next webhook landed. The column only fills a gap.
export function withPromotedFields(blob, row) {
  const out = { ...(blob && typeof blob === 'object' ? blob : {}) };
  for (const key of PROMOTED_CUSTOM_FIELDS) {
    const value = row[key];
    if (isEmptyValue(value)) continue;
    for (const k of [key, ...(PROMOTED_KEY_ALIASES[key] || [])]) {
      if (isEmptyValue(out[k])) out[k] = value;
    }
  }
  return out;
}

export function isEmptyValue(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

// ── Definitions ──────────────────────────────────────────────────────────

const normaliseOptions = (options) => {
  const values = Array.isArray(options?.values) ? options.values : [];
  return values
    .map((v) => (typeof v === 'string' ? v : (v?.name || v?.value)))
    .filter(Boolean);
};

/**
 * Every active opportunity custom field on a location, from our own
 * catalogue (customFieldsSync keeps it current daily).
 *
 * @returns {Promise<Array<{id, key, shortKey, label, type, options, multiple}>>}
 */
export async function listOpportunityFieldDefs(locationId) {
  const rows = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT d.field_id, d.field_key, d.display_name, d.field_type, d.options,
              d.position, f.position AS folder_position
         FROM ghl_custom_field_definitions d
         LEFT JOIN ghl_custom_field_folders f
           ON  f.location_id = d.location_id
           AND f.object_type = d.object_type
           AND f.folder_id   = d.parent_id
        WHERE d.location_id = $1
          AND d.object_type = 'opportunity'
          AND d.is_active = true
        ORDER BY f.position NULLS LAST, d.position NULLS LAST, d.display_name`,
      [locationId]
    );
    return rows;
  });
  return rows.map((r) => ({
    id: r.field_id,
    key: r.field_key || null,
    shortKey: String(r.field_key || '').replace(/^opportunity\./, ''),
    label: r.display_name || String(r.field_key || '').replace(/^opportunity\./, '') || 'Untitled field',
    type: String(r.field_type || 'TEXT').toUpperCase(),
    options: normaliseOptions(r.options),
    multiple: /CHECKBOX|MULTIPLE/i.test(r.field_type || '')
  }));
}

// ── Resolving a name a rep says to a definition ──────────────────────────

// The words reps (and the dashboard) use for fields whose GHL label says
// something else. "How they found us" is the Deal card's label over
// lead_source_opportunity; "buyer type" is what the client's own brief calls
// client_type. Keyed by a loose phrase, valued by the short keys to try in
// order — the first one that exists on the location wins.
const FIELD_ALIASES = [
  [/^(buyer|client|customer)[\s_-]*type$/, ['client_type']],
  [/^product[\s_-]*type$/, ['product_type']],
  [/^(product[\s_-]*)?system$/, ['product_system']],
  [/^product$/, ['product_type', 'product_system']],
  [/^(lead[\s_-]*source|source|how (they|did they) f(ou|i)nd us|found us|referral source)$/,
    ['lead_source_opportunity']],
  [/^(initial[\s_-]*)?(enquiry|inquiry|enquiry[\s_-]*text|inquiry[\s_-]*text|master[\s_-]*initial[\s_-]*enquiry)$/,
    ['master_initial_enquiry', 'inquiry']],
  [/^(first[\s_-]*)?contact[\s_-]*method$/, ['first_contact_method', 'first_contact__method']],
  [/^(post[\s_-]*code|zip([\s_-]*code)?)$/, ['postcode']]
];

const fold = (s) => String(s || '')
  .toLowerCase()
  .replace(/^opportunity\./, '')
  .replace(/[“”"']/g, '')
  .replace(/[\s_-]+/g, ' ')
  .trim()
  // "the enquiry text", "its product type field" — the words around a
  // field name that a sentence carries and a label does not.
  .replace(/^(the|this|its|their|deal|deals|deal s|opportunity|opportunity s)\s+/, '')
  .replace(/\s+(field|value)$/, '')
  .trim();

/**
 * Find the definition a rep means by a label, key, id, or one of the aliases
 * above. Returns one of:
 *   { def }                      — a single unambiguous match
 *   { candidates: [def, ...] }   — more than one field could be meant
 *   { def: null }                — nothing matched
 */
export function resolveOpportunityField(defs, nameOrKey) {
  const wanted = fold(nameOrKey);
  if (!wanted) return { def: null };

  // 1. Exact: id, key, short key, or label.
  const exact = defs.find((d) =>
    d.id === nameOrKey
    || fold(d.key) === wanted
    || fold(d.shortKey) === wanted
    || fold(d.label) === wanted);
  if (exact) return { def: exact };

  // 2. A known alias.
  for (const [re, keys] of FIELD_ALIASES) {
    if (!re.test(wanted)) continue;
    for (const k of keys) {
      const hit = defs.find((d) => d.shortKey === k);
      if (hit) return { def: hit };
    }
  }

  // 3. A label that contains the phrase (or vice versa), when it is unique.
  //    Labels on this account carry ordinals ("4. Product Type"), which is why
  //    an exact match above is not enough.
  const loose = defs.filter((d) => {
    const label = fold(d.label).replace(/^\d+\s*[.)]\s*/, '');
    return label === wanted || label.includes(wanted) || wanted.includes(label);
  });
  if (loose.length === 1) return { def: loose[0] };
  if (loose.length > 1) return { candidates: loose };
  return { def: null };
}

// ── Coercing a value to what the field accepts ───────────────────────────

const CLEAR_WORDS = new Set(['', 'none', 'clear', 'unset', 'not set', 'remove', 'blank', 'empty', 'null']);

const isClear = (v) => v == null
  || (typeof v === 'string' && CLEAR_WORDS.has(v.trim().toLowerCase()))
  || (Array.isArray(v) && v.length === 0);

// Words with a plural or inflection stripped, so "bifolds" meets "Bifold
// Doors" and "sliders" meets "Sliding Doors" at the stem.
const stem = (w) => w.replace(/(ies|es|s|ing|ed)$/, (m) => (m === 'ies' ? 'y' : ''));
const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(stem);

function matchOption(options, raw) {
  const want = fold(raw);
  if (!want) return null;
  const exact = options.find((o) => fold(o) === want);
  if (exact) return exact;
  // Every word the rep said has to appear (as a stem or a prefix of one)
  // in the option. "bifolds" → Bifold Doors; "doors" → two options, so no
  // pick — the caller lists the choices instead of guessing.
  const wantTokens = tokens(raw);
  const loose = options.filter((o) => {
    const have = tokens(o);
    return wantTokens.length
      && wantTokens.every((w) => have.some((h) => h === w || h.startsWith(w) || w.startsWith(h)));
  });
  if (loose.length === 1) return loose[0];
  const sub = options.filter((o) => fold(o).includes(want) || want.includes(fold(o)));
  return sub.length === 1 ? sub[0] : null;
}

/**
 * Turn what the rep said into the value GHL stores for this field.
 *
 * @returns {{ value: any } | { error: string }}
 *   value is `[]`/`''` for a clear, an array for a multi-select, a string
 *   for a single picklist (the option's canonical spelling), a number for a
 *   numeric field, YYYY-MM-DD for a date, or trimmed text otherwise.
 */
export function coerceFieldValue(def, raw) {
  if (isClear(raw)) return { value: def.multiple ? [] : '' };

  if (def.options.length) {
    const parts = Array.isArray(raw)
      ? raw
      : (def.multiple ? String(raw).split(/\s*(?:,|;|\band\b)\s*/) : [raw]);
    const picked = [];
    for (const p of parts) {
      if (isClear(p)) continue;
      const hit = matchOption(def.options, p);
      if (!hit) {
        return {
          error: `"${p}" is not one of the choices for ${def.label}. `
            + `It can be: ${def.options.join(', ')}.`
        };
      }
      if (!picked.includes(hit)) picked.push(hit);
    }
    if (!picked.length) return { value: def.multiple ? [] : '' };
    if (!def.multiple && picked.length > 1) {
      return { error: `${def.label} takes one choice, not several (${picked.join(', ')}).` };
    }
    return { value: def.multiple ? picked : picked[0] };
  }

  if (/NUMERICAL|NUMBER|MONETORY|MONETARY/.test(def.type)) {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) return { error: `${def.label} needs a number.` };
    return { value: n };
  }

  if (/DATE/.test(def.type)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: `${def.label} needs a date like 2026-04-23.` };
    return { value: d.toISOString().slice(0, 10) };
  }

  if (Array.isArray(raw)) return { value: raw.map((v) => String(v)).join(', ') };
  return { value: String(raw).trim() };
}

// ── Current values ───────────────────────────────────────────────────────

/**
 * The deal's custom field values, blob merged with promoted columns, keyed
 * by short key (and whatever other keys the blob already used).
 */
export async function currentFieldValues(locationId, opportunityId) {
  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT custom_fields, ${PROMOTED_CUSTOM_FIELDS.join(', ')}
         FROM opportunities
        WHERE location_id = $1 AND opportunity_id = $2`,
      [locationId, opportunityId]
    );
    if (!rows.length) return null;
    return withPromotedFields(rows[0].custom_fields, rows[0]);
  });
}

/** Look one field's current value up in a merged blob, by any of its names. */
export function valueOf(blob, def) {
  if (!blob) return null;
  const keys = [def.shortKey, def.key, def.id, ...(PROMOTED_KEY_ALIASES[def.shortKey] || [])];
  // The aliases run both ways: the column is first_contact_method, the blob
  // key first_contact__method.
  for (const [col, aliases] of Object.entries(PROMOTED_KEY_ALIASES)) {
    if (aliases.includes(def.shortKey)) keys.push(col);
  }
  for (const k of keys) {
    if (k && !isEmptyValue(blob[k])) return blob[k];
  }
  return null;
}

/** A value as a rep reads it: arrays joined, nested {value} unwrapped. */
export function displayValue(v) {
  if (isEmptyValue(v)) return null;
  if (Array.isArray(v)) {
    const parts = v.map(displayValue).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'object') {
    if ('value' in v) return displayValue(v.value);
    if ('name' in v) return displayValue(v.name);
    if ('url' in v) return displayValue(v.url);
    return null;
  }
  const s = String(v).trim();
  return s || null;
}

/**
 * Definitions with the deal's current value on each — what the AI is shown
 * so "what is the buyer type" is a fact and "set it to homeowner" knows the
 * field exists and what it accepts.
 */
export async function fieldsWithValues(locationId, opportunityId) {
  try {
    const [defs, blob] = await Promise.all([
      listOpportunityFieldDefs(locationId),
      currentFieldValues(locationId, opportunityId)
    ]);
    return defs
      // File-upload fields cannot be set from a sentence.
      .filter((d) => !/FILE_UPLOAD|SIGNATURE/.test(d.type))
      .map((d) => ({
        label: d.label,
        key: d.shortKey,
        value: displayValue(valueOf(blob, d)),
        options: d.options.length ? d.options : undefined,
        multiple: d.multiple || undefined
      }));
  } catch (err) {
    logger.warn({ err, locationId, opportunityId }, 'opportunityFields: could not load field values');
    return [];
  }
}

// ── Clearing, on our side ────────────────────────────────────────────────
//
// Write CLEARED custom fields to our own columns, because the webhook cannot.
//
// Clearing a multi-select sends field_value: [] to GHL and succeeds. GHL then
// fires OpportunityUpdate — but its payload OMITS the field it just emptied
// rather than reporting it as empty. stageHistoryWriter reads that absence
// through absent(), which correctly returns undefined ("GHL did not send
// this"), binds NULL, and the UPSERT's
//   COALESCE(EXCLUDED.product_system, opportunities.product_system)
// keeps the stored value. So the clear reached GHL and never reached us: the
// chip emptied, the refetch brought the old value back, and no error was
// logged anywhere because nothing failed.
//
// The COALESCE is right and must stay — a bare webhook carries no custom
// fields at all, and treating that as "clear everything" would wipe every
// promoted column on each event. Absence genuinely cannot be read as a clear.
//
// What makes this case different is that WE know: the request said
// field_value: []. That intent exists only where the request was received —
// the deal PATCH route and the AI action executor — which is why both call
// this.
const CLEARABLE_COLUMNS = {
  client_type: 'client_type',
  product_system: 'product_system',
  product_type: 'product_type',
  first_contact__method: 'first_contact_method',
  first_contact_method: 'first_contact_method',
  lead_source_opportunity: 'lead_source_opportunity',
  master_initial_enquiry: 'master_initial_enquiry',
  inquiry: 'inquiry',
  postcode: 'postcode'
};

export async function applyClearedCustomFields(locationId, opportunityId, customFields) {
  if (!Array.isArray(customFields) || customFields.length === 0) return;

  // An EMPTY value is the only thing handled here. A field being set to
  // something is already carried by the webhook, which reports values it has.
  const cleared = customFields.filter((f) => {
    const v = f?.field_value !== undefined ? f.field_value : f?.fieldValue;
    return Array.isArray(v) ? v.length === 0 : (v === '' || v === null);
  });
  if (cleared.length === 0) return;

  try {
    await withTenant(locationId, async (client) => {
      for (const f of cleared) {
        if (!f?.id) continue;
        const { rows } = await client.query(
          `SELECT field_key FROM ghl_custom_field_definitions
            WHERE location_id = $1 AND field_id = $2
              AND object_type = 'opportunity'
            LIMIT 1`,
          [locationId, f.id]
        );
        const shortKey = String(rows[0]?.field_key || '').replace(/^opportunity\./, '');
        const column = CLEARABLE_COLUMNS[shortKey];
        // A field with no promoted column of its own lives in the
        // custom_fields JSONB blob, which the webhook rewrites wholesale on
        // every event — so it clears itself and needs nothing here.
        if (!column) continue;

        // The column name comes from the FIXED map above, never from the
        // request: it is interpolated into the SQL text, where a placeholder
        // cannot be used.
        await client.query(
          `UPDATE opportunities SET ${column} = NULL, updated_at = now()
            WHERE location_id = $1 AND opportunity_id = $2`,
          [locationId, opportunityId]
        );
      }
    });
  } catch (err) {
    // The GHL write SUCCEEDED — reporting a failure here would tell the rep
    // their change did not save when it did. The next event that carries the
    // field reconciles us.
    logger.warn(
      { err, locationId, opportunityId },
      'deal patch: cleared custom fields could not be applied locally'
    );
  }
}
