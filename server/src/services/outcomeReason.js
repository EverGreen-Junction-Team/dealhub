// outcomeReason.js — which GHL custom field holds "why did this deal close?"
//
// One reason per deal, written to the field that matches the outcome:
//
//   won       -> meddic_10   "10. Deal Won Reason"
//   lost      -> meddic_9    "9. Deal Lost reason"
//   abandoned -> meddic_11   "11. Abandoned Reason"
//
// An open deal has no reason — there is no outcome to explain yet.
//
// WHY A LOOKUP AND NOT AN if/else AT EACH CALL SITE. The mapping is needed in
// four places (the deal read, the status write, the reporting view and the
// dashboard), and the numbers do not follow the status names in any guessable
// order — lost is 9, won is 10, abandoned is 11. Spreading that across call
// sites is how one of them ends up writing the win reason into the lost field.
//
// These are resolved by FIELD KEY, never by field id. Each sub-account has its
// own id for the same key (four locations, four ids for meddic_10), so an id
// hardcoded here would write to the wrong field — or nothing — in three of
// them. ghl_custom_field_definitions maps key -> id per location.
//
// NOTE: at the time of writing "11. Abandoned Reason" exists in ONE of the
// four locations. Nothing breaks in the others; the key simply does not
// resolve and the value is not written. It starts working the moment the
// field is created there, with no code change.

export const OUTCOME_REASON_FIELD = {
  won: 'meddic_10',
  lost: 'meddic_9',
  abandoned: 'meddic_11'
};

// The GHL custom-field key for a status, e.g. 'opportunity.meddic_11'.
export function outcomeReasonKey(status) {
  const col = OUTCOME_REASON_FIELD[String(status || '').toLowerCase()];
  return col ? `opportunity.${col}` : null;
}

// Read the reason off an opportunity row, from whichever column its status
// points at. Returns null for an open deal, an unknown status, or a blank.
export function outcomeReasonFor(row) {
  if (!row) return null;
  const col = OUTCOME_REASON_FIELD[String(row.status || '').toLowerCase()];
  if (!col) return null;
  const v = row[col];
  return v && String(v).trim() ? String(v).trim() : null;
}

// Statuses that require a reason. 'open' is deliberately absent.
export const CLOSED_STATUSES = Object.keys(OUTCOME_REASON_FIELD);
