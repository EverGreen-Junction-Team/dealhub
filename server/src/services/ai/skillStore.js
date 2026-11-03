// skillStore.js — CRUD for ai_skills, and the runner that executes one.
//
// The SELECT is BUILT here, never stored. A skill contributes a view name,
// some column names and some bound values; everything structural is ours.
// Column names are interpolated because SQL cannot parameterise an identifier
// — which is exactly why skillValidator checks every one against the view's
// real catalogue entry before a row is ever written.

import { withTenant } from '../../db.js';
import { logger } from '../../utils/logger.js';
import { validateSkill, describeView, opToSql, SkillValidationError } from './skillValidator.js';

export { SkillValidationError };

const SELECT_COLS = `id, name, description, view_name, params, columns,
                     order_by, row_limit, surfaces, is_enabled,
                     created_by, updated_by, created_at, updated_at,
                     last_used_at, use_count`;

const shape = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  viewName: r.view_name,
  params: r.params || [],
  columns: r.columns || [],
  orderBy: r.order_by,
  rowLimit: r.row_limit,
  surfaces: r.surfaces || [],
  isEnabled: r.is_enabled,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count
});

// The columns a skill returns. An explicit choice wins; otherwise every column
// the view has. Resolved once, at save time — the view's shape changes with a
// migration, not between questions.
async function resolveColumns(locationId, skill) {
  if (skill.columns?.length) return skill.columns;
  const { columns } = await describeView(locationId, skill.viewName);
  return columns;
}

export async function listSkills(locationId, { enabledOnly = false, surface = null } = {}) {
  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT ${SELECT_COLS} FROM ai_skills
        WHERE location_id = $1
          AND ($2::boolean = false OR is_enabled = true)
          AND ($3::text IS NULL OR $3 = ANY(surfaces))
        ORDER BY name`,
      [locationId, enabledOnly, surface]
    );
    return rows.map(shape);
  });
}

export async function getSkill(locationId, id) {
  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT ${SELECT_COLS} FROM ai_skills WHERE location_id = $1 AND id = $2`,
      [locationId, id]
    );
    return rows[0] ? shape(rows[0]) : null;
  });
}

export async function createSkill(locationId, skill, userId = null) {
  await validateSkill(locationId, skill);
  // Store the view's full column list when none was chosen, so runSkill can
  // build an explicit SELECT without a catalogue lookup on every question.
  // `SELECT *` is not an option — it would put location_id back in.
  skill = { ...skill, columns: await resolveColumns(locationId, skill) };
  return withTenant(locationId, async (client) => {
    try {
      const { rows } = await client.query(
        `INSERT INTO ai_skills
           (location_id, name, description, view_name, params, columns,
            order_by, row_limit, surfaces, is_enabled, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::text[],$10,$11,$11)
         RETURNING ${SELECT_COLS}`,
        [
          locationId, skill.name, skill.description, skill.viewName,
          JSON.stringify(skill.params || []), JSON.stringify(skill.columns || []),
          skill.orderBy || null, skill.rowLimit ?? 50,
          skill.surfaces?.length ? skill.surfaces : ['deal', 'portfolio'],
          skill.isEnabled !== false, userId
        ]
      );
      return shape(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        throw new SkillValidationError(
          // "here" meant "in this sub-account", which is not what it says.
          // Skills are per sub-account (UNIQUE (location_id, name)), so the
          // same name is free in another one — and a rep seeing this while
          // the view, description and everything else matched could
          // reasonably read it as "this skill exists globally, I am done".
          `This sub-account already has a skill called "${skill.name}". `
          + 'Rename this one, or edit the existing skill instead.',
          { field: 'name' }
        );
      }
      throw err;
    }
  });
}

