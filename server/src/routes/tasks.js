import express from 'express';
import { contactLabel } from '../utils/contactLabel.js';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import {
  recordPendingDealLink, ENTITY_TASK
} from '../services/pendingDealLink.js';
import { userMessage } from '../utils/userMessage.js';
import { parseLimit, decodeCursor, toPage } from '../utils/paginate.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import {
  createGhlTask, updateGhlTask, setGhlTaskCompleted, deleteGhlTask,
  TaskWriteError
} from '../services/ghlTaskWrite.js';
import {
  setTaskRelations, removeTaskRelations, assertRelationTargets, AssociationError
} from '../services/ghlAssociations.js';

export const tasksRouter = express.Router();
tasksRouter.use(requireSession);

// GET /api/tasks — the Tasks page queue.
//   ?status=open|completed|deleted|all   (default: open)
//   ?due=all|overdue|week|month|custom   (default: all)
//   ?dueFrom=YYYY-MM-DD&dueTo=YYYY-MM-DD  (with ?due=custom; either may be omitted)
//   ?limit=N                             (default 20, max 100)
//   ?cursor=<opaque>                     keyset cursor from a prior response
//   ?dealId=<opportunity_id>             only tasks linked to that deal
//
// Ordering is due_at ASC NULLS LAST, then task_id. The previous "open tasks
// first" tier was dropped when pagination landed: a cursor has to match the
// sort exactly, and with the default ?status=open every row is open anyway so
// the tier never fired. On ?status=all, completed tasks now interleave by due
// date rather than sinking to the bottom.
//
// Rows join contacts + opportunities so the frontend can render "task title,
// due, owner, contact chip, deal chip" in one shot without extra lookups.

tasksRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const status = (req.query.status || 'open').toString();
  const due = (req.query.due || 'all').toString();
  // An explicit date RANGE, used when ?due=custom. Both bounds are optional —
  // an open-ended range ("everything from March on") is a real question.
  //
  // Validated as YYYY-MM-DD here rather than passed through: these become
  // query PARAMETERS, so a bad value cannot inject, but it would make Postgres
  // throw a 500 on an invalid date literal. A malformed bound is dropped and
  // the range simply widens on that side.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const dateParam = (v) => {
    const str = (v || '').toString();
    return DATE_RE.test(str) && !Number.isNaN(new Date(str).getTime()) ? str : null;
  };
  const dueFrom = dateParam(req.query.dueFrom);
  const dueTo = dateParam(req.query.dueTo);
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const dealId = (req.query.dealId || '').toString().trim() || null;
  // Scope to one contact — the Tasks tab's own filter. A task belongs to
  // exactly one contact, so this is a plain equality unlike dealId above.
  const contactId = (req.query.contactId || '').toString().trim() || null;
  // Scope to one business — see the condition below for how a task reaches one.
  const businessId = (req.query.businessId || '').toString().trim() || null;
  // Owner filter, matching contacts and deals. 'unassigned' is a real choice,
  // not an empty one: a task nobody owns is the one most likely to be missed,
  // so it needs to be selectable rather than only reachable by looking at
  // everything.
  const assignedTo = (req.query.assignedTo || '').toString().trim();
  // Free-text search across the three NAMES a task is found by: its contact,
  // its deal and its business. Not the title — a rep looking for "Cedarstone"
  // wants that company's tasks, whatever each one is called.
  //
  // Filtered in SQL rather than in the browser: the list is paged, so a
  // client-side filter would only ever search the rows already loaded and
  // quietly miss matches on page two.
  const q = (req.query.q || '').toString().trim();
  // SORT ORDER.
  //
  //   due            soonest first — what a task list is for, and the default
  //   created_desc   newest first
  //   created_asc    oldest first
  //
  // Due and created are genuinely different questions ("what is coming up"
  // versus "what came in"), so both stay. Direction only applies to created:
  // a due-date list read backwards is a list of things already overdue, which
  // the Due filter already answers better.
  //
  // Each needs its OWN keyset, not just a different ORDER BY — a cursor has to
  // match its sort exactly or the second page skips or repeats rows.
  const sortRaw = String(req.query.sort || 'due');
  const sort = ['due', 'created_desc', 'created_asc'].includes(sortRaw) ? sortRaw : 'due';
  const byCreated = sort !== 'due';
  const createdAsc = sort === 'created_asc';

  try {
    const rows = await withTenant(locationId, async (client) => {
      const params = [locationId];
      const conds = [
        't.location_id = $1',
        't.deleted_at IS NULL'
      ];
      if (status !== 'all') {
        params.push(status);
        conds.push(`t.status = $${params.length}`);
      }
      // Scope to one deal — used by the Deal Hub's Tasks section, which shows
      // only what's linked to the open opportunity.
      if (contactId) {
        params.push(contactId);
        conds.push(`t.contact_id = $${params.length}`);
      }
      if (dealId) {
        params.push(dealId);
        // ANY linked deal, not only the primary. A task attached to three
        // deals must appear under all three — filtering on the scalar alone
        // hid it from every deal but the first.
        conds.push(`(
          t.opportunity_id = $${params.length}
          OR EXISTS (
            SELECT 1 FROM task_relations tr
             WHERE tr.location_id     = t.location_id
               AND tr.task_id         = t.task_id
               AND tr.opportunity_id  = $${params.length}
          )
        )`);
      }
      if (assignedTo === 'unassigned') {
        conds.push(`t.assigned_to IS NULL`);
      } else if (assignedTo) {
        params.push(assignedTo);
        conds.push(`t.assigned_to = $${params.length}`);
      }

      // Scope to one BUSINESS — the business page's Tasks panel.
      //
      // The same COALESCE chain the card's Business row uses: the task's own
      // link first (set in OUR database by PUT /:id/local-links, since GHL
      // refuses task relation writes over OAuth), then its contact's business,
      // then its deal's contact's. So a task linked to a company by hand shows
      // on that company's page even when its contact works somewhere else.
      if (businessId) {
        params.push(businessId);
        conds.push(`COALESCE(t.business_id, c.business_id, oc.business_id) = $${params.length}`);
      }

      // SEARCH. This block used to sit INSIDE the `else if (assignedTo)`
      // branch above — a misplaced closing brace — so typing in the Tasks
      // search did nothing unless the Owner filter was set to one person.
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        // Same COALESCE chain the SELECT uses, so what you can search for is
        // exactly what the card shows.
        conds.push(`(
             c.first_name ILIKE $${i}
          OR c.last_name  ILIKE $${i}
          OR (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${i}
          OR o.name       ILIKE $${i}
          OR EXISTS (
               SELECT 1 FROM businesses bq
                WHERE bq.location_id = t.location_id
                  AND bq.business_id = COALESCE(t.business_id, c.business_id, oc.business_id)
                  AND bq.is_active = true
                  AND bq.name ILIKE $${i}
             )
        )`);
      }
      // due filters — only meaningful for open tasks with a due_at
      if (due === 'overdue') {
        conds.push(`t.due_at IS NOT NULL AND t.due_at < now() AND t.status = 'open'`);
      } else if (due === 'week') {
        conds.push(`t.due_at IS NOT NULL AND t.due_at >= now() AND t.due_at < now() + INTERVAL '7 days'`);
      } else if (due === 'month') {
        conds.push(`t.due_at IS NOT NULL AND t.due_at >= now() AND t.due_at < now() + INTERVAL '30 days'`);
      } else if (due === 'custom' && (dueFrom || dueTo)) {
        // A dated range, unlike the presets above, does NOT imply status
        // 'open': asking "what was due in March" includes what was finished in
        // March, and silently hiding it would misreport the month.
        conds.push(`t.due_at IS NOT NULL`);
        if (dueFrom) {
          params.push(dueFrom);
          conds.push(`t.due_at >= $${params.length}::date`);
        }
        if (dueTo) {
          // The END of the chosen day, not its midnight: a range ending
          // "12 Oct" must include a task due 12 Oct at 10:00, and `<= date`
          // compares against 00:00 and excludes the whole day.
          params.push(dueTo);
          conds.push(`t.due_at < ($${params.length}::date + INTERVAL '1 day')`);
        }
      }

      // Keyset for an ASC-NULLS-LAST sort — the mirror of utils/paginate's
      // DESC helper. Written out here because tasks are the only list ordered
      // soonest-first, and a shared "both directions" helper would be harder
      // to read than the six lines it saves.
      let keyset = '';
      if (cursor) {
        if (byCreated) {
          // DESC, newest first. created_at_ghl can be null on a task synced
          // before the field existed, so it falls back to imported_at — the
          // same COALESCE the ORDER BY below uses, or the two disagree and
          // pagination breaks.
          const CREATED = 'COALESCE(t.created_at_ghl, t.imported_at)';
          params.push(cursor.ts);
          const tsP = params.length;
          params.push(cursor.id);
          // Comparison flips with the direction; the id tiebreaker does not,
          // because ORDER BY keeps task_id ASC either way.
          const cmp = createdAsc ? '>' : '<';
          keyset = `AND (
               date_trunc('milliseconds', ${CREATED}) ${cmp} $${tsP}
            OR (date_trunc('milliseconds', ${CREATED}) = $${tsP} AND t.task_id > $${params.length})
          )`;
        } else if (cursor.ts === null) {
          params.push(cursor.id);
          keyset = `AND (t.due_at IS NULL AND t.task_id > $${params.length})`;
        } else {
          params.push(cursor.ts);
          const tsP = params.length;
          params.push(cursor.id);
          // Truncated to milliseconds on both sides — a cursor loses the
          // microseconds Postgres stores, so a strict comparison lets the row
          // it was built from re-qualify. Same fix as utils/paginate's MS().
          keyset = `AND (
               date_trunc('milliseconds', t.due_at) > $${tsP}
            OR (date_trunc('milliseconds', t.due_at) = $${tsP} AND t.task_id > $${params.length})
            OR t.due_at IS NULL
          )`;
        }
      }

      const sql = `
        SELECT
          t.task_id, t.title, t.body, t.status, t.due_at, t.completed_at,
          t.assigned_to, t.assigned_to_name, t.contact_id, t.opportunity_id, t.business_id,
          COALESCE(t.business_id, c.business_id, oc.business_id) AS resolved_business_id,
          b.name AS business_name,
          t.imported_at, t.updated_at, t.created_at_ghl,
          -- Every identifier we hold for the contact, because a chip reading
          -- nothing is worse than one reading an email address. GHL contacts
          -- created from an inbound message or an import routinely have no
          -- name at all — see contactLabel below.
          c.first_name, c.last_name, c.email, c.phone, c.company_name,
          o.name AS opportunity_name, o.current_stage_name,
          -- Linked notes as chips (migration 054). Aggregated in the query so
          -- a 20-row page is one round trip, not 20 lookups.
          (
            SELECT COALESCE(json_agg(json_build_object(
                     'id', nl.note_id,
                     'label', COALESCE(NULLIF(split_part(n2.body, E'\n', 1), ''), 'Note')
                   ) ORDER BY nl.created_at), '[]'::json)
              FROM note_links nl
              JOIN notes n2
                ON n2.location_id = nl.location_id
               AND n2.note_id     = nl.note_id
               AND n2.status      = 'active'
             WHERE nl.location_id  = t.location_id
               AND nl.subject_type = 'task'
               AND nl.subject_id    = t.task_id
          ) AS note_chips,
          -- Every deal this task is linked to (migration 066). GHL caps the
          -- association at 10, so this aggregate is small and bounded.
          --
          -- t.opportunity_id stays the PRIMARY deal — nine call sites read it
          -- as "the" deal — but it is only one of these rows. The primary is
          -- ordered first so the UI's first chip matches what those call
          -- sites see.
          (
            SELECT COALESCE(json_agg(json_build_object(
                     'id',         tr.opportunity_id,
                     'relationId', tr.relation_id,
                     'name',       o2.name,
                     'stage',      o2.current_stage_name
                   ) ORDER BY (tr.opportunity_id = t.opportunity_id) DESC,
                              tr.imported_at), '[]'::json)
              FROM task_relations tr
              LEFT JOIN opportunities o2
                ON o2.location_id    = tr.location_id
               AND o2.opportunity_id = tr.opportunity_id
             WHERE tr.location_id = t.location_id
               AND tr.task_id     = t.task_id
          ) AS deal_links
        FROM tasks t
        LEFT JOIN contacts c
          ON c.location_id = t.location_id AND c.contact_id = t.contact_id
        LEFT JOIN opportunities o
          ON o.location_id = t.location_id AND o.opportunity_id = t.opportunity_id
        -- THE BUSINESS BEHIND THE TASK, resolved the way the page reads it:
        -- the contact's business first, and the deal's primary contact's
        -- business when the task's own contact has none. GHL has no task →
        -- business link, so it is always inferred through a person.
        --
        -- Joined here rather than fetched per row: a page of 50 tasks was
        -- 50 extra round trips, and the name is needed on every card.
        LEFT JOIN contacts oc
          ON oc.location_id = o.location_id AND oc.contact_id = o.contact_id
        LEFT JOIN businesses b
          ON b.location_id = t.location_id
         AND b.business_id = COALESCE(t.business_id, c.business_id, oc.business_id)
         AND b.is_active   = true
        WHERE ${conds.join(' AND ')}
          ${keyset}
        ORDER BY
          ${byCreated
            ? `COALESCE(t.created_at_ghl, t.imported_at) ${createdAsc ? 'ASC' : 'DESC'}`
            : 't.due_at ASC NULLS LAST'},
          t.task_id ASC
        LIMIT ${limit + 1}
      `;
      const r = await client.query(sql, params);
      return r.rows;
    });

    const now = Date.now();
    // The cursor must carry the column the query ACTUALLY sorted by. Building
    // it from due_at while ordering by created date is the classic way to get
    // a second page that repeats or skips rows.
    const page = toPage(rows, limit, (t) => ({
      ts: byCreated ? (t.created_at_ghl || t.imported_at) : t.due_at,
      id: t.task_id
    }));
    res.json({
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      tasks: page.rows.map((t) => {
        const dueMs = t.due_at ? new Date(t.due_at).getTime() : null;
        const overdue = t.status === 'open' && dueMs != null && dueMs < now;
        const dueToday = t.status === 'open' && dueMs != null
          && new Date(t.due_at).toDateString() === new Date().toDateString();
        return {
          id: t.task_id,
          title: t.title,
          body: t.body,
          status: t.status,
          dueAt: t.due_at,
          completedAt: t.completed_at,
          overdue,
          dueToday,
          owner: t.assigned_to_name || null,
          // The assignee's user id — what the task editor's "Assign to"
          // picker selects. `owner` above is only the display name.
          assignedTo: t.assigned_to || null,
          // When the task was created. created_at_ghl is GHL's own dateAdded;
          // imported_at is when WE first saw it, which is the only date a
          // backfilled row has. The UI shows this as "added 3d ago".
          createdAt: t.created_at_ghl || t.imported_at,
          contact: t.contact_id ? {
            id: t.contact_id,
            firstName: t.first_name,
            lastName: t.last_name,
            // NEVER null. This was `... || null`, and the UI renders
            // <ContactChip name={c.name}> — so a contact with no first or last
            // name produced a chip with no text, which is why most rows in the
            // task queue showed no contact at all despite having one linked.
            // Same fallback chain the deal timeline uses for a message sender.
            name: contactLabel(t),
            email: t.email,
            phone: t.phone
          } : null,
          // Linked notes, rendered as gold chips under the row.
          noteChips: (t.note_chips || []).map((c) => ({
            id: c.id,
            label: String(c.label || 'Note').slice(0, 40)
          })),
          deal: t.opportunity_id ? {
            id: t.opportunity_id,
            name: t.opportunity_name,
            stage: t.current_stage_name
          } : null,
          // All linked deals. Falls back to the scalar so a task whose
          // relation rows have not synced yet still shows its deal — the
          // backfill covers existing tasks, but a task created between deploy
          // and the first RelationCreate would otherwise render with none.
          deals: (t.deal_links || []).length
            ? t.deal_links.map((d) => ({
                id: d.id,
                relationId: d.relationId,
                name: d.name || 'Untitled deal',
                stage: d.stage || null
              }))
            : (t.opportunity_id ? [{
                id: t.opportunity_id,
                relationId: null,
                name: t.opportunity_name || 'Untitled deal',
                stage: t.current_stage_name || null
              }] : []),
          // GHL's cap. The UI hides its add control at this number rather
          // than letting the rep hit a 4xx from the association API.
          dealLimit: 10,
          // Flat ids for the editor's pickers — see the note in notes.js.
          opportunityId: t.opportunity_id,
          businessId: t.business_id,
          // What the card shows: the business this task belongs to, however
          // it was reached. `businessId` above stays the task's OWN link,
          // because the editor writes that one and must not be handed an
          // inherited value to save back.
          business: t.business_name
            ? { id: t.resolved_business_id, name: t.business_name }
            : null
        };
      }),
      totalCount: page.rows.length,
      // Echoed so a caller can tell this server honoured the filter: an
      // older one ignores ?businessId= and returns the whole account's tasks.
      ...(businessId ? { businessId } : {})
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/tasks failed');
    next(err);
  }
});

