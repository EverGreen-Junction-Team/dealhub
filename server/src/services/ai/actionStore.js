// actionStore.js — CRUD for ai_actions (migration 077).
//
// The model only ever reaches `proposeAction`: it inserts a 'pending' row
// and returns its id, never touching GHL. `confirmAction`/`rejectAction`
// are called from routes/ai.js's confirm/reject endpoints, which a REP
// drives by clicking a button in the ActionCard — see that route for the
// actual GHL write call this unlocks.

import { withTenant } from '../../db.js';

export async function proposeAction(locationId, {
  runId = null, opportunityId = null, actionType, payload
}) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `INSERT INTO ai_actions (location_id, run_id, opportunity_id, action_type, proposed_payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, action_type, proposed_payload, status`,
      [locationId, runId, opportunityId, actionType, JSON.stringify(payload)]
    );
    return r.rows[0];
  });
}

// A propose tool runs INSIDE the tool loop, before ai_runs has a row for
// this turn at all — recordRun only fires once the loop finishes. So a
// proposal is inserted with run_id NULL and backfilled here, right after
// recordRun returns an id. Harmless if it's ever skipped (run_id is only
// for the audit trail — "which question proposed this" — never read to
// decide whether a confirm is allowed; confirmAction checks status/id, not
// run_id), so a caller need not treat a failure here as fatal to the turn.
export async function linkActionsToRun(locationId, actionIds, runId) {
  if (!actionIds?.length) return;
  return withTenant(locationId, async (client) => {
    await client.query(
      `UPDATE ai_actions SET run_id = $1
        WHERE location_id = $2 AND id = ANY($3::uuid[]) AND run_id IS NULL`,
      [runId, locationId, actionIds]
    );
  });
}

export async function getAction(locationId, actionId) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `SELECT * FROM ai_actions WHERE location_id = $1 AND id = $2`,
      [locationId, actionId]
    );
    return r.rows[0] || null;
  });
}

// Marks the action resolved. `status` is 'confirmed' or 'failed' (a rep hit
// Confirm; GHL accepted or rejected it) or 'rejected' (a rep hit Cancel —
// the model's proposal was simply wrong, and nothing was ever attempted).
//
// Pinned to status = 'pending' in the WHERE clause, not just the id: a
// double-click or a retried request must resolve the SAME row once, not
// re-run the GHL write a second time. Returns 0 rows updated if it was
// already resolved, which the route reads as "nothing to do" rather than
// firing GHL again.
export async function resolveAction(locationId, actionId, {
  status, editedPayload = null, result = null, confirmedBy = null
}) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `UPDATE ai_actions
          SET status = $3, edited_payload = $4, result = $5,
              confirmed_by = $6, resolved_at = now()
        WHERE location_id = $1 AND id = $2 AND status = 'pending'
        RETURNING id, status`,
      [locationId, actionId, status, editedPayload ? JSON.stringify(editedPayload) : null,
       result ? JSON.stringify(result) : null, confirmedBy]
    );
    return r.rows[0] || null;
  });
}

// Flips a FAILED action back to 'pending' — the one exception to "pending
// only moves forward once". A failed confirm is often our own bug (a real
// one shipped: sendGhlMessage referenced an undefined variable and 502'd
// after GHL had already accepted the send) or a transient GHL error, not
// proof the proposal itself was wrong — unlike 'confirmed'/'rejected',
// which are genuinely final. Scoped to status = 'failed' in the WHERE
// clause for the same reason resolveAction pins to 'pending': a stale
// retry on an already-succeeded or already-rejected row must be a no-op,
// never a second write.
export async function retryAction(locationId, actionId) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `UPDATE ai_actions
          SET status = 'pending', result = NULL, resolved_at = NULL
        WHERE location_id = $1 AND id = $2 AND status = 'failed'
        RETURNING id, status`,
      [locationId, actionId]
    );
    return r.rows[0] || null;
  });
}
