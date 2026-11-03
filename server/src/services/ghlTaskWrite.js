// ghlTaskWrite.js — push task creates, edits, completions and deletes to GHL.
//
// Second write path in the app, after ghlContactWrite.js. It deliberately does
// NOT follow that file's shape, and the reason matters:
//
// CONTACTS have a ContactUpdate webhook, so ghlContactWrite writes only to GHL
// and lets the webhook write Postgres. One path to the row, no disagreement.
//
// TASKS DO NOT. GHL fires TaskCreate, TaskComplete and TaskDelete — there is no
// TaskUpdate (see routes/webhooks.js TASK_TYPES, and taskWriter.js, which has
// noted this since migration 015). So for an EDIT there is nothing coming back:
// wait for a webhook that doesn't exist and the change would appear to save,
// then vanish on the next render.
//
// So the rule here is per-operation, not per-file:
//
//   create    → POST, then apply GHL's echo. TaskCreate also fires, and the
//               writer's ON CONFLICT DO UPDATE makes the two converge.
//   complete  → PUT .../completed. TaskComplete fires; we still apply the echo
//               so the checkbox doesn't wait on webhook latency.
//   edit      → PUT, then apply GHL's echo. NOTHING ELSE WILL.
//   delete    → DELETE, then soft-delete locally. TaskDelete fires too.
//
// We apply GHL's ECHOED task rather than the patch we sent, so any
// normalisation GHL performs (date precision, trimming) is what we store — the
// same principle as letting the webhook win, applied to the response body.
//
// One more constraint worth stating: every endpoint is nested on the CONTACT
// (/contacts/{contactId}/tasks/...). A task whose contact_id is NULL — which
// migration 015 allows, because GHL doesn't always attach one — cannot be
// written through this API at all. Callers get a clear error rather than a
// confusing 404 from GHL.

import { ghlRequest } from './ghlClient.js';
import { rejectionMessage, logRejection } from './ghlRejection.js';
import { rawQuery } from '../db.js';
import { buildTaskPatch, TaskWriteError } from './taskPatch.js';
import { logger } from '../utils/logger.js';

export { buildTaskPatch, TaskWriteError };

/**
 * Map a GHL error onto a message a rep can act on.
 *
 * Shared by all four operations: the failure modes are identical and the
 * wording should be too.
 */
function translateGhlError(err, { taskId = null, contactId = null, verb } = {}) {
  const status = err.response?.status;
  const body = err.response?.data;

  if (status === 401 || status === 403) {
    return new TaskWriteError(
      'This app cannot change tasks yet — the contacts.write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (status === 404) {
    return new TaskWriteError(
      'That task no longer exists, or it belongs to a different contact',
      { status: 404 }
    );
  }
  if (status === 422 || status === 400) {
    // Surface GHL's own message — it names the offending field, which anything
    // we invent would not. assignedTo pointing at a user outside the location
    // and a malformed dueDate both land here.
    const detail = body?.message || body?.error
      || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);
    // GHL's own text is LOGGED, never shown — services/ghlRejection.js
    // explains why: it names a field for a validation error, but a raw
    // record id for a missing one, and the whole sales team sees these.
    logRejection('ghlTaskWrite', { status, detail, body });
    const rej = rejectionMessage('task', detail);
    return new TaskWriteError(rej.message, { status: rej.status, detail });
  }
  logger.error(
    { err, status, taskId, contactId, body },
    `ghlTaskWrite: ${verb} failed`
  );
  return new TaskWriteError(`Could not ${verb} the task — try again`, { status: 502 });
}

// Contactless tasks: the location-scoped endpoints.
//
// GHL has TWO task surfaces, and only one of them needs a contact:
//
//   /contacts/:contactId/tasks/:taskId      contact-scoped (what we used)
//   /locations/:locationId/tasks/:taskId    location-scoped
//
// A task created outside a contact — by a workflow, an import, or directly in
// the GHL UI — has no contactId, and every write here required one. So those
// tasks could be listed but never edited, completed or deleted: the app
// answered "This task isn't linked to a contact, so it can't be changed
// here" and there was nowhere else to change it.
//
// The location-scoped path takes the same body and needs no contact, so it is
// the natural fallback. Scope: locations/tasks.write (the contact path uses
// contacts.write — a location missing the newer scope will 401 here, which is
// why the caller reports the failure rather than swallowing it).
//
// NOT used when a contactId IS present: the contact path is what every task in
// this app has been written through, it is the documented one for that shape,
// and switching wholesale would risk a regression across every task write for
// no gain.
function locationTaskUrl(install, taskId, suffix = '') {
  return `/locations/${enc(install.location_id)}/tasks/${enc(taskId)}${suffix}`;
}