// ── Writes ─────────────────────────────────────────────────────────────
//
// GHL's task endpoints are all nested on the contact
// (/contacts/{contactId}/tasks/...), but our clients hold OUR task id and know
// nothing about which contact owns it. So every write below resolves the
// contact from Postgres under RLS first.
//
// That resolution is a security boundary, not a convenience: a contactId sent
// from the browser would let a caller aim a write at a contact in another
// location. The only contact id we ever use is the one our own row carries,
// read inside withTenant.
//
// Unlike contacts, tasks have NO TaskUpdate webhook — see ghlTaskWrite.js for
// what that changes.

// Shared preamble for the three routes that act on an existing task: resolve
// the task under RLS, confirm the install, and hand back what the caller needs.
// Throws TaskWriteError so each route's catch block handles it identically.
async function resolveTaskForWrite(locationId, taskId) {
  const row = await withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT task_id, contact_id, status
         FROM tasks
        WHERE location_id = $1 AND task_id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [locationId, taskId]
    );
    return rows[0] || null;
  });

  if (!row) {
    throw new TaskWriteError('That task no longer exists', { status: 404 });
  }
  // NO CONTACT IS FINE. This used to 400 with "tasks are edited through the
  // contact they belong to", which left every contactless task — one made by
  // a workflow, an import, or directly in the GHL UI — visible but impossible
  // to edit, complete or delete.
  //
  // GHL has a second, location-scoped surface for exactly this:
  //     PUT/DELETE /locations/:locationId/tasks/:taskId
  // ghlTaskWrite falls back to it whenever contactId is absent.

  const install = await getActiveInstall(locationId);
  if (!install) {
    // Say WHICH of the two states this is. "No longer connected" was reported
    // for both, and for the reauth case it is untrue: the install is present
    // and its token may still work — one endpoint 401ing without
    // scopeOptional is enough to flag the location. Reads keep working
    // (they never touch GHL), so this presented as a broken write endpoint.
    const { message, reason } = await explainInactiveInstall(locationId);
    throw new TaskWriteError(message, { status: 409, reason });
  }
  return { install, contactId: row.contact_id, status: row.status };
}

