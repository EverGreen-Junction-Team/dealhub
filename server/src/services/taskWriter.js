// taskWriter.js — handles TaskCreate / TaskComplete / TaskDelete webhooks.
// Writes to the `tasks` table (migration 015).
//
// Design:
//   - TaskCreate → INSERT row with status='open'. opportunity_id is inferred
//     immediately via the shared attribution engine (opportunity_contacts +
//     rules — same logic that attributes messages). This means followers'
//     tasks get linked, not just the primary contact's. The OpportunityUpdate
//     handler (see stageHistoryWriter.js) is still wired as the safety-net
//     that verifies against GHL's own association API and overwrites if
//     they disagree.
//   - TaskComplete → UPDATE row: status='completed', stamp completed_at.
//   - TaskDelete → UPDATE row: status='deleted', stamp deleted_at.
//   - No TaskUpdate webhook exists in GHL — edits to title/dueDate happen
//     silently. Accepted trade-off.
//
// GHL task payload shape (webhook, best observed):
//   { id, contactId, assignedTo, title, body, completed, dueDate,
//     dateAdded, dateUpdated, locationId }
// `raw_task` stashes the full payload for future field extraction.

import { rawQuery } from '../db.js';
import { ensureContactExists } from './contactStub.js';
import { resolveOppForContact } from './attributionEngine.js';
import {
  consumePendingDealLink, ENTITY_TASK
} from './pendingDealLink.js';
import { logger } from '../utils/logger.js';

// Read a relation off a task payload's own relations array.
//
// Task relations are stored ON THE TASK DOCUMENT (not as rows in GHL's
// relations collection), which is why they can appear inline here — and also
// why GET /associations/relations/:recordId does NOT return them, so this is
// the only place a task's own payload can tell us.
//
// Opportunistic, not assumed: `relations` is @HideApiProperty on GHL's task
// DTOs and is absent from some webhook shapes. When it is missing we fall
// through to the attribution engine exactly as before.
function relationFrom(payload, objectKey) {
  const rels = Array.isArray(payload?.relations) ? payload.relations : [];
  return rels.find((r) => r?.objectKey === objectKey)?.recordId || null;
}

// EVERY relation of a kind, not just the first.
//
// relationFrom above takes one, because tasks.opportunity_id is a scalar. But
// GHL's cap is 10, and a real task confirmed by probing the API carried two
// opportunities:
//
//   GET /locations/{locationId}/tasks/{taskId}
//   relations: [ {contact, PzC9…}, {opportunity, GJE1…}, {opportunity, v5Mp…} ]
//
// The webhook payload carries the same array, so the extra links were being
// discarded on every TaskCreate/TaskUpdate. task_relations (migration 066)
// was populated ONLY by RelationCreate webhooks, which means a task whose
// links predate that webhook — or whose RelationCreate we never received —
// showed just one deal however many it really had.
function relationsFrom(payload, objectKey) {
  const rels = Array.isArray(payload?.relations) ? payload.relations : [];
  const out = [];
  for (const r of rels) {
    if (r?.objectKey !== objectKey) continue;
    const id = r.recordId;
    // De-duplicated: the same pair appearing twice would violate nothing in
    // GHL but would produce two rows for one link here.
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  }
  return out;
}

function pickTaskFields(payload) {
  return {
    taskId: payload.id || payload.taskId,
    contactId: payload.contactId || null,
    assignedTo: payload.assignedTo || null,
    title: payload.title || null,
    body: payload.body || null,
    dueAt: payload.dueDate ? new Date(payload.dueDate) : null,
    createdAtGhl: payload.dateAdded ? new Date(payload.dateAdded) : null,
    updatedAtGhl: payload.dateUpdated ? new Date(payload.dateUpdated) : null,
    // GHL's own links, when the payload carries them. An explicit relation
    // beats our inference — see where these are used below.
    relatedOpportunityId: relationFrom(payload, 'opportunity'),
    relatedBusinessId: relationFrom(payload, 'business'),
    // All of them, for task_relations. The scalar above stays the primary.
    //
    // null, not [], when the payload carries NO relations array. relationsFrom
    // returns [] for both "this task has no deals" and "GHL omitted the array"
    // — and those must not behave the same: `relations` is @HideApiProperty on
    // GHL's task DTOs and some webhook shapes drop it, so treating absent as
    // empty would delete every link on the next unrelated task edit.
    relatedOpportunityIds: Array.isArray(payload?.relations)
      ? relationsFrom(payload, 'opportunity')
      : null,
    raw: payload
  };
}