// A 401 on the location path almost certainly means the marketplace app is
// missing `locations/tasks.write` — the contact path uses `contacts.write`,
// so every other task write keeps succeeding and the failure looks like a
// dead token rather than a missing scope. Named here so the log says which.
function noteLocationScope(err, { taskId, verb }) {
  if (err?.response?.status === 401) {
    logger.error(
      { taskId, verb, status: 401 },
      'ghlTaskWrite: location-scoped task write returned 401 — the marketplace '
      + 'app likely lacks the locations/tasks.write scope'
    );
  }
  return err;
}

function requireContactId(contactId) {
  if (!contactId) {
    throw new TaskWriteError(
      "This task isn't linked to a contact, so it can't be changed here — " +
      'tasks are edited through the contact they belong to.',
      { status: 400, field: 'contactId' }
    );
  }
}

const enc = encodeURIComponent;

/**
 * Write GHL's echoed task onto our row.
 *
 * Only the fields GHL confirms — never the patch we sent. If GHL silently
 * ignored a field, our row must show what GHL actually stored, not what we
 * hoped it would.
 *
 * COALESCE on every column: the echo is the authority on what it includes, but
 * a field absent from the response means "unchanged", not "cleared".
 * `completed` is the exception — a boolean false is meaningful, so it's mapped
 * to a status explicitly.
 */
async function applyEcho(locationId, taskId, task) {
  if (!task) return null;

  const completed = task.completed === true;
  const dueAt = task.dueDate ? new Date(task.dueDate) : null;

  const { rows } = await rawQuery(
    `UPDATE tasks SET
       title            = COALESCE($3, title),
       body             = COALESCE($4, body),
       due_at           = COALESCE($5, due_at),
       assigned_to      = COALESCE($6, assigned_to),
       status           = $7,
       completed_at     = CASE WHEN $7 = 'completed'
                               THEN COALESCE(completed_at, now())
                               ELSE NULL END,
       raw_task         = COALESCE($8, raw_task),
       updated_at_ghl   = now(),
       updated_at       = now()
     WHERE location_id = $1 AND task_id = $2
     RETURNING task_id`,
    [
      locationId, taskId,
      task.title ?? null,
      task.body ?? null,
      dueAt,
      task.assignedTo ?? null,
      completed ? 'completed' : 'open',
      task
    ]
  );
  return rows[0]?.task_id || null;
}

/**
 * POST /contacts/{contactId}/tasks
 *
 * Returns the created task as GHL echoed it. The row is NOT inserted here —
 * the TaskCreate webhook owns the insert, including the opportunity
 * attribution that only the webhook path knows how to do (attributionEngine).
 * Inserting a second time from here would either duplicate that work or race
 * it.
 */
export async function createGhlTask(install, contactId, input) {
  requireContactId(contactId);
  const { patch, dropped } = buildTaskPatch(input, { create: true });

  if (dropped.length) {
    logger.warn({ contactId, dropped }, 'ghlTaskWrite: ignored non-writable fields');
  }

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: `/contacts/${enc(contactId)}/tasks`,
      data: patch
    });
    const task = data?.task || null;
    logger.info(
      { contactId, taskId: task?.id, fields: Object.keys(patch) },
      'ghlTaskWrite: task created'
    );
    return task;
  } catch (err) {
    throw translateGhlError(err, { contactId, verb: 'create' });
  }
}

/**
 * PUT /contacts/{contactId}/tasks/{taskId}
 *
 * Send only the changed fields. Applies GHL's echo to our row, because no
 * TaskUpdate webhook will.
 */