// One error shape for all four routes. The field name travels so the UI can
// mark the offending input rather than showing a banner that doesn't say which
// box is wrong — same contract as PATCH /api/contacts/:id.
function sendWriteError(res, err, next, ctx) {
  // AssociationError carries the same status/field shape. Without this branch a
  // relation validation failure became a 500 with no field, so the UI could not
  // mark the control that was wrong.
  if (err instanceof TaskWriteError || err instanceof AssociationError) {
    return res.status(err.status).json({
      error: err.message,
      field: err.field || null,
      // Present only for the cases that need distinguishing (reauth_required
      // vs not_installed). Omitted otherwise rather than sent as null on
      // every validation error.
      ...(err.reason ? { reason: err.reason } : {})
    });
  }
  // A 401 that did NOT condemn the install (scopeOptional). It is a missing
  // scope or a version mismatch on ONE endpoint, not a dead token — so say
  // what it is. Without this branch it fell through to `internal_error` with
  // a 500, which tells the rep nothing and looks like the app is broken.
  //
  // 502: the request was valid, our upstream refused it. Not 401 — that would
  // make the dashboard bounce the rep to a re-login they do not need.
  if (err?.code === 'GHL_SCOPE_MISSING') {
    logger.error(
      { err, ...ctx },
      'task relation write refused — the marketplace app is missing the OAuth scope for this endpoint, '
      + 'or the endpoint needs a different API version'
    );
    return res.status(502).json({
      error: 'Your CRM refused this change — the app is not authorised for it. '
        + 'This needs the connection re-approved with the right permissions.',
      field: null,
      code: 'scope_missing'
    });
  }
  logger.error({ err, ...ctx }, 'task write failed');
  return next(err);
}