// Resolve owner's display name from the local `users` table. Kept trivial —
// if the user isn't in `users` yet (e.g. task created before backfill ran)
// the name column stays NULL and gets filled when the next UserUpdate for
// that user arrives.
async function resolveAssignedToName(locationId, userId) {
  if (!userId) return null;
  const { rows } = await rawQuery(
    `SELECT name FROM users WHERE location_id = $1 AND user_id = $2 LIMIT 1`,
    [locationId, userId]
  );
  return rows[0]?.name || null;
}

// --- TaskCreate --------------------------------------------------------

export async function handleTaskCreate(install, event) {
  const locationId = install.location_id;
  const t = pickTaskFields(event);
  if (!t.taskId) {
    logger.warn({ event }, 'taskWriter: TaskCreate missing task id — dropping');
    return;
  }

  const assignedToName = await resolveAssignedToName(locationId, t.assignedTo);

  // FK safety: TaskCreate can arrive before ContactCreate on out-of-order
  // deliveries, and for leads that pre-existed in GHL but haven't been
  // captured yet. Ensure the parent contact row exists (stub if needed)
  // so the FK doesn't reject. contactsSync fills in the real fields.
  await ensureContactExists(locationId, t.contactId);

  // Infer the linked opportunity via the shared attribution engine
  // (opportunity_contacts + rules). Best-effort — a null result means the
  // contact isn't linked to any opp, or the link is ambiguous, and the
  // task will stay contact-only until the OpportunityUpdate safety-net
  // verifies against GHL's association API.
  // GHL's OWN relation first, inference only as a fallback.
  //
  // resolveOppForContact guesses from opportunity_contacts and rules; a
  // relations entry is what a human actually linked. Preferring the guess over
  // the fact would file a task against the wrong deal whenever a contact has
  // more than one — precisely the ambiguous case the engine is weakest on.
  let inferredOppId = t.relatedOpportunityId;
  let decision = null;
  // TRUE when the deal came from a person — a pick made at create time.
  // Written to tasks.deal_set_manually so the rule never revises it (068).
  let setDealManually = false;
  // Declared OUT HERE with the other decision variables, not inside the
  // branch that fills it: the INSERT below reads it for created_by /
  // created_via, and a block-scoped `const` left that a ReferenceError at
  // runtime — the module loaded cleanly and only a real TaskCreate webhook
  // ever reached the line.
  let pending = null;
  if (!inferredOppId) {
    // A PERSON's choice outranks the rule — including a deliberate unlink.
    //
    // opportunity_id = NULL alone reads as "not decided yet", so the rule
    // refilled every unlink on the next sync of that task. deal_set_manually
    // (migration 068) is the difference between "no deal yet" and "no deal,
    // on purpose" — the same idea as the manually_resolved guard messages use.
    const held = await rawQuery(
      `SELECT opportunity_id, deal_set_manually FROM tasks
        WHERE location_id = $1 AND task_id = $2`,
      [locationId, t.taskId]
    );
    const manual = held.rows[0]?.deal_set_manually === true;

    // Did the rep choose a deal when they CREATED this task? (migration 069)
    //
    // Checked before the rule and wins outright — an explicit choice is an
    // answer, not a hint. Consuming it deletes the intent so a later webhook
    // for the same task cannot pick up a stale one.
    //
    // null = nobody chose (infer); { opportunityId: null } = the rep chose
    // "no deal" (do not infer).
    pending = manual
      ? null
      : await consumePendingDealLink(locationId, ENTITY_TASK, t.taskId);

    if (manual) {
      // Exactly what the person chose, NULL included.
      inferredOppId = held.rows[0]?.opportunity_id || null;
    } else if (pending) {
      inferredOppId = pending.opportunityId;
      // A person chose it, so the rule must never revise it later.
      setDealManually = true;
    } else {
      decision = await resolveOppForContact(
        locationId, t.contactId, t.createdAtGhl || new Date()
      );
      inferredOppId =
        decision && decision.mappingStatus === 'mapped' ? decision.opportunityId : null;
    }
  }

  // ON CONFLICT DO UPDATE handles the rare retry case where the same
  // TaskCreate is delivered twice (dedup at webhook layer should catch it,
  // but belt-and-braces at the writer level too). On conflict we only fill
  // opportunity_id when it was NULL — never overwrite an existing link
  // (a prior associationRefresher pass may have already stamped the truth
  // from GHL, and we don't want to clobber it with our inference).
  await rawQuery(
    `INSERT INTO tasks (
       location_id, task_id, contact_id, opportunity_id, business_id,
       assigned_to, assigned_to_name,
       title, body, status, due_at,
       raw_task, from_backfill,
       created_at_ghl, updated_at_ghl,
       deal_set_manually,
       -- APPENDED AT THE END, deliberately. Inserting a column mid-list while
       -- binding its parameter last silently shifts every placeholder after
       -- it — a bug that reads as "some other field is wrong".
       created_by, created_via,
       imported_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11,false,$12,$13,$14,$15,$16, now(), now())
     ON CONFLICT (location_id, task_id) DO UPDATE SET
       contact_id       = COALESCE(EXCLUDED.contact_id, tasks.contact_id),
       -- A manual decision is kept VERBATIM, NULL included — COALESCE alone
       -- cannot express "deliberately no deal".
       opportunity_id   = CASE WHEN tasks.deal_set_manually THEN tasks.opportunity_id
                               ELSE COALESCE(tasks.opportunity_id, EXCLUDED.opportunity_id) END,
       -- Latches ON only: a create-time pick sets it, and a later webhook
       -- carrying no pick is not a retraction.
       deal_set_manually = tasks.deal_set_manually OR EXCLUDED.deal_set_manually,
       -- Existing value wins, like opportunity_id above: a payload without a
       -- relations array yields null, and that absence is not a removal.
       business_id      = COALESCE(tasks.business_id, EXCLUDED.business_id),
       assigned_to      = COALESCE(EXCLUDED.assigned_to, tasks.assigned_to),
       assigned_to_name = COALESCE(EXCLUDED.assigned_to_name, tasks.assigned_to_name),
       title            = COALESCE(EXCLUDED.title, tasks.title),
       body             = COALESCE(EXCLUDED.body, tasks.body),
       due_at           = COALESCE(EXCLUDED.due_at, tasks.due_at),
       raw_task         = EXCLUDED.raw_task,
       updated_at_ghl   = COALESCE(EXCLUDED.updated_at_ghl, tasks.updated_at_ghl),
       -- Write-once. Who created a task is a fact about a moment that has
       -- already passed; a later webhook carrying nothing must not blank it,
       -- and nothing can legitimately change it afterwards.
       created_by       = COALESCE(tasks.created_by, EXCLUDED.created_by),
       created_via      = COALESCE(tasks.created_via, EXCLUDED.created_via),
       updated_at       = now()`,
    [
      locationId, t.taskId, t.contactId, inferredOppId, t.relatedBusinessId,
      t.assignedTo, assignedToName,
      t.title, t.body, t.dueAt,
      t.raw, t.createdAtGhl, t.updatedAtGhl,
      // $14 — the deal came from a person (a pick made at create time), so
      // the rule must never revise it.
      setDealManually,
      // $15/$16 — provenance, from the intent parked at create time. GHL has
      // no creator field on a task, so if we did not record it here it would
      // be unknowable. NULL for anything synced from GHL or made before this.
      pending?.createdBy || null,
      pending?.createdVia || null
    ]
  );

  await syncTaskRelations(locationId, t.taskId, t.relatedOpportunityIds);

  logger.info(
    {
      locationId, taskId: t.taskId, contactId: t.contactId,
      assignedTo: t.assignedTo,
      inferredOppId,
      // null distinguishes "GHL sent no relations array" from "zero deals".
      dealCount: t.relatedOpportunityIds?.length ?? null,
      businessId: t.relatedBusinessId,
      // Which source won — a relation from GHL or our own inference. Worth
      // logging: they disagree exactly when a contact has several deals.
      oppSource: t.relatedOpportunityId ? 'ghl-relation' : (decision ? 'inferred' : 'none'),
      attributionRule: decision?.rule || null,
      attributionStatus: decision?.mappingStatus || null
    },
    'taskWriter: TaskCreate applied'
  );
}

