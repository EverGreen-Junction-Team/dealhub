// opsDecisions.js — THE ONE PLACE the client's open answers land.
//
// docs/operations-hub-plan.md §4 lists questions the client has not answered
// yet. Slice 1 is built so that none of them blocks it, and every place that
// depends on one reads it from here — nowhere else. When an answer arrives,
// change the value below (and, for Q1 and Q2, fill in the stub the comment
// names); nothing else should need to move.
//
// The dashboard mirrors these in dashboard/src/pages/operations/opsDecisions.js
// for display only. The server is the authority: GET /api/ops/decisions.

// ── Q1 · How does a won deal become a project? ───────────────────────
//
//   null          not decided. POST /api/ops/projects/start answers 409 and
//                 the dashboard shows no "Start project" button. Projects
//                 still exist: any opportunity in the mapped Operations
//                 pipeline is one, however it got there.
//   'new_linked'  create a new opportunity in the Operations pipeline for the
//                 same contact; projects.sales_opportunity_id = the won deal.
//   'move_same'   move the won deal itself into the Operations pipeline.
//
// When set, implement the matching branch in routes/operations.js →
// startProject(), which is already split on this value.
export const START_PROJECT = null;

// ── Q2 · Where do job numbers come from? ─────────────────────────────
//
//   null          not decided. Job numbers and remedial refs are typed by
//                 hand; lists fall back to the deal name.
//   'dealhub'     Deal Hub issues the next number per company →
//                 implement issueJobNumber() below.
//   '<field key>' read from that GHL custom field on the opportunity.
export const JOB_NUMBER_SOURCE = null;

// The remedial reference format, e.g. 'R-{job}-{nn}'. null = typed by hand.
export const REMEDIAL_REF_FORMAT = null;

/** Next job number for a company. Not built until Q2 is answered. */
export async function issueJobNumber(/* client, locationId, businessId */) {
  return null;
}

/** True when job numbers are typed (or issued) in Deal Hub, not read from GHL. */
export function jobNumberIsEditable() {
  return JOB_NUMBER_SOURCE === null || JOB_NUMBER_SOURCE === 'dealhub';
}

/**
 * The job number to show. Typed / issued → the stored one; a GHL field key →
 * that field on the opportunity's custom-field blob.
 */
export function resolveJobNumber(storedJobNumber, opportunityCustomFields) {
  if (jobNumberIsEditable()) return storedJobNumber || null;
  const blob = opportunityCustomFields && typeof opportunityCustomFields === 'object'
    ? opportunityCustomFields : {};
  const v = blob[JOB_NUMBER_SOURCE];
  return v == null || v === '' ? null : String(v);
}

// ── Q4 · Where does a task's link to its job live? ───────────────────
//
//   'dealhub'      (the only store built) — tasks are GHL CRM tasks on the
//                  job's contact; the job link and stage live in
//                  ops_task_links. GHL refuses task→deal links from apps.
//   'ghl_projects' tasks in GHL Projects (/projects/*). Would be a second
//                  store with the same four functions in services/opsTaskStore.js.
export const TASK_LINK_STORE = 'dealhub';

export function decisionsSnapshot() {
  return {
    startProject: START_PROJECT,
    jobNumberSource: JOB_NUMBER_SOURCE,
    remedialRefFormat: REMEDIAL_REF_FORMAT,
    taskLinkStore: TASK_LINK_STORE,
    // What the UI may offer, derived so the dashboard never re-derives it.
    canStartProject: START_PROJECT === 'new_linked' || START_PROJECT === 'move_same',
    jobNumbersAreManual: JOB_NUMBER_SOURCE === null,
    pending: [
      ...(START_PROJECT === null ? ['Q1'] : []),
      ...(JOB_NUMBER_SOURCE === null || REMEDIAL_REF_FORMAT === null ? ['Q2'] : []),
      // Q4 has a working default; it is still the client's to confirm.
      'Q4'
    ]
  };
}