// POST /api/tasks — create a task on a contact.
//
// Body: { contactId, title, dueDate, body?, assignedTo?, completed? }
//
// contactId is required and IS taken from the body here — there's no task row
// to resolve it from yet. It's checked against our own contacts table under
// RLS, so a contact from another location fails as "not found" rather than
// reaching GHL.
//
// The row is not inserted locally: the TaskCreate webhook owns that, including
// the opportunity attribution only it knows how to do.
tasksRouter.post('/', async (req, res, next) => {
  const locationId = req.locationId;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of task fields' });
  }
  // opportunityId / businessId are ASSOCIATIONS, not task fields — different
  // GHL endpoint, and buildTaskPatch rejects anything it does not recognise.
  // Applied after the task exists, since the relation is keyed on the task id.
  const { contactId, opportunityId, businessId, ...fields } = body;
  if (!contactId) {
    return res.status(400).json({
      error: 'A task needs a contact — GoHighLevel stores tasks against the contact',
      field: 'contactId'
    });
  }

  try {
    const exists = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM contacts
          WHERE location_id = $1 AND contact_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [locationId, contactId]
      );
      return rows.length > 0;
    });
    if (!exists) {
      return res.status(404).json({ error: 'That contact no longer exists', field: 'contactId' });
    }

    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }

    const task = await createGhlTask(install, contactId, fields);

    // Park the rep's deal choice for TaskCreate to pick up.
    //
    // The relations call below cannot carry it: GHL refuses task relation
    // writes on the OAuth channel outright (restrictOAuthChannel), so it
    // fails every time. And our row does not exist yet — TaskCreate owns the
    // INSERT and arrives after this response. Without this the webhook fell
    // back to the attribution rule and filed the task against the contact's
    // earliest OPEN deal, which is only coincidentally the one picked.
    //
    // Recorded even when no deal was picked: that is a decision too, and must
    // stop the rule guessing one.
    await recordPendingDealLink(
      locationId, ENTITY_TASK, task?.id, opportunityId || null,
      req.session?.userId || null,
      // A person made this one, in the app. The AI path records 'ai' — the
      // distinction is the whole point of the column.
      'app'
    );

    // Associations, once the task has an id. NON-FATAL: the task is already
    // written in GHL, and reporting a failure here would tell the rep their
    // task did not save when it did. associationRefresher re-reads relations on
    // the next opportunity event, so a missed link self-heals; a lost task
    // does not.
    let relationError = null;
    if (task?.id && (opportunityId || businessId)) {
      try {
        await setTaskRelations(install, task.id, { opportunityId, businessId });
      } catch (err) {
        relationError = userMessage(err, 'It could not be linked to that deal — you can link it from the task itself.');
        logger.warn(
          { err, taskId: task.id, opportunityId, businessId },
          'tasks: created but could not attach relations'
        );
      }
    }

    res.status(201).json({ task, source: 'ghl', relationError });
  } catch (err) {
    sendWriteError(res, err, next, { locationId, contactId });
  }
});

