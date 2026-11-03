// opportunityFieldHistory.js — Stage 2 · append-only field-change log.
//
// Called from stageHistoryWriter.upsertOpportunity BEFORE the UPSERT runs.
// Compares the incoming opportunity payload's tracked fields against the
// current row in `opportunities`. Any differences become new rows in
// opportunity_field_history.
//
// 27 tracked fields — see TRACKED_FIELDS below. Values stored as JSONB so
// scalars, numerics, arrays, and NULL transitions are all captured natively.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

// Fields to track. Names match the columns on `opportunities`.
const TRACKED_FIELDS = [
  // Deal facts (4)
  'status', 'monetary_value', 'assigned_to', 'lost_reason',
  // Three Whys (3)
  'why_want', 'why_buy', 'why_blocker',
  // Forecast (2)
  'forecast_close_date', 'forecast_probability',
  // Pipeline (1)
  'pipeline_id',
  // Composition (3)
  'product_system', 'product_type', 'client_type',
  // MEDDIC (10)
  'meddic_1','meddic_2','meddic_3','meddic_4','meddic_5',
  'meddic_6','meddic_7','meddic_8','meddic_9','meddic_10','meddic_11',
  // Additional custom fields (4)
  'first_contact_method', 'lead_source_opportunity', 'opportunity_source', 'postcode'
];

// Value equality that works for JSONB / arrays / scalars / null.
// We compare via JSON.stringify to catch array-order changes and object
// differences without importing a deep-equal library.
function valueEquals(a, b) {
  if (a === null && b === null) return true;
  if (a === undefined && b === undefined) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  // DATE columns come back from node-postgres as a JS Date, while we produce a
  // 'YYYY-MM-DD' string — so forecast_close_date compared unequal on EVERY
  // event and recorded a change to the value it already held. Same class as the
  // NUMERIC case below, different type.
  //
  // Compared on the calendar day only. The column is DATE, so any time
  // component on the JS side is an artifact of parsing, not a real difference.
  const aDate = a instanceof Date, bDate = b instanceof Date;
  if (aDate || bDate) {
    const day = (v) => {
      if (v instanceof Date) {
        return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
      }
      if (typeof v === 'string' && v.trim()) {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
      }
      return null;
    };
    const da = day(a), db = day(b);
    if (da !== null && db !== null) return da === db;
  }

  if (typeof a === 'object' || typeof b === 'object') {
    const ma = arrayMembers(a);
    const mb = arrayMembers(b);
    if (ma && mb) {
      // Order-insensitive: GHL does not promise a stable order for a
      // multi-select, and ["A","B"] vs ["B","A"] is not a change a rep made.
      if (ma.length !== mb.length) return false;
      const sa = [...ma].sort();
      const sb = [...mb].sort();
      return sa.every((v, i) => v === sb[i]);
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // NUMERIC comes back from node-postgres as a STRING, to preserve precision
  // that a JS float would lose. So the DB's monetary_value is '0.00' while
  // GHL sends the number 0, and a strict === called that a change on every
  // single event — 15,110 rows across 837 deals in the audit, the largest
  // single contributor.
  //
  // Compare numerically when BOTH sides parse as numbers. Deliberately not a
  // loose ==: that would also equate '' with 0 and true with 1.
  if (typeof a !== typeof b) {
    const na = typeof a === 'number' ? a : (typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN);
    const nb = typeof b === 'number' ? b : (typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }

  return a === b;
}

// The members of an array-valued field, whichever representation it arrives in.
//
// Returns null when the value is not array-shaped, so the caller falls back to
// its normal comparison rather than treating a plain string as a one-member
// array — '{}' the literal empty array and '{}' a genuine text value are
// different things, and only the first is ours to unwrap.
function arrayMembers(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v !== 'string') return null;
  const t = v.trim();
  // Postgres array literal: {a,b} or {"a b","c"}.
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1);
  if (inner.trim() === '') return [];
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      // \" and \\ are the only escapes Postgres emits inside a quoted element.
      if (ch === '\\' && i + 1 < inner.length) { cur += inner[++i]; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

// Read the current row from `opportunities` before the UPSERT applies.
// Returns null if the opp doesn't exist yet (first insert — no diff to run).
async function loadCurrent(locationId, opportunityId) {
  const cols = TRACKED_FIELDS.join(', ');
  const { rows } = await rawQuery(
    `SELECT ${cols}
       FROM opportunities
      WHERE location_id = $1 AND opportunity_id = $2`,
    [locationId, opportunityId]
  );
  return rows[0] || null;
}

// Diff incoming opp values against current row. Returns array of
// { fieldKey, oldValue, newValue }.
function diffTrackedFields(current, incoming) {
  if (!current) return []; // first insert — no diff row (baseline is the INSERT itself)
  const changes = [];
  for (const field of TRACKED_FIELDS) {
    const oldValue = current[field];
    const newValue = incoming[field];
    if (newValue === undefined) continue; // caller didn't provide this field — leave alone
    if (!valueEquals(oldValue, newValue)) {
      changes.push({ fieldKey: field, oldValue, newValue });
    }
  }
  return changes;
}

// Write field-change rows. Called BEFORE upsertOpportunity — so we still
// see the OLD value in opportunities when diffing.
export async function recordFieldChanges({
  locationId,
  opportunityId,
  incoming,          // object shaped like TRACKED_FIELDS
  detectedVia,       // 'opportunity_created' | 'opportunity_updated' | 'opportunitiesSync' | ...
  ingestEventId = null
}) {
  if (!opportunityId) return { changes: 0 };
  try {
    const current = await loadCurrent(locationId, opportunityId);
    const diffs = diffTrackedFields(current, incoming);
    if (diffs.length === 0) return { changes: 0 };

    // Insert one row per changed field.
    for (const d of diffs) {
      await rawQuery(
        `INSERT INTO opportunity_field_history
           (location_id, opportunity_id, field_key,
            old_value, new_value,
            detected_via, ingest_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          locationId, opportunityId, d.fieldKey,
          d.oldValue === undefined ? null : JSON.stringify(d.oldValue),
          d.newValue === undefined ? null : JSON.stringify(d.newValue),
          detectedVia, ingestEventId
        ]
      );
    }

    logger.info(
      { locationId, opportunityId, changes: diffs.length, fields: diffs.map((x) => x.fieldKey) },
      'opportunityFieldHistory: recorded'
    );
    return { changes: diffs.length };
  } catch (err) {
    logger.warn(
      { err, locationId, opportunityId },
      'opportunityFieldHistory: failed (non-fatal)'
    );
    return { changes: 0, error: err.message };
  }
}

export { TRACKED_FIELDS };
