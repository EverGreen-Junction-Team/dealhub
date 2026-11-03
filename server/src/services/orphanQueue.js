import { rawQuery } from '../db.js';

// Companion to the orphan sweep — manages the pending_opportunities table.
//
// Called by the webhook receiver:
//   - opportunity_created  → enqueue
//   - opportunity_stage_updated / opportunity_deleted → dequeue (cleared)
//
// Column names match James's CSV blueprint (migration 030):
//   observed_stage_id  = stage seen at opportunity creation
//   created_event_at   = when we recorded this pending row
//   sweep_after        = created_event_at + orphan-wait interval (10 min default)

// Grace window before an opp becomes eligible for orphan-sweep processing.
// Kept small — a real stage_updated webhook nearly always arrives within
// seconds of opportunity_created. 10 min is defensive.
const ORPHAN_WAIT_MINUTES = 10;

export async function enqueue(event) {
  // GHL webhooks arrive FLAT — opportunity fields sit at the top level and
  // `event.id` is the opportunity id. The older nested shape (event.opportunity.X)
  // also occasionally shows up (REST replays, internal tests). Try both shapes
  // for every field; fall back to event-level fields last.
  const o = event.opportunity || event;
  const opportunityId =
    event.opportunity?.id || event.opportunityId || event.id;
  const locationId = event.locationId || event.location_id;
  if (!opportunityId || !locationId) return;

  const createdRaw =
    o.createdAt || o.dateAdded || event.dateAdded || event.createdAt;
  const createdAtGhl = createdRaw ? new Date(createdRaw) : new Date();

  await rawQuery(
    `INSERT INTO pending_opportunities (location_id, opportunity_id, contact_id,
        pipeline_id, observed_stage_id, created_at_ghl, created_event_at, sweep_after)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now() + ($7 || ' minutes')::interval)
     ON CONFLICT (location_id, opportunity_id) DO NOTHING`,
    [
      locationId,
      opportunityId,
      o.contactId || event.contactId || null,
      o.pipelineId || event.pipelineId || null,
      o.pipelineStageId || o.stageId || event.pipelineStageId || event.stageId || null,
      createdAtGhl,
      String(ORPHAN_WAIT_MINUTES)
    ]
  );
}

export async function dequeue(locationId, opportunityId) {
  if (!locationId || !opportunityId) return;
  await rawQuery(
    `DELETE FROM pending_opportunities WHERE location_id = $1 AND opportunity_id = $2`,
    [locationId, opportunityId]
  );
}
