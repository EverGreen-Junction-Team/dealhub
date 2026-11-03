// Resolve a GHL customFields payload into a plain { key: value } object.
//
// WHY THIS EXISTS. GHL sends opportunity custom fields in two different shapes
// and we receive BOTH on the same deal:
//
//   enriched  { client_type: 'Trade', ... }        ← getOpportunityFull resolved it
//   raw       [{ id: 'AbC123', fieldValue: 'Trade' }]  ← the bare webhook
//
// pickOpportunity used to handle the array case by throwing it away:
//
//   const cf = o.customFieldsResolved || (Array.isArray(o.customFields) ? {} : ...)
//
// so every promoted column (client_type, product_system, product_type,
// first_contact_method, lead_source_opportunity) came out `undefined` and was
// skipped by the writer. The symptom was a rep picking a value in the dashboard,
// the PUT to GHL succeeding, and the chip still reading "Not set" after a
// reload — the value was in GHL and never in our columns.
//
// The array arrives whenever enrichment could not run: getOpportunityFull
// returns null on a 404, a timeout, or a rate limit, and the caller then falls
// back to the raw webhook body. That is not an edge case — it is the normal
// path under load, and the one our own writes hit most.
//
// KEYED BY ID, NOT NAME. A raw entry identifies its field by id only, so
// resolving needs the location's id→key map. A field whose id is not in the map
// is kept under the bare id rather than dropped: an unknown key is visible in
// custom_fields for diagnosis, whereas a dropped value is the bug above.
//
// No imports on purpose — the caller supplies the map, which keeps this unit
// testable without a database or a GHL token.

// GHL spells the value differently across endpoints and webhook versions.
//
// fieldValueArray FIRST, and this order is the whole point.
//
// The comment here used to say the array carrier appears only when the others
// are absent. That is not true for a multi-select: GHL sends BOTH, with
// fieldValue holding only the FIRST selection —
//
//   { fieldValue: 'Crittall', fieldValueArray: ['Crittall', 'Smarts'] }
//
// so a chain that read fieldValue first stored 'Crittall' and silently dropped
// every other choice. The symptom was a rep picking two systems, the save
// succeeding, and the chip reading one value again after a tab switch: the
// second value reached GHL and was thrown away on the way back in.
//
// An array is never the LESS complete answer, so when one is present it wins.
// An EMPTY array is not an answer though — a single-option field can carry
// `fieldValueArray: []` beside a real scalar, and preferring that would turn
// every single-select into "Not set".
export function fieldValueOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (Array.isArray(entry.fieldValueArray) && entry.fieldValueArray.length > 0) {
    return entry.fieldValueArray;
  }
  return entry.fieldValue
    ?? entry.value
    ?? entry.fieldValueString
    ?? entry.fieldValueArray
    ?? null;
}

// Strip GHL's object prefix so a resolved key matches what the promoted block
// looks up. Their definitions endpoint reports `opportunity.client_type` while
// the writer asks for `client_type`.
export function shortKey(key) {
  return String(key || '').replace(/^(opportunity|contact)\./, '');
}

export function resolveCustomFieldArray(rawFields, idToKey = {}) {
  const out = {};
  if (!Array.isArray(rawFields)) return out;
  for (const entry of rawFields) {
    // An entry may carry its own key — prefer it, since it needs no map.
    const id = entry?.id || entry?.fieldId;
    const own = entry?.fieldKey || entry?.key;
    const resolved = own || idToKey[id] || id;
    if (!resolved) continue;
    out[shortKey(resolved)] = fieldValueOf(entry);
  }
  return out;
}

// The single entry point pickOpportunity calls.
//
// Precedence: an already-resolved object wins, because enrichment mapped it
// against the live definitions. Otherwise resolve the array. A plain object
// under `customFields` is passed through — some older REST responses send that.
export function customFieldsFrom(o = {}, idToKey = {}) {
  if (o.customFieldsResolved && typeof o.customFieldsResolved === 'object') {
    return o.customFieldsResolved;
  }
  const raw = o.customFields ?? o.custom_fields;
  if (Array.isArray(raw)) return resolveCustomFieldArray(raw, idToKey);
  if (raw && typeof raw === 'object') return raw;
  return {};
}

// ── JSONB binding ───────────────────────────────────────────────────────────
//
// Serialize a value for a JSONB column parameter.
//
// WHY THIS IS NEEDED. node-postgres converts a JS ARRAY to a Postgres array
// literal, not to JSON:
//
//   ['Interior Designer', 'Contractor']
//     → {"Interior Designer","Contractor"}        ← Postgres array syntax
//
// which a JSONB column rejects with 22P02 "invalid input syntax for type json".
// A plain OBJECT is serialized to real JSON, so only arrays are affected — and
// every checkbox custom field (client_type, product_system, product_type,
// first_contact_method) is an array.
//
// This stayed hidden until the resolver above started producing real values:
// while the raw customFields array was being discarded these params were always
// null, and null binds fine. Fixing the resolver turned a silent data loss into
// a loud transaction failure — the webhook wrote nothing and logged
// "opportunity writer failed".
//
// Returns a STRING for Postgres to parse as JSON, or null. Unlike
// contactWriter's jsonbOrNull this does NOT wrap a bare scalar as
// { value: v }: these columns hold JSON arrays, and asCheckboxArray has
// already produced an array or null. A stray scalar is wrapped in a
// single-element array so the column's shape stays consistent.
export function jsonbParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    // Already-serialized JSON passes through — a re-stringify would store the
    // JSON text as a JSON *string* ("[\"a\"]" instead of ["a"]).
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) return t;
    return JSON.stringify([v]);
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return JSON.stringify([v]);
}