export async function updateSkill(locationId, id, patch, userId = null) {
  const existing = await getSkill(locationId, id);
  if (!existing) return null;
  // Validate the MERGED skill, not the patch: changing only `params` still has
  // to be checked against the view the skill already names.
  await validateSkill(locationId, { ...existing, ...patch });
  const merged = { ...existing, ...patch };
  patch = { ...patch, columns: await resolveColumns(locationId, merged) };

  return withTenant(locationId, async (client) => {
    const next = { ...existing, ...patch };
    const { rows } = await client.query(
      `UPDATE ai_skills
          SET name = $3, description = $4, view_name = $5,
              params = $6::jsonb, columns = $7::jsonb,
              order_by = $8, row_limit = $9, surfaces = $10::text[],
              is_enabled = $11, updated_by = $12, updated_at = now()
        WHERE location_id = $1 AND id = $2
        RETURNING ${SELECT_COLS}`,
      [
        locationId, id, next.name, next.description, next.viewName,
        JSON.stringify(next.params || []), JSON.stringify(next.columns || []),
        next.orderBy || null, next.rowLimit ?? 50,
        next.surfaces?.length ? next.surfaces : ['deal', 'portfolio'],
        next.isEnabled !== false, userId
      ]
    );
    return rows[0] ? shape(rows[0]) : null;
  });
}

