// associationRefresher.js — the "safety net" that catches task/note ↔
// opportunity links we didn't see at task/note create time.
//
// ⚠ THIS NET CATCHES NOTHING FOR TASKS, and probably nothing for notes.
//
// It asks GET /associations/relations/record/:opportunityId. Probing the live
// API showed that endpoint returns `relations: []` for task and note links,
// because those are NOT rows in GHL's relations collection — a task's links
// live on the task document itself, which is why
// GET /locations/:locationId/tasks/:taskId is the only surface that returns
// them. So this runs, pages, finds nothing, and fills in nothing, at a cost
// of 2 GHL calls on EVERY opportunity event.
//
// What actually populates these links now:
//   tasks  — taskWriter mirrors the payload's own `relations` array into
//            task_relations on every TaskCreate (and the scalar as before)
//   both   — RelationCreate / RelationDelete webhooks, via
//            taskNoteRelationWriter, which this file's header says replace
//            the need for — the reverse turned out to be true
//
// Left in place rather than deleted: it is harmless, and if GHL ever starts
// returning task relations there it resumes working. But do not rely on it,
// and do not add to it — verify against the live API first.
//
// Called from stageHistoryWriter.handleOpportunityEvent — every time we see
// ANY opportunity event (create/update/status/assignment/monetary/stage/etc.)
// we do a backward-lookup: given the opportunity_id, ask GHL "what tasks
// and notes are linked to you?" and fill in tasks.opportunity_id +
// notes.opportunity_id for any orphaned rows.
//
// This replaces the need for RelationCreate/RelationDelete webhook
// subscriptions. It's slightly delayed (one OpportunityUpdate cycle) but
// simpler and covers every real-world case:
//   - Rep links task to opp after creation → next opp event catches it
//   - Rep unlinks task → we won't detect this, but that's rare and
//     acceptable (task still points at an opp; can clean up in Phase 2)
//
// Cost: 2 extra GHL API calls per opportunity event. Cheap at BGD volume.
//
// Note on the DELETE side: we intentionally don't NULL out opportunity_id
// on missing task IDs — that would create noise if the associations API
// pagination cuts off after 50 items and we haven't asked for more pages.

import { ghlRequest } from './ghlClient.js';
import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const TASK_OPP_ASSOC = 'TASK_OPPORTUNITY_ASSOCIATION';
const NOTE_OPP_ASSOC = 'NOTE_OPPORTUNITY_ASSOCIATION';
const ASSOC_PAGE_LIMIT = 50; // GHL's max per page

// Fetch all related record IDs for a given (recordId, associationId).
// Paginates via `skip` until fewer than PAGE_LIMIT come back.
async function fetchRelatedRecords(install, recordId, associationId) {
  const locationId = install.location_id;
  const ids = [];
  let skip = 0;
  const MAX_PAGES = 20; // safety bound: 20 * 50 = 1000 relations per opp
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      locationId,
      associationIds: associationId,
      skip: String(skip),
      limit: String(ASSOC_PAGE_LIMIT)
    });
    let response;
    try {
      response = await ghlRequest(install, {
        method: 'GET',
        url: `/associations/relations/record/${encodeURIComponent(recordId)}?${params.toString()}`
      });
    } catch (err) {
      // 404 on the record itself is possible if the opp was just deleted.
      // Non-fatal — nothing to link.
      const status = err.response?.status;
      logger[status === 404 ? 'debug' : 'warn'](
        { err, recordId, associationId, status },
        'associationRefresher: fetch failed'
      );
      return ids;
    }
    const batch = response.data?.relations || [];
    for (const r of batch) {
      if (r?.recordId) ids.push(r.recordId);
    }
    if (batch.length < ASSOC_PAGE_LIMIT) break;
    skip += batch.length;
  }
  return ids;
}

// Link the given tasks/notes to an opportunity. We only set opportunity_id
// where it's NULL — if a row is already linked (possibly to a different opp
// via a prior event), we leave it alone. Safe, additive-only behaviour.
async function linkTasksToOpp(locationId, opportunityId, taskIds) {
  if (!taskIds.length) return 0;
  const { rowCount } = await rawQuery(
    `UPDATE tasks
        SET opportunity_id = $2,
            updated_at     = now()
      WHERE location_id = $1
        AND task_id = ANY($3::text[])
        AND opportunity_id IS DISTINCT FROM $2`,
    [locationId, opportunityId, taskIds]
  );
  return rowCount || 0;
}

async function linkNotesToOpp(locationId, opportunityId, noteIds) {
  if (!noteIds.length) return 0;
  const { rowCount } = await rawQuery(
    `UPDATE notes
        SET opportunity_id = $2,
            updated_at     = now()
      WHERE location_id = $1
        AND note_id = ANY($3::text[])
        AND opportunity_id IS DISTINCT FROM $2`,
    [locationId, opportunityId, noteIds]
  );
  return rowCount || 0;
}

// The public entry point. Called from stageHistoryWriter after the
// opportunity itself has been upserted, so foreign-key references land
// cleanly. Best-effort — never throws (opp handler already committed).
export async function refreshAssociationsForOpportunity(install, opportunityId) {
  const locationId = install.location_id;
  if (!opportunityId) return;

  try {
    const [taskIds, noteIds] = await Promise.all([
      fetchRelatedRecords(install, opportunityId, TASK_OPP_ASSOC),
      fetchRelatedRecords(install, opportunityId, NOTE_OPP_ASSOC)
    ]);

    const [tasksLinked, notesLinked] = await Promise.all([
      linkTasksToOpp(locationId, opportunityId, taskIds),
      linkNotesToOpp(locationId, opportunityId, noteIds)
    ]);

    // Only log when something changed — otherwise every opp event would
    // spam a "0 tasks 0 notes" line.
    if (tasksLinked > 0 || notesLinked > 0) {
      logger.info(
        { locationId, opportunityId, tasksLinked, notesLinked, taskCount: taskIds.length, noteCount: noteIds.length },
        'associationRefresher: linked tasks/notes to opportunity'
      );
    }
  } catch (err) {
    logger.warn({ err, locationId, opportunityId }, 'associationRefresher: refresh failed (non-fatal)');
  }
}