export async function updateGhlTask(install, { contactId, taskId }, input) {
  if (!taskId) throw new TaskWriteError('Which task?', { status: 400 });

  const { patch, dropped } = buildTaskPatch(input, { create: false });
  if (dropped.length) {
    logger.warn({ taskId, dropped }, 'ghlTaskWrite: ignored non-writable fields');
  }

  let task;
  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      // Location-scoped when the task has no contact — see locationTaskUrl.
      url: contactId
        ? `/contacts/${enc(contactId)}/tasks/${enc(taskId)}`
        : locationTaskUrl(install, taskId),
      data: patch
    });
    task = data?.task || null;
  } catch (err) {
    if (!contactId) noteLocationScope(err, { taskId, verb: 'update' });
    throw translateGhlError(err, { taskId, contactId, verb: 'update' });
  }

  // The write succeeded in GHL. A local failure after this point must not be
  // reported as a failed save — GHL is the source of truth and it has the
  // change. Log loudly; the next daily sync reconciles.
  try {
    await applyEcho(install.location_id, taskId, task);
  } catch (err) {
    logger.error(
      { err, taskId, contactId },
      'ghlTaskWrite: saved to GHL but the local row did not update'
    );
  }

  logger.info(
    { taskId, contactId, fields: Object.keys(patch) },
    'ghlTaskWrite: task updated'
  );
  return task;
}

/**
 * PUT /contacts/{contactId}/tasks/{taskId}/completed
 *
 * The dedicated endpoint, rather than a general update with { completed }.
 * It's the narrowest request for the commonest action — ticking a checkbox —
 * so it can't disturb a title or due date by accident.
 */
export async function setGhlTaskCompleted(install, { contactId, taskId }, completed) {
  if (!taskId) throw new TaskWriteError('Which task?', { status: 400 });
  if (typeof completed !== 'boolean') {
    throw new TaskWriteError('Completed must be true or false', { field: 'completed' });
  }

  let task;
  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      // The contact path has a dedicated /completed sub-resource; the
      // location path does not, so completion there is an ordinary update
      // with { completed } in the body — which is what GHL documents for it.
      url: contactId
        ? `/contacts/${enc(contactId)}/tasks/${enc(taskId)}/completed`
        : locationTaskUrl(install, taskId),
      data: { completed }
    });
    task = data?.task || null;
  } catch (err) {
    if (!contactId) noteLocationScope(err, { taskId, verb: 'complete' });
    throw translateGhlError(err, { taskId, contactId, verb: 'update' });
  }

  // TaskComplete fires for a completion, but not for RE-OPENING one (there's
  // no such event), and in either case the webhook takes a moment. Apply the
  // echo so the checkbox settles immediately.
  try {
    await applyEcho(install.location_id, taskId, task || { completed });
  } catch (err) {
    logger.error(
      { err, taskId, contactId },
      'ghlTaskWrite: completed in GHL but the local row did not update'
    );
  }

  logger.info({ taskId, contactId, completed }, 'ghlTaskWrite: task completion set');
  return task;
}

/**
 * DELETE /contacts/{contactId}/tasks/{taskId}
 *
 * Soft-deletes locally, matching what the TaskDelete webhook does — the row
 * stays for history and every read filters on deleted_at IS NULL.
 */
export async function deleteGhlTask(install, { contactId, taskId }) {
  if (!taskId) throw new TaskWriteError('Which task?', { status: 400 });

  try {
    await ghlRequest(install, {
      method: 'DELETE',
      // No contact? Use the location-scoped path — see locationTaskUrl.
      url: contactId
        ? `/contacts/${enc(contactId)}/tasks/${enc(taskId)}`
        : locationTaskUrl(install, taskId)
    });
  } catch (err) {
    if (!contactId) noteLocationScope(err, { taskId, verb: 'delete' });
    throw translateGhlError(err, { taskId, contactId, verb: 'delete' });
  }

  try {
    await rawQuery(
      `UPDATE tasks
          SET status = 'deleted', deleted_at = now(), updated_at = now()
        WHERE location_id = $1 AND task_id = $2 AND deleted_at IS NULL`,
      [install.location_id, taskId]
    );
  } catch (err) {
    logger.error(
      { err, taskId, contactId },
      'ghlTaskWrite: deleted in GHL but the local row did not update'
    );
  }

  logger.info({ taskId, contactId }, 'ghlTaskWrite: task deleted');
  return true;
}