export async function deleteSkill(locationId, id) {
  return withTenant(locationId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM ai_skills WHERE location_id = $1 AND id = $2`,
      [locationId, id]
    );
    return rowCount > 0;
  });
}

/**
 * Run a skill. Called from the tool loop with whatever the model passed.
 *
 * Everything structural — the view, the columns, the operators — comes from a
 * row that was validated on save. Everything from the MODEL is a bound value.
 */
export async function runSkill(locationId, skill, args = {}) {
  // Every column the view has, minus location_id.
  //
  // A skill only ever runs inside withTenant(), so every row already belongs
  // to the one sub-account asking — the column is constant across the result
  // and tells the model nothing. Returning it is tokens spent on a value the
  // caller already knew, repeated on every row.
  //
  // Dropped here rather than asked about on the form: it is true of every
  // view, so making someone deselect it each time would be a chore with one
  // right answer.
  // Columns are normally resolved when the skill is SAVED (see createSkill),
  // so no catalogue lookup is needed on the hot path.
  //
  // But an empty list has to fall back, not fail. Two ways it happens: a skill
  // saved before that resolution existed, and a view that gained a column
  // afterwards — in both cases the stored list is stale rather than wrong, and
  // the view itself is the source of truth. Failing here told a rep the view
  // "has no columns available", which is a confusing thing to read about a
  // view that plainly has six.
  //
  // location_id is always dropped: a skill only runs inside withTenant(), so
  // every row already belongs to the one sub-account asking. The column is
  // constant across the result and tells the model nothing, but costs tokens
  // on every row.
  let columns = skill.columns || [];
  if (!columns.length) {
    try {
      ({ columns } = await describeView(locationId, skill.viewName));
    } catch (err) {
      logger.error(
        { err, locationId, skill: skill.name, view: skill.viewName },
        'runSkill: could not resolve columns from the view'
      );
      return {
        error: `The "${skill.name}" skill could not run — the view it reads may have `
             + 'changed or been removed. This is a setup problem, not something to retry.'
             + ' Do not answer the question with other tools instead — a rep who asked for this skill wants this skill, and a substitute silently answers a different question. Say plainly that it is unavailable and stop.'
      };
    }
  }

  const cols = columns.filter((c) => c !== 'location_id').join(', ');
  if (!cols) {
    return {
      error: `The "${skill.name}" skill has no columns to return — the view `
           + `"${skill.viewName}" exposes nothing beyond location_id.`
           + ' Do not answer the question with other tools instead — a rep who asked for this skill wants this skill, and a substitute silently answers a different question. Say plainly that it is unavailable and stop.'
    };
  }

  const where = [];
  const values = [];
  for (const p of skill.params || []) {
    const raw = args[p.name];
    // Absent means "no filter", which is how a model expresses "all of them".
    if (raw === undefined || raw === null || raw === '') continue;

    const op = p.op || 'eq';
    let value = raw;
    if (op === 'contains') value = `%${String(raw)}%`;
    else if (op === 'in')  value = Array.isArray(raw) ? raw : [raw];
    else if (p.type === 'int')    value = parseInt(raw, 10);
    else if (p.type === 'number') value = Number(raw);
    else if (p.type === 'bool')   value = raw === true || raw === 'true';

    if ((p.type === 'int' || p.type === 'number') && Number.isNaN(value)) {
      // A model occasionally passes "thirty" for a number. Skipping the filter
      // returns too much; failing the whole tool returns nothing. Say what was
      // wrong so it can retry with a real number.
      return { error: `${p.name} must be a number — got "${raw}".` };
    }

    values.push(value);
    where.push(opToSql(op, p.column, `$${values.length}`));
  }

  // TENANT FILTER, IN THE QUERY — not left to row-level security.
  //
  // RLS is the design, but it is not the guarantee: the production app
  // connects as a role with rolbypassrls = true, so every policy is skipped.
  // The 37 hand-written tools in registry.js survive that because each one
  // carries `location_id = $1` in its own SQL. A skill had no such predicate,
  // so it returned every sub-account's rows — the one query in the system
  // relying on RLS alone was the one a customer could point at their data.
  //
  // So the predicate is added here, always, and the view must expose the
  // column for it (enforced on save — see skillValidator). RLS stays as the
  // second layer; neither is trusted on its own.
  values.push(locationId);
  where.unshift(`location_id = $${values.length}`);

  const limit = Math.min(skill.rowLimit || 50, 500);
  const sql = `SELECT ${cols} FROM ${skill.viewName}`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + (skill.orderBy ? ` ORDER BY ${skill.orderBy}` : '')
    + ` LIMIT ${limit}`;

  try {
    const rows = await withTenant(locationId, async (client) => {
      const r = await client.query(sql, values);
      return r.rows;
    });

    // Fire-and-forget: a usage counter must never fail a rep's question.
    markUsed(locationId, skill.id).catch(() => {});

    return {
      rows,
      count: rows.length,
      truncated: rows.length === limit,
      source: skill.viewName,
      // LINEAGE: the exact query behind these rows.
      //
      // Built here and then thrown away, which meant a number could be shown
      // and never traced — the one thing that makes a wrong answer
      // undiagnosable. A reader could see WHICH view answered, but not which
      // filters narrowed it, so "why does this say 14?" had no answer short
      // of re-deriving the call by hand.
      //
      // Values are included because a filter is half the explanation: the same
      // SQL with min_deals = 5 and min_deals = 50 are different answers. They
      // are the model's own arguments, already validated against the view's
      // columns, so nothing here is user-supplied text.
      //
      // Not shown to the model — it is for the answer's provenance trail and
      // for whoever is asked to explain a figure later.
      query: { sql, values },
      // An empty result is not an error, and the model must not describe it
      // as one. "No data came back from that view" reads as a broken lookup;
      // the truth is usually that this sub-account has nothing matching — a
      // brand with no lost deals genuinely has no drop-off pattern.
      //
      // Said explicitly because the model cannot tell the two apart from an
      // empty array, and it guessed wrong twice: once calling it "no record
      // in the system" (it is one sub-account, not the system) and once "no
      // data came back from that view" (which sounds like a fault).
      ...(rows.length === 0 ? {
        note: 'This returned no rows. That is a real answer, not a failure: '
            + 'this sub-account has nothing matching. Say so plainly in terms of '
            + 'the question the rep asked — not "the view returned nothing", and '
            + 'not "there is no record in the system", since only this '
            + 'sub-account was searched.'
      } : {})
    };
  } catch (err) {
    logger.error(
      { err, locationId, skill: skill.name, view: skill.viewName },
      'runSkill: query failed'
    );
    // The view may have been dropped or altered since the skill was saved.
    return {
      error: `The "${skill.name}" skill could not run — the data it reads may have changed. `
           + 'This is a setup problem, not something to retry or reword.'
           + ' Do not answer the question with other tools instead — a rep who asked for this skill wants this skill, and a substitute silently answers a different question. Say plainly that it is unavailable and stop.'
    };
  }
}

async function markUsed(locationId, id) {
  return withTenant(locationId, async (client) => {
    await client.query(
      `UPDATE ai_skills SET last_used_at = now(), use_count = use_count + 1
        WHERE location_id = $1 AND id = $2`,
      [locationId, id]
    );
  });
}
