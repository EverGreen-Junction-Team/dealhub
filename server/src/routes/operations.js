// /api/ops — Operations Hub, slice 1. See docs/operations-hub-plan.md.
//
// HYBRID: a job's STAGE is its GHL opportunity's stage, in the Operations or
// Remedials pipeline mapped in ops_settings. Everything else about the job —
// facts, checklist steps, time, which tasks belong to it — is ours, in the
// tables from migration 146.
//
// An opportunity in the mapped pipeline IS a job. Its row in projects /
// remedials is created the first time anyone opens or edits it, so these
// routes do not depend on how opportunities arrive there (client question
// Q1). Everything that does depend on an open question reads it from
// services/opsDecisions.js.

import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { contactLabel } from '../utils/contactLabel.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import { updateGhlOpportunity, createGhlOpportunity } from '../services/ghlOpportunityWrite.js';
import { OpportunityWriteError } from '../services/opportunityPatch.js';
import { TaskWriteError } from '../services/ghlTaskWrite.js';
import { recordPendingDealLink, ENTITY_TASK } from '../services/pendingDealLink.js';
import { userMessage } from '../utils/userMessage.js';
import { logger } from '../utils/logger.js';
import {
  stagesFor, stageKeyForName, matchPipelineStages, nextStageKey,
  templateSteps, TIME_ACTIVITIES, parseHours, JOB_KINDS
} from '../services/opsStages.js';
import {
  START_PROJECT, decisionsSnapshot, jobNumberIsEditable, resolveJobNumber, issueJobNumber
} from '../services/opsDecisions.js';
import { taskStore } from '../services/opsTaskStore.js';

export const operationsRouter = express.Router();
operationsRouter.use(requireSession);

// 'projects' / 'remedials' in a path → 'project' / 'remedial'.
const KIND_BY_PATH = { projects: 'project', remedials: 'remedial' };
const TABLE = { project: 'projects', remedial: 'remedials' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v));

class OpsError extends Error {
  constructor(message, status = 400, field = null, reason = null) {
    super(message);
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

function sendError(res, next, err, what, ctx) {
  if (err instanceof OpsError) {
    return res.status(err.status).json({ error: err.message, field: err.field, reason: err.reason });
  }
  if (err instanceof OpportunityWriteError || err instanceof TaskWriteError) {
    return res.status(err.status || 422).json({ error: err.message, field: err.field || null });
  }
  if (err?.code === '23505') {
    // A unique index: job number or remedial ref already used.
    return res.status(409).json({ error: 'That number is already used by another job', field: err.constraint?.includes('ref') ? 'ref' : 'jobNumber' });
  }
  logger.error({ err, ...ctx }, `${what} failed`);
  return next(err);
}

// ── Settings: which GHL pipeline is which ────────────────────────────

async function loadSettings(client, locationId) {
  const { rows: [s] } = await client.query(
    'SELECT operations_pipeline_id, remedials_pipeline_id FROM ops_settings WHERE location_id = $1',
    [locationId]
  );
  return {
    operationsPipelineId: s?.operations_pipeline_id || null,
    remedialsPipelineId: s?.remedials_pipeline_id || null
  };
}

const pipelineIdFor = (settings, kind) =>
  (kind === 'remedial' ? settings.remedialsPipelineId : settings.operationsPipelineId);

async function stageMatch(client, locationId, pipelineId, kind) {
  if (!pipelineId) return { byKey: {}, missing: stagesFor(kind).map((s) => s.name), extra: [], ok: false };
  const { rows } = await client.query(
    `SELECT stage_id, name, position FROM pipeline_stages
      WHERE location_id = $1 AND pipeline_id = $2 AND is_active = true
      ORDER BY position`,
    [locationId, pipelineId]
  );
  return matchPipelineStages(kind, rows);
}

operationsRouter.get('/settings', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const out = await withTenant(locationId, async (client) => {
      const settings = await loadSettings(client, locationId);
      const { rows: pipelines } = await client.query(
        `SELECT p.pipeline_id, p.name,
                COALESCE(json_agg(json_build_object('stage_id', s.stage_id, 'name', s.name, 'position', s.position)
                         ORDER BY s.position) FILTER (WHERE s.stage_id IS NOT NULL), '[]') AS stages
           FROM pipelines p
           LEFT JOIN pipeline_stages s
             ON s.location_id = p.location_id AND s.pipeline_id = p.pipeline_id AND s.is_active = true
          WHERE p.location_id = $1 AND p.is_active = true
          GROUP BY p.pipeline_id, p.name
          ORDER BY p.name`,
        [locationId]
      );
      const check = (kind) => {
        const id = pipelineIdFor(settings, kind);
        const p = pipelines.find((x) => x.pipeline_id === id);
        if (!p) return null;
        const m = matchPipelineStages(kind, p.stages);
        return { pipelineId: id, pipelineName: p.name, ok: m.ok, missing: m.missing, extra: m.extra };
      };
      return {
        ...settings,
        expected: {
          project: stagesFor('project').map((s) => s.name),
          remedial: stagesFor('remedial').map((s) => s.name)
        },
        check: { project: check('project'), remedial: check('remedial') },
        pipelines: pipelines.map((p) => ({
          id: p.pipeline_id,
          name: p.name,
          stages: p.stages.map((s) => s.name),
          // Which kind this pipeline would pass as, to suggest the mapping.
          matches: JOB_KINDS.filter((k) => matchPipelineStages(k, p.stages).ok)
        }))
      };
    });
    res.json(out);
  } catch (err) {
    sendError(res, next, err, 'GET /api/ops/settings', { locationId });
  }
});

