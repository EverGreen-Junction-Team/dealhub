// opsTaskStore.js — where a task's link to its job lives (client question Q4).
//
// Four functions, one store per answer. Only the Deal Hub store is built:
//
//   dealhub       the task is an ordinary GHL CRM task on the job's contact,
//                 so it shows in GHL's task list and in Deal Hub's Tasks tab
//                 as before. The job it belongs to, and the stage, are kept
//                 in ops_task_links — GHL refuses to let an app link a task
//                 to an opportunity ("Relations cannot be modified via OAuth
//                 channel", see ghlAssociations.js).
//
//   ghl_projects  (not built) tasks in GHL Projects (/projects/*), which an
//                 app CAN write. It would implement the same four functions.
//
// Callers go through taskStore() and never name a store.

import { TASK_LINK_STORE } from './opsDecisions.js';
import { createGhlTask } from './ghlTaskWrite.js';

const dealhubStore = {
  name: 'dealhub',

  /** Create a GHL task on the job's contact and link it to the job. */
  async create(install, client, { locationId, job, input, stageKey, userId }) {
    const task = await createGhlTask(install, job.contactId, {
      title: input.title,
      dueDate: input.dueDate,
      completed: false,
      ...(input.body ? { body: input.body } : {}),
      ...(input.assignedTo ? { assignedTo: input.assignedTo } : {})
    });
    if (task?.id) {
      await this.link(client, { locationId, taskId: task.id, job, stageKey, userId });
    }
    return task;
  },

  async link(client, { locationId, taskId, job, stageKey, userId }) {
    await client.query(
      `INSERT INTO ops_task_links (location_id, task_id, job_kind, opportunity_id, stage_key, linked_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id, task_id) DO UPDATE
         SET job_kind = EXCLUDED.job_kind,
             opportunity_id = EXCLUDED.opportunity_id,
             stage_key = EXCLUDED.stage_key,
             linked_by = EXCLUDED.linked_by,
             linked_at = now()`,
      [locationId, taskId, job.kind, job.opportunityId, stageKey || null, userId || null]
    );
  },

  async unlink(client, { locationId, taskId }) {
    await client.query(
      'DELETE FROM ops_task_links WHERE location_id = $1 AND task_id = $2',
      [locationId, taskId]
    );
  },

  /** Tasks on one job, soonest first; completed last. */
  async listForJob(client, { locationId, opportunityId }) {
    const { rows } = await client.query(
      `SELECT t.task_id, t.title, t.body, t.status, t.due_at, t.completed_at,
              t.assigned_to, COALESCE(t.assigned_to_name, u.name) AS assigned_to_name,
              t.contact_id, l.stage_key
         FROM ops_task_links l
         JOIN tasks t ON t.location_id = l.location_id AND t.task_id = l.task_id
         LEFT JOIN users u ON u.location_id = t.location_id AND u.user_id = t.assigned_to
        WHERE l.location_id = $1 AND l.opportunity_id = $2 AND t.deleted_at IS NULL
        ORDER BY (t.status = 'completed'), t.due_at NULLS LAST, t.title`,
      [locationId, opportunityId]
    );
    return rows;
  }
};

const STORES = { dealhub: dealhubStore };

export function taskStore() {
  const store = STORES[TASK_LINK_STORE];
  if (!store) throw new Error(`Task link store "${TASK_LINK_STORE}" is not built`);
  return store;
}