// Mirror a task's opportunity links into task_relations (migration 066).
//
// The payload's `relations` array is AUTHORITATIVE when present: it is GHL's
// own list, so a link missing from it has been removed there. That is why this
// deletes rows the payload no longer carries — a RelationDelete we never
// received would otherwise leave a phantom deal on the task forever.
//
// When `relations` is ABSENT it is not an empty list. `relations` is
// @HideApiProperty on GHL's task DTOs and some webhook shapes omit it
// entirely, so treating absent as "no deals" would wipe every link on the
// next unrelated task edit. Absent means "no information" and we leave the
// table alone.
//
// Ids are prefixed `payload:` so they never collide with a webhook's own
// relation_id, and ON CONFLICT keeps whichever arrived first — a real
// RelationCreate id is better than a synthetic one, and this must not
// overwrite it.
async function syncTaskRelations(locationId, taskId, oppIds) {
  // null = the payload had no relations array, i.e. no information. Leaving
  // the table untouched is the only safe reading; see relatedOpportunityIds.
  if (!Array.isArray(oppIds)) return;
  try {
    if (oppIds.length) {
      await rawQuery(
        `INSERT INTO task_relations (
           location_id, relation_id, task_id, opportunity_id,
           association_id, last_seen_via, raw_relation, imported_at, updated_at
         )
         SELECT $1, 'payload:' || $2 || ':' || o, $2, o,
                'TASK_OPPORTUNITY_ASSOCIATION', 'task-payload', NULL, now(), now()
           FROM unnest($3::text[]) AS o
          -- Skip a deal we ALREADY hold under a different relation_id.
          --
          -- ON CONFLICT cannot do this: the primary key is relation_id, so a
          -- webhook's real id ('rel-abc') and our synthetic one
          -- ('payload:task:opp') are two different keys for the SAME link,
          -- and the insert produced two rows for one deal — double-counting
          -- it everywhere the UI reads this table. Verified against Postgres:
          -- without this clause, oppTHIRD came back twice.
          WHERE NOT EXISTS (
            SELECT 1 FROM task_relations ex
             WHERE ex.location_id    = $1
               AND ex.task_id        = $2
               AND ex.opportunity_id = o
          )
         ON CONFLICT (location_id, relation_id) DO UPDATE SET
           updated_at = now()`,
        [locationId, taskId, oppIds]
      );
    }
    // Anything we hold that GHL no longer lists.
    await rawQuery(
      `DELETE FROM task_relations
        WHERE location_id = $1
          AND task_id     = $2
          AND NOT (opportunity_id = ANY($3::text[]))`,
      [locationId, taskId, oppIds]
    );
  } catch (err) {
    // Never fail the task write for this. The task row and its primary deal
    // are already committed; the extra links are enrichment, and the next
    // TaskUpdate or RelationCreate reconciles them.
    logger.warn(
      { err, locationId, taskId, oppIds },
      'taskWriter: could not mirror task relations — the task itself is saved'
    );
  }
}