// A Deal Hub setting — nothing in GHL changes.
operationsRouter.put('/settings', async (req, res, next) => {
  const locationId = req.locationId;
  const body = req.body || {};
  const ops = body.operationsPipelineId ?? null;
  const rem = body.remedialsPipelineId ?? null;
  try {
    if (ops && rem && ops === rem) {
      throw new OpsError('Projects and remedials need different pipelines', 400, 'remedialsPipelineId');
    }
    await withTenant(locationId, async (client) => {
      for (const [id, field] of [[ops, 'operationsPipelineId'], [rem, 'remedialsPipelineId']]) {
        if (!id) continue;
        const { rowCount } = await client.query(
          'SELECT 1 FROM pipelines WHERE location_id = $1 AND pipeline_id = $2 AND is_active = true',
          [locationId, id]
        );
        if (!rowCount) throw new OpsError('That pipeline was not found', 400, field);
      }
      await client.query(
        `INSERT INTO ops_settings (location_id, operations_pipeline_id, remedials_pipeline_id, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (location_id) DO UPDATE
           SET operations_pipeline_id = EXCLUDED.operations_pipeline_id,
               remedials_pipeline_id = EXCLUDED.remedials_pipeline_id,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [locationId, ops, rem, req.session?.userId || null]
      );
    });
    res.json({ ok: true, operationsPipelineId: ops, remedialsPipelineId: rem });
  } catch (err) {
    sendError(res, next, err, 'PUT /api/ops/settings', { locationId });
  }
});

operationsRouter.get('/decisions', (req, res) => {
  res.json(decisionsSnapshot());
});

// ── Lists ─────────────────────────────────────────────────────────────

// One SELECT for lists and detail, so a job reads the same in both.
// j.* FIRST: a job with no row yet comes back with every j column NULL, and
// node-pg keeps the LAST column of a given name — so o.opportunity_id after
// it wins over the empty j.opportunity_id.
const JOB_SELECT = `
  SELECT j.*,
         o.opportunity_id, o.name AS deal_name, o.status, o.monetary_value, o.currency,
         o.current_stage_id, o.current_stage_name, o.contact_id, o.assigned_to,
         o.postcode, o.custom_fields, o.updated_at AS opp_updated_at,
         c.first_name, c.last_name, c.company_name, c.email, c.phone,
         c.address1, c.city, c.postal_code,
         b.name AS business_name,
         (SELECT COUNT(*)::int FROM ops_task_links l
            JOIN tasks t ON t.location_id = l.location_id AND t.task_id = l.task_id
           WHERE l.location_id = o.location_id AND l.opportunity_id = o.opportunity_id
             AND t.deleted_at IS NULL AND t.status <> 'completed') AS open_tasks,
         (SELECT COUNT(*)::int FROM ops_task_links l
            JOIN tasks t ON t.location_id = l.location_id AND t.task_id = l.task_id
           WHERE l.location_id = o.location_id AND l.opportunity_id = o.opportunity_id
             AND t.deleted_at IS NULL AND t.status <> 'completed' AND t.due_at < now()) AS overdue_tasks
    FROM opportunities o
    LEFT JOIN contacts c ON c.location_id = o.location_id AND c.contact_id = o.contact_id
    LEFT JOIN %TABLE% j ON j.location_id = o.location_id AND j.opportunity_id = o.opportunity_id
    %COMPANY%
   WHERE o.location_id = $1 AND o.pipeline_id = $2
     AND o.deleted_at IS NULL AND COALESCE(o.is_deleted, false) = false`;

// A remedial has no company of its own: it is done by whoever did the
// project it belongs to, so the company comes through that project.
const COMPANY_JOIN = {
  project: `LEFT JOIN businesses b ON b.location_id = o.location_id AND b.business_id = j.business_id`,
  remedial: `LEFT JOIN projects pj ON pj.location_id = o.location_id AND pj.opportunity_id = j.project_opportunity_id
    LEFT JOIN businesses b ON b.location_id = o.location_id AND b.business_id = pj.business_id`
};

function jobSql(kind) {
  return JOB_SELECT.replace('%TABLE%', TABLE[kind]).replace('%COMPANY%', COMPANY_JOIN[kind]);
}

/** A row from jobSql → the shape the dashboard reads. */
export function shapeJob(kind, r) {
  const stageKey = stageKeyForName(kind, r.current_stage_name);
  const base = {
    kind,
    id: r.opportunity_id,
    dealName: r.deal_name,
    status: r.status,
    value: r.monetary_value == null ? null : Number(r.monetary_value),
    currency: r.currency || null,
    stageKey,
    stageName: r.current_stage_name || null,
    contactId: r.contact_id,
    contactName: r.contact_id ? contactLabel(r) : null,
    email: r.email || null,
    phone: r.phone || null,
    address: [r.address1, r.city].filter(Boolean).join(', ') || null,
    postcode: r.postcode || r.postal_code || null,
    businessId: kind === 'project' ? (r.business_id || null) : null,
    businessName: r.business_name || null,
    fitterName: r.fitter_name || null,
    openTasks: Number(r.open_tasks || 0),
    overdueTasks: Number(r.overdue_tasks || 0),
    hasRow: r.created_at != null
  };
  if (kind === 'project') {
    return {
      ...base,
      jobNumber: resolveJobNumber(r.job_number, r.custom_fields),
      salesOpportunityId: r.sales_opportunity_id || null,
      showroomUserId: r.showroom_user_id || null,
      orderingUserId: r.ordering_user_id || null,
      adminUserId: r.admin_user_id || null,
      installStart: r.install_start ? toDateString(r.install_start) : null,
      installEnd: r.install_end ? toDateString(r.install_end) : null
    };
  }
  return {
    ...base,
    ref: r.ref || null,
    projectId: r.project_opportunity_id || null,
    remedialKind: r.kind || null,
    reason: r.reason || null,
    category: r.category || null,
    reportedVia: r.reported_via || null,
    takenByUserId: r.taken_by_user_id || null,
    reportedAt: r.reported_at ? toDateString(r.reported_at) : null
  };
}

function toDateString(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  // DATE columns come back as local-midnight Date objects from node-pg.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

operationsRouter.get(['/projects', '/remedials'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.replace(/^\//, '')];
  const status = (req.query.status || 'open').toString();
  const q = (req.query.q || '').toString().trim().slice(0, 100);
  try {
    const out = await withTenant(locationId, async (client) => {
      const settings = await loadSettings(client, locationId);
      const pipelineId = pipelineIdFor(settings, kind);
      if (!pipelineId) return { connected: false, jobs: [] };
      const params = [locationId, pipelineId];
      let sql = jobSql(kind);
      if (status !== 'all') {
        params.push(status);
        sql += ` AND o.status = $${params.length}`;
      }
      if (q) {
        params.push(`%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
        const p = `$${params.length}`;
        sql += ` AND (o.name ILIKE ${p} OR c.first_name ILIKE ${p} OR c.last_name ILIKE ${p}
                     OR c.address1 ILIKE ${p} OR o.postcode ILIKE ${p}
                     OR ${kind === 'project' ? 'j.job_number' : 'j.ref'} ILIKE ${p})`;
      }
      sql += ' ORDER BY o.updated_at DESC NULLS LAST LIMIT 500';
      const { rows } = await client.query(sql, params);
      return { connected: true, jobs: rows.map((r) => shapeJob(kind, r)) };
    });
    res.json({ ...out, stages: stagesFor(kind) });
  } catch (err) {
    sendError(res, next, err, `GET /api/ops/${kind}s`, { locationId });
  }
});