// PATCH /api/tasks/:id — edit title, description, due date or assignee.
//
// Send only what changed. PATCH rather than PUT because that's what this is:
// GHL's endpoint is a PUT that accepts a partial body, which is a PATCH by
// any other name.
tasksRouter.patch('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const taskId = req.params.id;

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an object of fields to change' });
  }

  try {
    const { install, contactId } = await resolveTaskForWrite(locationId, taskId);
    const task = await updateGhlTask(install, { contactId, taskId }, req.body);
    res.json({ task, source: 'ghl' });
  } catch (err) {
    sendWriteError(res, err, next, { locationId, taskId });
  }
});

// PUT /api/tasks/:id/completed — tick or untick.
//
// Its own route rather than a PATCH with { completed }, mirroring GHL's own
// split: it's the commonest action by far, and the narrowest request can't
// disturb a title or due date by accident.
tasksRouter.put('/:id/completed', async (req, res, next) => {
  const locationId = req.locationId;
  const taskId = req.params.id;
  const { completed } = req.body || {};

  if (typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'completed must be true or false', field: 'completed' });
  }

  try {
    const { install, contactId } = await resolveTaskForWrite(locationId, taskId);
    const task = await setGhlTaskCompleted(install, { contactId, taskId }, completed);
    res.json({ task, source: 'ghl' });
  } catch (err) {
    sendWriteError(res, err, next, { locationId, taskId });
  }
});