// --- TaskComplete ------------------------------------------------------

export async function handleTaskComplete(install, event) {
  const locationId = install.location_id;
  const t = pickTaskFields(event);
  if (!t.taskId) {
    logger.warn({ event }, 'taskWriter: TaskComplete missing task id — dropping');
    return;
  }

  // UPDATE-only. If we've never seen a TaskCreate for this task (theoretical
  // ordering issue), the row won't exist and this affects 0 rows. Log it so
  // we can spot the pattern; do not phantom-INSERT because we'd be missing
  // most of the task fields.
  const { rowCount } = await rawQuery(
    `UPDATE tasks
        SET status         = 'completed',
            completed_at   = COALESCE(completed_at, now()),
            updated_at_ghl = COALESCE($3, updated_at_ghl),
            raw_task       = $4,
            updated_at     = now()
      WHERE location_id = $1 AND task_id = $2`,
    [locationId, t.taskId, t.updatedAtGhl, t.raw]
  );

  if (rowCount === 0) {
    logger.warn(
      { locationId, taskId: t.taskId },
      'taskWriter: TaskComplete for unknown task_id — TaskCreate may have been missed'
    );
    return;
  }
  logger.info({ locationId, taskId: t.taskId }, 'taskWriter: TaskComplete applied');
}

// --- TaskDelete --------------------------------------------------------

export async function handleTaskDelete(install, event) {
  const locationId = install.location_id;
  const t = pickTaskFields(event);
  if (!t.taskId) {
    logger.warn({ event }, 'taskWriter: TaskDelete missing task id — dropping');
    return;
  }

  const { rowCount } = await rawQuery(
    `UPDATE tasks
        SET status     = 'deleted',
            deleted_at = COALESCE(deleted_at, now()),
            updated_at = now()
      WHERE location_id = $1 AND task_id = $2`,
    [locationId, t.taskId]
  );

  if (rowCount === 0) {
    logger.warn(
      { locationId, taskId: t.taskId },
      'taskWriter: TaskDelete for unknown task_id — never saw TaskCreate'
    );
    return;
  }
  logger.info({ locationId, taskId: t.taskId }, 'taskWriter: TaskDelete applied');
}
