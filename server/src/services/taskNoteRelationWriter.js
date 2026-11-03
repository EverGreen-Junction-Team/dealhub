// Task and note links to deals, from RelationCreate / RelationDelete.
//
// ═══════════════════════════════════════════════════════════════════════
// THESE EVENTS WERE BEING DISCARDED
// ═══════════════════════════════════════════════════════════════════════
//
// opportunityContactWriter handles RelationCreate/Delete, but returns early
// for any associationId other than OPPORTUNITIES_CONTACTS_ASSOCIATION —
// logging at DEBUG, so nothing surfaced. Every
//
//     TASK_OPPORTUNITY_ASSOCIATION
//     NOTE_OPPORTUNITY_ASSOCIATION
//
// event arrived and was dropped. A task linked to a deal in GHL showed no
// link here unless the daily association sweep happened to resolve it.
//
// ═══════════════════════════════════════════════════════════════════════
// TASKS ARE MANY, NOTES ARE ONE
// ═══════════════════════════════════════════════════════════════════════
//
// Not a design choice — GHL's caps:
//
//     TASK_OPPORTUNITY_ASSOCIATION   cap 10
//     NOTE_OPPORTUNITY_ASSOCIATION   cap 1
//
// So a task's links go to task_relations (migration 066) AND mirror onto
// tasks.opportunity_id as its primary; a note's link is just the scalar,
// because a join table would imply a capability the API does not have.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const TASK_OPP = 'TASK_OPPORTUNITY_ASSOCIATION';
const NOTE_OPP = 'NOTE_OPPORTUNITY_ASSOCIATION';

export const HANDLED_ASSOCIATIONS = new Set([TASK_OPP, NOTE_OPP]);

/**
 * Resolve which end is which.
 *
 * The webhook contract says firstRecordId is always the task or note and
 * secondRecordId the opportunity. Checked anyway rather than assumed: a
 * reversed payload would otherwise write a task id into opportunity_id, and
 * that mis-filing is silent — the row looks valid and joins to nothing.
 */
function pickPair(event, subjectKey) {
  const a = { key: event.firstObjectKey, id: event.firstRecordId };
  const b = { key: event.secondObjectKey, id: event.secondRecordId };
  if (a.key === subjectKey && b.key === 'opportunity') {
    return { subjectId: a.id, oppId: b.id };
  }
  if (b.key === subjectKey && a.key === 'opportunity') {
    return { subjectId: b.id, oppId: a.id };
  }
  return null;
}

export async function handleTaskNoteRelationCreate(install, event) {
  const locationId = install.location_id;
  const relationId = event.id;
  const associationId = event.associationId || null;

  if (associationId === TASK_OPP) {
    const pair = pickPair(event, 'task');
    if (!pair) {
      logger.warn({ locationId, relationId, event },
        'taskRelation: TASK_OPPORTUNITY payload is not a task↔opportunity pair — dropping');
      return;
    }

    // Every link, so "all deals on this task" is answerable.
    await rawQuery(
      `INSERT INTO task_relations
         (location_id, relation_id, task_id, opportunity_id,
          association_id, last_seen_via, raw_relation, imported_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'webhook',$6, now(), now())
       ON CONFLICT (location_id, relation_id) DO UPDATE SET
         task_id        = EXCLUDED.task_id,
         opportunity_id = EXCLUDED.opportunity_id,
         association_id = EXCLUDED.association_id,
         last_seen_via  = 'webhook',
         raw_relation   = EXCLUDED.raw_relation,
         updated_at     = now()`,
      [locationId, relationId, pair.subjectId, pair.oppId, associationId, event]
    );

    // Mirror onto the scalar ONLY when it is empty.
    //
    // COALESCE, not assignment: nine call sites read tasks.opportunity_id as
    // "the" deal, and letting a second link overwrite the first would move a
    // task between deals in the Deal Hub every time someone added a link.
    // First one wins; the rest live in the join table.
    await rawQuery(
      `UPDATE tasks
          SET opportunity_id = COALESCE(opportunity_id, $3),
              updated_at     = now()
        WHERE location_id = $1 AND task_id = $2`,
      [locationId, pair.subjectId, pair.oppId]
    );

    logger.info(
      { locationId, relationId, taskId: pair.subjectId, opportunityId: pair.oppId },
      'taskRelation: task ↔ opportunity linked'
    );
    return;
  }

  if (associationId === NOTE_OPP) {
    const pair = pickPair(event, 'note');
    if (!pair) {
      logger.warn({ locationId, relationId, event },
        'noteRelation: NOTE_OPPORTUNITY payload is not a note↔opportunity pair — dropping');
      return;
    }

    // Cap 1, so the scalar IS the model. Assigned rather than COALESCEd:
    // GHL replaces a note's deal rather than adding to it, so the newest
    // link is the truth.
    const { rowCount } = await rawQuery(
      `UPDATE notes
          SET opportunity_id = $3, updated_at = now()
        WHERE location_id = $1 AND note_id = $2`,
      [locationId, pair.subjectId, pair.oppId]
    );

    logger.info(
      { locationId, relationId, noteId: pair.subjectId, opportunityId: pair.oppId, rowCount },
      'noteRelation: note ↔ opportunity linked'
    );
  }
}

export async function handleTaskNoteRelationDelete(install, event) {
  const locationId = install.location_id;
  const relationId = event.id;
  const associationId = event.associationId || null;

  if (associationId === TASK_OPP) {
    // Deleted by RELATION ID, which is why that is the table's key: the same
    // task/deal pair can be unlinked and relinked, and keying on the pair
    // would make those indistinguishable.
    const { rowCount } = await rawQuery(
      `DELETE FROM task_relations WHERE location_id = $1 AND relation_id = $2`,
      [locationId, relationId]
    );

    // If the scalar pointed at the deal just unlinked, promote another link
    // rather than leaving the task filed under a deal it no longer belongs
    // to. NULL when none remain.
    const pair = pickPair(event, 'task');
    if (pair) {
      await rawQuery(
        `UPDATE tasks t
            SET opportunity_id = (
                  SELECT tr.opportunity_id FROM task_relations tr
                   WHERE tr.location_id = t.location_id
                     AND tr.task_id     = t.task_id
                   ORDER BY tr.imported_at
                   LIMIT 1
                ),
                updated_at = now()
          WHERE t.location_id = $1
            AND t.task_id     = $2
            AND t.opportunity_id = $3`,
        [locationId, pair.subjectId, pair.oppId]
      );
    }

    logger.info(
      { locationId, relationId, rowCount },
      'taskRelation: task ↔ opportunity unlinked'
    );
    return;
  }

  if (associationId === NOTE_OPP) {
    const pair = pickPair(event, 'note');
    if (!pair) return;
    // Cleared only if it still points at the deal being unlinked — a later
    // relink would otherwise be wiped by an out-of-order delete.
    const { rowCount } = await rawQuery(
      `UPDATE notes
          SET opportunity_id = NULL, updated_at = now()
        WHERE location_id = $1 AND note_id = $2 AND opportunity_id = $3`,
      [locationId, pair.subjectId, pair.oppId]
    );
    logger.info(
      { locationId, relationId, noteId: pair.subjectId, rowCount },
      'noteRelation: note ↔ opportunity unlinked'
    );
  }
}