// PUT /api/tasks/:id/relations
//   body: { opportunityId?, businessId?, remove?: boolean, updateFutureTasks?: boolean }
//
// Attach or detach the deal and the company a task belongs to.
//
// Its own route rather than part of PATCH /:id: these go through GHL's generic
// relations endpoint rather than the task update, and buildTaskPatch rejects
// unknown fields. Folding them in would mean one request that half-succeeds.
//
// UNLIKE NOTES, task links are genuinely additive — the caps are 10, not 1 —
// so attaching a second deal ADDS it rather than replacing the first. That is
// why `remove` matters here in a way it does not for a note's single deal: the
// only way to change a task's deal is to remove the old link explicitly.
//
// `updateFutureTasks` applies the same link to the recurring template, so
// future occurrences inherit it. Off by default: linking today's task to a deal
// is not a decision about every future occurrence.
tasksRouter.put('/:id/relations', async (req, res, next) => {
  const locationId = req.locationId;
  const taskId = req.params.id;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of relations to change' });
  }
  const { opportunityId, businessId, remove = false, updateFutureTasks = false } = body;
  if (!opportunityId && !businessId) {
    return res.status(400).json({
      error: 'Name a deal or a company to link',
      field: 'opportunityId'
    });
  }

  try {
    // Also proves the task is ours — resolveTaskForWrite reads under RLS, so a
    // task in another location 404s before any GHL call is made.
    const { install } = await resolveTaskForWrite(locationId, taskId);
    await assertRelationTargets(locationId, { opportunityId, businessId });

    if (remove) {
      await removeTaskRelations(install, taskId, { opportunityId, businessId });
    } else {
      await setTaskRelations(install, taskId, {
        opportunityId, businessId, updateFutureTasks
      });
    }

    // No task echoed back: the relations endpoints return the relation, not the
    // task, and re-fetching one to return it would be a request the caller did
    // not ask for. The UI already knows what it linked.
    res.json({ ok: true, source: 'ghl' });
  } catch (err) {
    sendWriteError(res, err, next, { locationId, taskId });
  }
});