// ── One job ──────────────────────────────────────────────────────────

/** The job's opportunity, which must be in the mapped pipeline. */
async function loadJob(client, locationId, kind, opportunityId) {
  const settings = await loadSettings(client, locationId);
  const pipelineId = pipelineIdFor(settings, kind);
  if (!pipelineId) {
    throw new OpsError(
      `The ${kind === 'project' ? 'Operations' : 'Remedials'} pipeline is not set up yet`,
      409, null, 'not_connected'
    );
  }
  const { rows: [r] } = await client.query(
    `${jobSql(kind)} AND o.opportunity_id = $3`,
    [locationId, pipelineId, opportunityId]
  );
  if (!r) throw new OpsError(`That ${kind} was not found in the ${kind === 'project' ? 'Operations' : 'Remedials'} pipeline`, 404);
  return { row: r, job: shapeJob(kind, r), settings, pipelineId };
}

/** Create the job's own row the first time anyone looks at it. */
async function ensureJobRow(client, locationId, kind, opportunityId, userId) {
  const { rowCount } = await client.query(
    `INSERT INTO ${TABLE[kind]} (location_id, opportunity_id, created_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [locationId, opportunityId, userId || null]
  );
  if (rowCount && kind === 'project') {
    const issued = await issueJobNumber(client, locationId, null);
    if (issued) {
      await client.query(
        'UPDATE projects SET job_number = $3 WHERE location_id = $1 AND opportunity_id = $2',
        [locationId, opportunityId, issued]
      );
    }
  }
}

/** Seed a stage's checklist from its template, once per job and stage. */
async function seedSteps(client, locationId, kind, opportunityId, stageKey, userId) {
  if (!stageKey) return;
  const { rowCount } = await client.query(
    `INSERT INTO ops_stage_seeds (location_id, opportunity_id, stage_key)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [locationId, opportunityId, stageKey]
  );
  if (!rowCount) return;
  const titles = templateSteps(kind, stageKey);
  for (let i = 0; i < titles.length; i++) {
    await client.query(
      `INSERT INTO ops_steps (location_id, job_kind, opportunity_id, stage_key, position, title, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [locationId, kind, opportunityId, stageKey, i, titles[i], userId || null]
    );
  }
}

const shapeStep = (s) => ({
  id: s.id,
  stageKey: s.stage_key,
  position: s.position,
  title: s.title,
  assigneeUserId: s.assignee_user_id,
  assigneeName: s.assignee_name || null,
  dueOn: s.due_on ? toDateString(s.due_on) : null,
  done: s.done_at != null,
  doneAt: s.done_at
});

async function listSteps(client, locationId, opportunityId) {
  const { rows } = await client.query(
    `SELECT s.*, u.name AS assignee_name FROM ops_steps s
       LEFT JOIN users u ON u.location_id = s.location_id AND u.user_id = s.assignee_user_id
      WHERE s.location_id = $1 AND s.opportunity_id = $2
      ORDER BY s.stage_key, s.position, s.created_at`,
    [locationId, opportunityId]
  );
  return rows.map(shapeStep);
}

async function timeSummary(client, locationId, opportunityId) {
  const { rows: [t] } = await client.query(
    `SELECT COALESCE(SUM(hours), 0)::float AS total,
            COALESCE(SUM(hours) FILTER (WHERE work_date >= date_trunc('week', now())::date), 0)::float AS this_week
       FROM ops_time_entries
      WHERE location_id = $1 AND opportunity_id = $2 AND deleted_at IS NULL`,
    [locationId, opportunityId]
  );
  const { rows: [top] } = await client.query(
    `SELECT activity, SUM(hours)::float AS hours FROM ops_time_entries
      WHERE location_id = $1 AND opportunity_id = $2 AND deleted_at IS NULL
      GROUP BY activity ORDER BY SUM(hours) DESC, activity LIMIT 1`,
    [locationId, opportunityId]
  );
  return { total: t.total, thisWeek: t.this_week, biggest: top || null };
}

operationsRouter.get(['/projects/:id', '/remedials/:id'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  const userId = req.session?.userId || null;
  try {
    const out = await withTenant(locationId, async (client) => {
      const { job, pipelineId } = await loadJob(client, locationId, kind, opportunityId);
      await ensureJobRow(client, locationId, kind, opportunityId, userId);
      await seedSteps(client, locationId, kind, opportunityId, job.stageKey, userId);
      const fresh = await loadJob(client, locationId, kind, opportunityId);
      const match = await stageMatch(client, locationId, pipelineId, kind);
      const steps = await listSteps(client, locationId, opportunityId);
      const tasks = await taskStore().listForJob(client, { locationId, opportunityId });
      const time = await timeSummary(client, locationId, opportunityId);

      // Links between the two kinds of job.
      let related = [];
      if (kind === 'project') {
        const { rows } = await client.query(
          `SELECT r.opportunity_id, r.ref, o.name, o.current_stage_name
             FROM remedials r
             LEFT JOIN opportunities o ON o.location_id = r.location_id AND o.opportunity_id = r.opportunity_id
            WHERE r.location_id = $1 AND r.project_opportunity_id = $2`,
          [locationId, opportunityId]
        );
        related = rows.map((r) => ({
          kind: 'remedial', id: r.opportunity_id, label: r.ref || r.name || 'Remedial',
          stageKey: stageKeyForName('remedial', r.current_stage_name)
        }));
      } else if (fresh.job.projectId) {
        const { rows: [p] } = await client.query(
          `SELECT p.job_number, o.name, o.custom_fields FROM opportunities o
             LEFT JOIN projects p ON p.location_id = o.location_id AND p.opportunity_id = o.opportunity_id
            WHERE o.location_id = $1 AND o.opportunity_id = $2`,
          [locationId, fresh.job.projectId]
        );
        if (p) {
          related = [{
            kind: 'project', id: fresh.job.projectId,
            label: resolveJobNumber(p.job_number, p.custom_fields) || p.name || 'Project'
          }];
        }
      }

      return {
        job: fresh.job,
        stages: stagesFor(kind).map((s) => ({ ...s, mapped: Boolean(match.byKey[s.key]) })),
        stagesOk: match.ok,
        steps,
        tasks: tasks.map((t) => ({
          id: t.task_id, title: t.title, status: t.status, dueAt: t.due_at,
          assignedTo: t.assigned_to, assignedToName: t.assigned_to_name,
          contactId: t.contact_id, stageKey: t.stage_key
        })),
        time,
        related,
        activities: TIME_ACTIVITIES[kind],
        jobNumberEditable: jobNumberIsEditable()
      };
    });
    res.json(out);
  } catch (err) {
    sendError(res, next, err, `GET /api/ops/${kind}s/:id`, { locationId, opportunityId });
  }
});

// The facts a person may change, per kind: body key → [column, validate].
const text = (max) => (v) => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new OpsError(`Keep it under ${max} characters`);
  return v.trim() || null;
};
const date = (v) => {
  if (v === null || v === '') return null;
  if (!isDate(v)) throw new OpsError('Use a date like 2026-12-03');
  return v;
};
const userRef = text(64);

const FACTS = {
  project: {
    jobNumber: ['job_number', text(40)],
    businessId: ['business_id', text(64)],
    showroomUserId: ['showroom_user_id', userRef],
    orderingUserId: ['ordering_user_id', userRef],
    adminUserId: ['admin_user_id', userRef],
    fitterName: ['fitter_name', text(120)],
    installStart: ['install_start', date],
    installEnd: ['install_end', date]
  },
  remedial: {
    ref: ['ref', text(40)],
    projectId: ['project_opportunity_id', text(64)],
    remedialKind: ['kind', (v) => {
      if (v === null || v === '') return null;
      if (v !== 'product' && v !== 'other') throw new OpsError('Type is product or other');
      return v;
    }],
    reason: ['reason', text(80)],
    category: ['category', text(80)],
    fitterName: ['fitter_name', text(120)],
    reportedVia: ['reported_via', text(80)],
    takenByUserId: ['taken_by_user_id', userRef],
    reportedAt: ['reported_at', date]
  }
};

/** Validate a facts patch → [[column, value]]. Exported for its test. */
export function buildFactsPatch(kind, body) {
  const spec = FACTS[kind];
  const out = [];
  for (const [key, value] of Object.entries(body || {})) {
    const entry = spec[key];
    if (!entry) throw new OpsError(`${key} cannot be changed here`, 400, key);
    if ((key === 'jobNumber') && !jobNumberIsEditable()) {
      throw new OpsError('Job numbers come from the CRM and cannot be typed here', 400, key);
    }
    try {
      out.push([entry[0], entry[1](value)]);
    } catch (e) {
      if (e instanceof OpsError) { e.field = key; }
      throw e;
    }
  }
  if (out.length === 0) throw new OpsError('Nothing to change');
  return out;
}

operationsRouter.patch(['/projects/:id', '/remedials/:id'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  try {
    const patch = buildFactsPatch(kind, req.body);
    const out = await withTenant(locationId, async (client) => {
      const { job } = await loadJob(client, locationId, kind, opportunityId);
      await ensureJobRow(client, locationId, kind, opportunityId, req.session?.userId);
      const sets = patch.map(([col], i) => `${col} = $${i + 3}`);
      const vals = patch.map(([, v]) => v);
      const start = patch.find(([c]) => c === 'install_start');
      const end = patch.find(([c]) => c === 'install_end');
      if (start && end && start[1] && end[1] && end[1] < start[1]) {
        throw new OpsError('The install cannot end before it starts', 400, 'installEnd');
      }
      if (kind === 'remedial') {
        const proj = patch.find(([c]) => c === 'project_opportunity_id');
        if (proj && proj[1] === opportunityId) throw new OpsError('A remedial cannot be its own project', 400, 'projectId');
      }
      await client.query(
        `UPDATE ${TABLE[kind]} SET ${sets.join(', ')}, updated_at = now()
          WHERE location_id = $1 AND opportunity_id = $2`,
        [locationId, opportunityId, ...vals]
      );
      return (await loadJob(client, locationId, kind, opportunityId)).job || job;
    });
    res.json({ job: out });
  } catch (err) {
    sendError(res, next, err, `PATCH /api/ops/${kind}s/:id`, { locationId, opportunityId });
  }
});

// ── Stage moves (a GHL write, like dragging a deal on the board) ─────

async function moveToStage(locationId, kind, opportunityId, stageKey) {
  const target = await withTenant(locationId, async (client) => {
    const { pipelineId } = await loadJob(client, locationId, kind, opportunityId);
    const match = await stageMatch(client, locationId, pipelineId, kind);
    const stageId = match.byKey[stageKey];
    if (!stageId) {
      throw new OpsError('That stage is not in the GHL pipeline yet — check the set-up screen', 409, 'stageKey', 'stage_unmapped');
    }
    return { pipelineId, stageId };
  });
  const install = await getActiveInstall(locationId);
  if (!install) {
    const why = await explainInactiveInstall(locationId);
    throw new OpsError(userMessage(why), 409);
  }
  await updateGhlOpportunity(install, opportunityId, {
    pipelineId: target.pipelineId, pipelineStageId: target.stageId
  });
  // Our row follows by the OpportunityStageUpdate webhook; mirror it now so
  // the reload straight after this does not show the old stage.
  await withTenant(locationId, (client) => client.query(
    `UPDATE opportunities o SET current_stage_id = $3,
            current_stage_name = COALESCE((SELECT name FROM pipeline_stages s
              WHERE s.location_id = o.location_id AND s.stage_id = $3), o.current_stage_name),
            updated_at = now()
      WHERE o.location_id = $1 AND o.opportunity_id = $2`,
    [locationId, opportunityId, target.stageId]
  ));
}

operationsRouter.put(['/projects/:id/stage', '/remedials/:id/stage'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  const stageKey = (req.body?.stageKey || '').toString();
  try {
    if (!stagesFor(kind).some((s) => s.key === stageKey)) throw new OpsError('Choose a stage', 400, 'stageKey');
    await moveToStage(locationId, kind, opportunityId, stageKey);
    res.json({ ok: true, stageKey });
  } catch (err) {
    sendError(res, next, err, `PUT /api/ops/${kind}s/:id/stage`, { locationId, opportunityId });
  }
});

// ── Checklist steps ──────────────────────────────────────────────────

operationsRouter.post(['/projects/:id/steps', '/remedials/:id/steps'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  const b = req.body || {};
  try {
    const title = text(200)(b.title);
    if (!title) throw new OpsError('Say what the step is', 400, 'title');
    const dueOn = date(b.dueOn ?? null);
    const step = await withTenant(locationId, async (client) => {
      const { job } = await loadJob(client, locationId, kind, opportunityId);
      const stageKey = b.stageKey || job.stageKey;
      if (!stagesFor(kind).some((s) => s.key === stageKey)) throw new OpsError('Choose a stage', 400, 'stageKey');
      const { rows: [s] } = await client.query(
        `INSERT INTO ops_steps (location_id, job_kind, opportunity_id, stage_key, position, title,
                                assignee_user_id, due_on, created_by)
         VALUES ($1, $2, $3, $4,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM ops_steps
                   WHERE location_id = $1 AND opportunity_id = $3 AND stage_key = $4),
                 $5, $6, $7, $8)
         RETURNING *`,
        [locationId, kind, opportunityId, stageKey, title, userRef(b.assigneeUserId ?? null), dueOn,
          req.session?.userId || null]
      );
      return shapeStep(s);
    });
    res.status(201).json({ step });
  } catch (err) {
    sendError(res, next, err, 'POST steps', { locationId, opportunityId });
  }
});

/**
 * After a step is ticked: is that stage now complete, and is it the job's
 * current stage? Then it moves on by itself. Pure so the rule is testable.
 */
export function shouldAdvance({ stepStageKey, currentStageKey, openInStage, totalInStage }) {
  return Boolean(currentStageKey) && stepStageKey === currentStageKey
    && totalInStage > 0 && openInStage === 0;
}

operationsRouter.patch('/steps/:stepId', async (req, res, next) => {
  const locationId = req.locationId;
  const stepId = req.params.stepId;
  const b = req.body || {};
  try {
    const sets = [];
    const vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
    if ('title' in b) {
      const t = text(200)(b.title);
      if (!t) throw new OpsError('Say what the step is', 400, 'title');
      add('title', t);
    }
    if ('assigneeUserId' in b) add('assignee_user_id', userRef(b.assigneeUserId));
    if ('dueOn' in b) add('due_on', date(b.dueOn));
    if ('done' in b) {
      if (typeof b.done !== 'boolean') throw new OpsError('done is true or false', 400, 'done');
      add('done_at', b.done ? new Date() : null);
      add('done_by', b.done ? (req.session?.userId || null) : null);
    }
    if (!sets.length) throw new OpsError('Nothing to change');

    const result = await withTenant(locationId, async (client) => {
      const { rows: [s] } = await client.query(
        `UPDATE ops_steps SET ${sets.join(', ')}, updated_at = now()
          WHERE location_id = $1 AND id = $2 RETURNING *`,
        [locationId, stepId, ...vals]
      );
      if (!s) throw new OpsError('That step no longer exists', 404);
      let advance = null;
      if (b.done === true) {
        const { job } = await loadJob(client, locationId, s.job_kind, s.opportunity_id);
        const { rows: [c] } = await client.query(
          `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE done_at IS NULL)::int AS open
             FROM ops_steps WHERE location_id = $1 AND opportunity_id = $2 AND stage_key = $3`,
          [locationId, s.opportunity_id, s.stage_key]
        );
        if (shouldAdvance({
          stepStageKey: s.stage_key, currentStageKey: job.stageKey,
          openInStage: c.open, totalInStage: c.total
        })) {
          advance = { kind: s.job_kind, opportunityId: s.opportunity_id, to: nextStageKey(s.job_kind, s.stage_key) };
        }
      }
      return { step: shapeStep(s), advance };
    });

    // The stage move is a GHL write, outside the transaction: a failure there
    // must not untick the step the person just ticked.
    let advancedTo = null;
    let advanceError = null;
    if (result.advance?.to) {
      try {
        await moveToStage(locationId, result.advance.kind, result.advance.opportunityId, result.advance.to);
        advancedTo = result.advance.to;
      } catch (err) {
        advanceError = err instanceof OpsError ? err.message : userMessage(err, 'The job could not be moved to the next stage');
        logger.warn({ err, stepId }, 'ops: stage complete but the move failed');
      }
    }
    res.json({ step: result.step, advancedTo, advanceError });
  } catch (err) {
    sendError(res, next, err, 'PATCH /api/ops/steps/:id', { locationId, stepId });
  }
});

operationsRouter.delete('/steps/:stepId', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const { rowCount } = await withTenant(locationId, (client) => client.query(
      'DELETE FROM ops_steps WHERE location_id = $1 AND id = $2', [locationId, req.params.stepId]
    ));
    if (!rowCount) return res.status(404).json({ error: 'That step no longer exists' });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, next, err, 'DELETE /api/ops/steps/:id', { locationId });
  }
});

// ── Time ─────────────────────────────────────────────────────────────

const shapeTime = (t) => ({
  id: t.id,
  userId: t.user_id,
  who: t.worker_name || t.user_name || null,
  workerName: t.worker_name,
  workDate: toDateString(t.work_date),
  hours: Number(t.hours),
  activity: t.activity,
  notes: t.notes
});

// One entry with its person's name — the create and edit responses need it
// too, or a fresh row says "who: null" until the page reloads.
async function loadTime(client, locationId, id) {
  const { rows: [t] } = await client.query(
    `SELECT t.*, u.name AS user_name FROM ops_time_entries t
       LEFT JOIN users u ON u.location_id = t.location_id AND u.user_id = t.user_id
      WHERE t.location_id = $1 AND t.id = $2`,
    [locationId, id]
  );
  return shapeTime(t);
}

/** Validate a time entry. Exported for its test. */
export function buildTimeEntry(kind, b, { partial = false } = {}) {
  const out = {};
  if (!partial || 'hours' in b) {
    const h = parseHours(b.hours);
    if (h == null) throw new OpsError('Hours must be more than 0 and at most 24', 400, 'hours');
    out.hours = h;
  }
  if (!partial || 'workDate' in b) {
    if (!isDate(b.workDate)) throw new OpsError('Choose the date the work was done', 400, 'workDate');
    out.work_date = b.workDate;
  }
  if (!partial || 'activity' in b) {
    if (!TIME_ACTIVITIES[kind].includes(b.activity)) throw new OpsError('Choose an activity', 400, 'activity');
    out.activity = b.activity;
  }
  if (!partial || 'userId' in b || 'workerName' in b) {
    const userId = userRef(b.userId ?? null);
    const workerName = text(120)(b.workerName ?? null);
    if (!userId && !workerName) throw new OpsError('Say who did the work', 400, 'userId');
    out.user_id = userId;
    out.worker_name = userId ? null : workerName;
  }
  if ('notes' in b) out.notes = text(500)(b.notes ?? null);
  return out;
}

operationsRouter.get(['/projects/:id/time', '/remedials/:id/time'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  try {
    const out = await withTenant(locationId, async (client) => {
      await loadJob(client, locationId, kind, opportunityId);
      const { rows } = await client.query(
        `SELECT t.*, u.name AS user_name FROM ops_time_entries t
           LEFT JOIN users u ON u.location_id = t.location_id AND u.user_id = t.user_id
          WHERE t.location_id = $1 AND t.opportunity_id = $2 AND t.deleted_at IS NULL
          ORDER BY t.work_date DESC, t.created_at DESC`,
        [locationId, opportunityId]
      );
      return { entries: rows.map(shapeTime), summary: await timeSummary(client, locationId, opportunityId) };
    });
    res.json({ ...out, activities: TIME_ACTIVITIES[kind] });
  } catch (err) {
    sendError(res, next, err, 'GET time', { locationId, opportunityId });
  }
});

operationsRouter.post(['/projects/:id/time', '/remedials/:id/time'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  try {
    const e = buildTimeEntry(kind, req.body || {});
    const entry = await withTenant(locationId, async (client) => {
      await loadJob(client, locationId, kind, opportunityId);
      const { rows: [t] } = await client.query(
        `INSERT INTO ops_time_entries (location_id, job_kind, opportunity_id, user_id, worker_name,
                                       work_date, hours, activity, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [locationId, kind, opportunityId, e.user_id, e.worker_name, e.work_date, e.hours,
          e.activity, e.notes ?? null, req.session?.userId || null]
      );
      return loadTime(client, locationId, t.id);
    });
    res.status(201).json({ entry });
  } catch (err) {
    sendError(res, next, err, 'POST time', { locationId, opportunityId });
  }
});