// ── PUT /api/tasks/:id/local-links ─────────────────────────────────────
//
// Set a task's deal and company IN OUR DATABASE ONLY.
//
// GHL refuses these writes outright — their tasks.service.ts rejects any task
// write carrying `relations` on the OAuth channel, so /associations/relations,
// its bulk variant and PUT /locations/:id/tasks/:id all fail. There is no
// scope to add and no retry that succeeds; see ghlAssociations.js.
//
// So the link is ours. That has a consequence worth stating: our copy can now
// differ from GHL's, and GHL will not tell us if someone changes it there. A
// TaskCreate carrying its own `relations` array still wins for the deals it
// names (taskWriter mirrors them), which is the behaviour we want — GHL is
// authoritative when it says anything at all, and we fill the silence.
//
// Body: { opportunityId?, businessId? }  — null clears either.
tasksRouter.put('/:id/local-links', async (req, res, next) => {
  const locationId = req.locationId;
  const taskId = req.params.id;
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object of links to set' });
  }
  const hasOpp = 'opportunityId' in body;
  const hasBiz = 'businessId' in body;
  if (!hasOpp && !hasBiz) {
    return res.status(400).json({
      error: 'Name a deal or a company to set', field: 'opportunityId'
    });
  }

  try {
    const result = await withTenant(locationId, async (client) => {
      const t = await client.query(
        `SELECT task_id, contact_id FROM tasks
          WHERE location_id = $1 AND task_id = $2 AND deleted_at IS NULL`,
        [locationId, taskId]
      );
      if (!t.rowCount) return { error: 'That task no longer exists', status: 404 };

      // Both targets are checked against OUR tables. GHL is not in this path
      // to validate them, so a bad id would otherwise be stored happily and
      // render as a broken chip.
      if (hasOpp && body.opportunityId) {
        // EXISTS **and** the task's contact is on it — the same rule the
        // message mapping guard applies (routes/deals.js), and the same
        // scoping the deal picker uses.
        //
        // Existence alone let a task be filed against any deal in the
        // location, including another customer's. PRIMARY **or** additional
        // contact: an architect is on a deal through opportunity_contacts
        // without being its primary, and their tasks belong to it.
        const o = await client.query(
          `SELECT 1 FROM opportunities o
            WHERE o.location_id = $1 AND o.opportunity_id = $2
              AND o.is_deleted = false AND o.deleted_at IS NULL
              AND (
                    o.contact_id = $3
                    OR EXISTS (
                         SELECT 1 FROM opportunity_contacts oc
                          WHERE oc.location_id    = o.location_id
                            AND oc.opportunity_id = o.opportunity_id
                            AND oc.contact_id     = $3
                            AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
                       )
                  )`,
          [locationId, body.opportunityId, t.rows[0].contact_id]
        );
        if (!o.rowCount) {
          return {
            error: 'That deal is not on this contact, so the task cannot be filed against it',
            status: 400, field: 'opportunityId'
          };
        }
      }
      if (hasBiz && body.businessId) {
        const b = await client.query(
          `SELECT 1 FROM businesses WHERE location_id = $1 AND business_id = $2`,
          [locationId, body.businessId]
        );
        if (!b.rowCount) return { error: 'That company was not found', status: 400, field: 'businessId' };
      }

      // Only the keys actually sent — an absent key means "leave it alone",
      // which is not the same as null ("clear it").
      const sets = [];
      const params = [locationId, taskId];
      if (hasOpp) {
        params.push(body.opportunityId || null);
        sets.push(`opportunity_id = $${params.length}`);
        // Mark it a DECISION. Only when the DEAL is being set — a
        // company-only write says nothing about who chose the deal.
        //
        // This is what makes an unlink stick: opportunity_id = NULL alone
        // reads as "not decided yet" and the rule refills it on the next
        // sync; with the flag, NULL means "deliberately no deal".
        sets.push('deal_set_manually = true');
      }
      if (hasBiz) { params.push(body.businessId || null); sets.push(`business_id = $${params.length}`); }

      await client.query(
        `UPDATE tasks SET ${sets.join(', ')}, updated_at = now()
          WHERE location_id = $1 AND task_id = $2`,
        params
      );
      return { ok: true };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error, field: result.field || null });
    }
    logger.info(
      { locationId, taskId, opportunityId: body.opportunityId, businessId: body.businessId },
      'task links set locally (GHL blocks task relation writes over OAuth)'
    );
    res.json({ ok: true, source: 'local' });
  } catch (err) {
    logger.error({ err, locationId, taskId }, 'PUT /api/tasks/:id/local-links failed');
    next(err);
  }
});

// DELETE /api/tasks/:id
tasksRouter.delete('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const taskId = req.params.id;

  try {
    const { install, contactId } = await resolveTaskForWrite(locationId, taskId);
    await deleteGhlTask(install, { contactId, taskId });
    res.json({ ok: true, id: taskId });
  } catch (err) {
    sendWriteError(res, err, next, { locationId, taskId });
  }
});