operationsRouter.patch('/time/:entryId', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const out = await withTenant(locationId, async (client) => {
      const { rows: [cur] } = await client.query(
        'SELECT job_kind FROM ops_time_entries WHERE location_id = $1 AND id = $2 AND deleted_at IS NULL',
        [locationId, req.params.entryId]
      );
      if (!cur) throw new OpsError('That entry no longer exists', 404);
      const e = buildTimeEntry(cur.job_kind, req.body || {}, { partial: true });
      const cols = Object.keys(e);
      if (!cols.length) throw new OpsError('Nothing to change');
      const { rows: [t] } = await client.query(
        `UPDATE ops_time_entries SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now()
          WHERE location_id = $1 AND id = $2 RETURNING *`,
        [locationId, req.params.entryId, ...cols.map((c) => e[c])]
      );
      return loadTime(client, locationId, t.id);
    });
    res.json({ entry: out });
  } catch (err) {
    sendError(res, next, err, 'PATCH /api/ops/time/:id', { locationId });
  }
});

operationsRouter.delete('/time/:entryId', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const { rowCount } = await withTenant(locationId, (client) => client.query(
      `UPDATE ops_time_entries SET deleted_at = now()
        WHERE location_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [locationId, req.params.entryId]
    ));
    if (!rowCount) return res.status(404).json({ error: 'That entry no longer exists' });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, next, err, 'DELETE /api/ops/time/:id', { locationId });
  }
});

// ── Tasks ────────────────────────────────────────────────────────────

// Tasks across every job (s24). Filters mirror the screen's chips.
operationsRouter.get('/tasks', async (req, res, next) => {
  const locationId = req.locationId;
  const filter = (req.query.filter || 'open').toString();
  const who = (req.query.assignedTo || '').toString() || null;
  try {
    const rows = await withTenant(locationId, async (client) => {
      const params = [locationId];
      const where = ['t.deleted_at IS NULL'];
      if (filter === 'done') where.push("t.status = 'completed'");
      else where.push("t.status <> 'completed'");
      if (filter === 'overdue') where.push('t.due_at < date_trunc(\'day\', now())');
      if (filter === 'today') where.push("t.due_at >= date_trunc('day', now()) AND t.due_at < date_trunc('day', now()) + interval '1 day'");
      if (filter === 'week') where.push("t.due_at < date_trunc('day', now()) + interval '7 days'");
      if (who) { params.push(who); where.push(`t.assigned_to = $${params.length}`); }
      const { rows: r } = await client.query(
        `SELECT t.task_id, t.title, t.status, t.due_at, t.assigned_to,
                COALESCE(t.assigned_to_name, u.name) AS assigned_to_name,
                l.job_kind, l.opportunity_id, l.stage_key,
                o.name AS deal_name, o.current_stage_name,
                p.job_number, o.custom_fields, r.ref
           FROM ops_task_links l
           JOIN tasks t ON t.location_id = l.location_id AND t.task_id = l.task_id
           LEFT JOIN users u ON u.location_id = t.location_id AND u.user_id = t.assigned_to
           LEFT JOIN opportunities o ON o.location_id = l.location_id AND o.opportunity_id = l.opportunity_id
           LEFT JOIN projects p ON p.location_id = l.location_id AND p.opportunity_id = l.opportunity_id
           LEFT JOIN remedials r ON r.location_id = l.location_id AND r.opportunity_id = l.opportunity_id
          WHERE l.location_id = $1 AND ${where.join(' AND ')}
          ORDER BY t.due_at NULLS LAST, t.title
          LIMIT 500`,
        params
      );
      return r;
    });
    res.json({
      tasks: rows.map((t) => ({
        id: t.task_id,
        title: t.title,
        status: t.status,
        dueAt: t.due_at,
        assignedTo: t.assigned_to,
        assignedToName: t.assigned_to_name,
        job: {
          kind: t.job_kind,
          id: t.opportunity_id,
          label: (t.job_kind === 'project' ? resolveJobNumber(t.job_number, t.custom_fields) : t.ref)
            || t.deal_name || 'Job',
          stageKey: t.stage_key || stageKeyForName(t.job_kind, t.current_stage_name)
        }
      }))
    });
  } catch (err) {
    sendError(res, next, err, 'GET /api/ops/tasks', { locationId });
  }
});

operationsRouter.post(['/projects/:id/tasks', '/remedials/:id/tasks'], async (req, res, next) => {
  const locationId = req.locationId;
  const kind = KIND_BY_PATH[req.path.split('/')[1]];
  const opportunityId = req.params.id;
  const b = req.body || {};
  const userId = req.session?.userId || null;
  try {
    const title = text(200)(b.title);
    if (!title) throw new OpsError('Say what the task is', 400, 'title');
    if (!b.dueDate) throw new OpsError('A task needs a due date', 400, 'dueDate');
    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      throw new OpsError(userMessage(why), 409);
    }
    const task = await withTenant(locationId, async (client) => {
      const { job } = await loadJob(client, locationId, kind, opportunityId);
      if (!job.contactId) throw new OpsError('This job has no customer to hang a task on', 400);
      const stageKey = b.stageKey && stagesFor(kind).some((s) => s.key === b.stageKey) ? b.stageKey : job.stageKey;
      return taskStore().create(install, client, {
        locationId,
        job: { kind, opportunityId, contactId: job.contactId },
        input: { title, dueDate: b.dueDate, body: b.body, assignedTo: b.assignedTo },
        stageKey,
        userId
      });
    });
    // So the TaskCreate webhook files the task against the job's deal too —
    // it then also shows on the deal in the Deal hub.
    if (task?.id) {
      await recordPendingDealLink(locationId, ENTITY_TASK, task.id, opportunityId, userId, 'app')
        .catch((err) => logger.warn({ err, taskId: task.id }, 'ops: pending deal link not recorded'));
    }
    res.status(201).json({ task, store: taskStore().name });
  } catch (err) {
    sendError(res, next, err, 'POST ops task', { locationId, opportunityId });
  }
});

// Link an existing task to a job, move it to another, or unlink (job: null).
operationsRouter.put('/tasks/:taskId/job', async (req, res, next) => {
  const locationId = req.locationId;
  const taskId = req.params.taskId;
  const b = req.body || {};
  try {
    await withTenant(locationId, async (client) => {
      if (b.job === null) {
        await taskStore().unlink(client, { locationId, taskId });
        return;
      }
      const kind = b.job?.kind;
      if (!JOB_KINDS.includes(kind)) throw new OpsError('Choose a project or remedial', 400, 'job');
      const { rows: [t] } = await client.query(
        'SELECT contact_id FROM tasks WHERE location_id = $1 AND task_id = $2 AND deleted_at IS NULL',
        [locationId, taskId]
      );
      if (!t) throw new OpsError('That task no longer exists', 404);
      const { job } = await loadJob(client, locationId, kind, b.job.id);
      // Same rule as a task's deal link: the task's contact must be on the job.
      const { rowCount } = await client.query(
        `SELECT 1 FROM opportunities o
          WHERE o.location_id = $1 AND o.opportunity_id = $2
            AND (o.contact_id = $3 OR EXISTS (
                  SELECT 1 FROM opportunity_contacts oc
                   WHERE oc.location_id = o.location_id AND oc.opportunity_id = o.opportunity_id
                     AND oc.contact_id = $3))`,
        [locationId, job.id, t.contact_id]
      );
      if (!rowCount) throw new OpsError("That task's customer is not on this job", 400, 'job');
      const stageKey = b.stageKey && stagesFor(kind).some((s) => s.key === b.stageKey) ? b.stageKey : job.stageKey;
      await taskStore().link(client, {
        locationId, taskId, job: { kind, opportunityId: job.id }, stageKey, userId: req.session?.userId
      });
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, next, err, 'PUT /api/ops/tasks/:id/job', { locationId, taskId });
  }
});

// ── Start a project — waiting on client question Q1 ──────────────────
operationsRouter.post('/projects/start', async (req, res, next) => {
  try {
    if (START_PROJECT === null) {
      throw new OpsError(
        "Starting a project from a won deal is waiting on the client's decision (question 1 in the plan). "
        + 'Until then, move or create the deal in the Operations pipeline in your CRM and it appears here.',
        409, null, 'decision_pending'
      );
    }
    // START_PROJECT === 'new_linked' | 'move_same' — build here when decided.
    throw new OpsError('Not built yet', 501, null, 'not_built');
  } catch (err) {
    sendError(res, next, err, 'POST /api/ops/projects/start', { locationId: req.locationId });
  }
});

// ── Log a remedial ───────────────────────────────────────────────────
// Creates the opportunity in the Remedials pipeline at "Reported" and writes
// our row at once (no FK: see migration 146 — the webhook lands seconds later).
operationsRouter.post('/remedials', async (req, res, next) => {
  const locationId = req.locationId;
  const b = req.body || {};
  const userId = req.session?.userId || null;
  try {
    const name = text(200)(b.name);
    if (!name) throw new OpsError('Say what the problem is', 400, 'name');
    // The form's facts, with today as the reported date unless one was given.
    const factInput = Object.fromEntries(Object.entries(b).filter(([k]) => k in FACTS.remedial));
    if (!factInput.reportedAt) factInput.reportedAt = new Date().toISOString().slice(0, 10);
    const facts = buildFactsPatch('remedial', factInput);

    const target = await withTenant(locationId, async (client) => {
      const settings = await loadSettings(client, locationId);
      if (!settings.remedialsPipelineId) {
        throw new OpsError('The Remedials pipeline is not set up yet', 409, null, 'not_connected');
      }
      const match = await stageMatch(client, locationId, settings.remedialsPipelineId, 'remedial');
      if (!match.byKey.reported) {
        throw new OpsError('The Remedials pipeline has no "Reported" stage', 409, null, 'stage_unmapped');
      }
      let contactId = b.contactId || null;
      const projectId = facts.find(([c]) => c === 'project_opportunity_id')?.[1] || null;
      if (projectId) {
        const { rows: [p] } = await client.query(
          `SELECT contact_id FROM opportunities WHERE location_id = $1 AND opportunity_id = $2
             AND pipeline_id = $3 AND deleted_at IS NULL`,
          [locationId, projectId, settings.operationsPipelineId]
        );
        if (!p) throw new OpsError('That project was not found', 400, 'projectId');
        contactId = p.contact_id;
      }
      if (!contactId) throw new OpsError('Choose the customer, or the project it belongs to', 400, 'contactId');
      const { rowCount } = await client.query(
        'SELECT 1 FROM contacts WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL',
        [locationId, contactId]
      );
      if (!rowCount) throw new OpsError('That customer was not found', 400, 'contactId');
      return { contactId, pipelineId: settings.remedialsPipelineId, stageId: match.byKey.reported };
    });

    const install = await getActiveInstall(locationId);
    if (!install) {
      const why = await explainInactiveInstall(locationId);
      throw new OpsError(userMessage(why), 409);
    }
    const opp = await createGhlOpportunity(install, {
      contactId: target.contactId, name, status: 'open',
      pipelineId: target.pipelineId, pipelineStageId: target.stageId
    });
    const opportunityId = opp?.id;
    if (!opportunityId) throw new OpsError('Your CRM did not return the new remedial', 502);

    await withTenant(locationId, async (client) => {
      const cols = ['location_id', 'opportunity_id', 'created_by', ...facts.map(([c]) => c)];
      const vals = [locationId, opportunityId, userId, ...facts.map(([, v]) => v)];
      await client.query(
        `INSERT INTO remedials (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (location_id, opportunity_id) DO NOTHING`,
        vals
      );
    });
    res.status(201).json({ id: opportunityId });
  } catch (err) {
    sendError(res, next, err, 'POST /api/ops/remedials', { locationId });
  }
});
