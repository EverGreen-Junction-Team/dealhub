// skillValidator.js — what a skill is allowed to point at.
//
// A skill names a view and some parameters; the app builds the SELECT. This
// module is the gate between "someone typed a view name into a form" and
// "the AI queries it on behalf of every rep in the sub-account".
//
// THREE THINGS IT ENFORCES, each for a concrete reason:
//
//   1. The view EXISTS and is a view. A typo should fail on save, in front of
//      the person who made it, not inside a rep's question weeks later.
//
//   2. security_invoker = true. Without it a view runs as its OWNER, which
//      bypasses row-level security entirely — one sub-account's data would be
//      returned inside another's answer. Migration 042 exists because this was
//      missed once on ordinary views; here it would be missed on a view
//      somebody added through a web form, which is worse. This check is the
//      single most important line in the file.
//
//   3. Every column named in params / columns / order_by is REAL. Column names
//      cannot be parameterised in SQL — they are interpolated — so the only
//      safe way to use one is to have confirmed it against the catalogue
//      first. That, plus the identifier regex, is what keeps this from being
//      an injection surface.

import { withTenant } from '../../db.js';

export class SkillValidationError extends Error {
  constructor(message, { field = null } = {}) {
    super(message);
    this.name = 'SkillValidationError';
    this.status = 400;
    this.field = field;
  }
}

// Postgres identifiers we are willing to interpolate. Deliberately narrower
// than what Postgres allows: no quoting, no mixed case, no dots. A name that
// needs quoting is a name we will not accept.
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

export const PARAM_TYPES = new Set(['text', 'int', 'number', 'bool', 'date']);
// Operators a parameter may apply. Each maps to a fixed SQL fragment below —
// the operator itself is never taken from user input.
export const PARAM_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']);

export function opToSql(op, col, placeholder) {
  switch (op) {
    case 'eq':       return `${col} = ${placeholder}`;
    case 'neq':      return `${col} <> ${placeholder}`;
    case 'gt':       return `${col} > ${placeholder}`;
    case 'gte':      return `${col} >= ${placeholder}`;
    case 'lt':       return `${col} < ${placeholder}`;
    case 'lte':      return `${col} <= ${placeholder}`;
    // ILIKE with the wildcards added at bind time, so the VALUE stays a bound
    // parameter and a '%' a rep types is matched literally.
    case 'contains': return `${col} ILIKE ${placeholder}`;
    case 'in':       return `${col} = ANY(${placeholder})`;
    default:
      throw new SkillValidationError(`Unsupported operator: ${op}`, { field: 'params' });
  }
}

/**
 * Read a view's real shape from the catalogue.
 * @returns {{ columns: Set<string>, securityInvoker: boolean }}
 */
// Every view a skill COULD point at, for the form's dropdown.
//
// Someone configuring a skill had to type the view's exact name from memory —
// vw_close_reason_by_stage, underscores and all — and the only feedback was a
// validation error after the fact. The names are in the catalogue; there is no
// reason to make anyone recall them.
//
// The filter is deliberately the SAME rule describeView enforces: a plain view
// (relkind 'v', not a table and not a materialised view) in public, created
// WITH (security_invoker = true). Offering a view the validator would then
// refuse is worse than not offering it at all — it reads as a bug in the form.
//
// The view's own COMMENT comes back with it, so the dropdown can show what
// each one is rather than a wall of near-identical names.
export async function listUsableViews(locationId) {
  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT c.relname AS name,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'v'
          AND EXISTS (
                SELECT 1 FROM unnest(COALESCE(c.reloptions, '{}')) AS o
                 WHERE o ~* '^security_invoker[[:space:]]*=[[:space:]]*(true|on)$'
              )
        ORDER BY c.relname`
    );
    return rows.map((r) => ({ name: r.name, comment: r.comment || null }));
  });
}

export async function describeView(locationId, viewName) {
  if (!IDENT.test(viewName || '')) {
    throw new SkillValidationError(
      'A view name must be lower-case letters, digits and underscores.',
      { field: 'viewName' }
    );
  }

  return withTenant(locationId, async (client) => {
    // reloptions carries the storage parameters, which is where
    // security_invoker lives. relkind 'v' is a view, 'm' a materialised view —
    // a matview has no security_invoker and is a snapshot, so it is refused
    // with its own message rather than a confusing "not found".
    const { rows } = await client.query(
      `SELECT c.relkind, c.reloptions
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [viewName]
    );

    if (!rows.length) {
      throw new SkillValidationError(
        `No view named "${viewName}" exists. Check the name with whoever created it.`,
        { field: 'viewName' }
      );
    }
    const rel = rows[0];
    if (rel.relkind === 'm') {
      throw new SkillValidationError(
        `"${viewName}" is a materialised view. Those hold a snapshot and cannot enforce ` +
        'row-level security, so they are not safe to expose to the AI.',
        { field: 'viewName' }
      );
    }
    if (rel.relkind !== 'v') {
      throw new SkillValidationError(
        `"${viewName}" is not a view. A skill can only read a view, not a table — ` +
        'the view is what carries the tenant filter.',
        { field: 'viewName' }
      );
    }

    const opts = rel.reloptions || [];
    const securityInvoker = opts.some(
      (o) => /^security_invoker\s*=\s*(true|on)$/i.test(String(o))
    );
    if (!securityInvoker) {
      throw new SkillValidationError(
        `"${viewName}" was not created WITH (security_invoker = true). Without it the view ` +
        'runs as its owner and ignores row-level security, which would let one sub-account ' +
        "read another's data. Ask the data team to recreate it with that option.",
        { field: 'viewName' }
      );
    }

    // The view's own COMMENT, and each column's. Whoever wrote the view
    // already described it there — asking someone to write that again on the
    // form is duplicated work that goes out of sync the first time the view
    // changes. The form offers these as the starting point.
    const cols = await client.query(
      `SELECT c.column_name,
              col_description(pc.oid, c.ordinal_position::int) AS column_comment
         FROM information_schema.columns c
         JOIN pg_class pc ON pc.relname = c.table_name
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
        WHERE c.table_schema = 'public' AND c.table_name = $1
        ORDER BY c.ordinal_position`,
      [viewName]
    );

    const { rows: cmt } = await client.query(
      `SELECT obj_description(c.oid, 'pg_class') AS view_comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [viewName]
    );
    // A Set, not an Array, because validateSkill below does membership checks
    // on it — but `columns` is ALSO returned straight to the form by
    // GET /skills/views/:name, and JSON.stringify turns a Set into {}. That
    // silently gave the form an object with no .length, so the whole form
    // stayed hidden behind a truthiness check and the status line printed
    // "columns" with no number. Both shapes are returned, each named for what
    // it is, so neither caller has to know about the other's needs.
    // Column order is the view's own, not alphabetical: whoever wrote it put
    // the identifying columns first, and that order is a better default for
    // the picker than a-z.
    const names = cols.rows.map((r) => r.column_name);
    return {
      columns: names,
      columnSet: new Set(names),
      // What each column means, where the view says. Sparse by design — most
      // columns are self-evident from their name and need no comment.
      columnComments: Object.fromEntries(
        cols.rows.filter((r) => r.column_comment).map((r) => [r.column_name, r.column_comment])
      ),
      viewComment: cmt[0]?.view_comment || null,
      securityInvoker: true
    };
  });
}

/**
 * Validate a skill against the view it names. Throws on the first problem,
 * naming the field, so the form can point at it.
 */
export async function validateSkill(locationId, skill) {
  const { columns, columnSet } = await describeView(locationId, skill.viewName);

  // The view MUST expose location_id.
  //
  // runSkill adds `location_id = $n` to every query rather than trusting
  // row-level security — because production connects as a role with
  // rolbypassrls = true, which skips every policy. A view without the column
  // cannot be filtered, so the query would either error or (worse, on a view
  // that happens to aggregate) return every sub-account's data. Refused at
  // save time, where it is one person's problem, rather than at query time in
  // front of a rep.
  if (!columnSet.has('location_id')) {
    throw new SkillValidationError(
      `"${skill.viewName}" has no location_id column. A view the AI reads must expose it ` +
      'so results can be limited to this sub-account. Ask whoever created the view to ' +
      'include location_id — it does not have to be returned, only present.',
      { field: 'viewName' }
    );
  }

  const params = Array.isArray(skill.params) ? skill.params : [];
  const seen = new Set();
  for (const [i, p] of params.entries()) {
    const where = `params[${i}]`;
    if (!IDENT.test(p?.name || '')) {
      throw new SkillValidationError(
        `${where}: a parameter name must be lower-case letters, digits and underscores.`,
        { field: 'params' }
      );
    }
    if (seen.has(p.name)) {
      throw new SkillValidationError(`${where}: duplicate parameter "${p.name}".`, { field: 'params' });
    }
    seen.add(p.name);

    if (!IDENT.test(p?.column || '')) {
      throw new SkillValidationError(`${where}: invalid column name.`, { field: 'params' });
    }
    if (!columnSet.has(p.column)) {
      throw new SkillValidationError(
        `${where}: "${skill.viewName}" has no column "${p.column}". ` +
        `It has: ${columns.join(', ')}`,
        { field: 'params' }
      );
    }
    if (!PARAM_TYPES.has(p?.type)) {
      throw new SkillValidationError(
        `${where}: type must be one of ${[...PARAM_TYPES].join(', ')}.`, { field: 'params' }
      );
    }
    if (!PARAM_OPS.has(p?.op || 'eq')) {
      throw new SkillValidationError(
        `${where}: operator must be one of ${[...PARAM_OPS].join(', ')}.`, { field: 'params' }
      );
    }
    // The model picks tools on descriptions; a parameter with none is a
    // parameter it will fill in wrongly.
    if (!String(p?.description || '').trim()) {
      throw new SkillValidationError(
        `${where}: every parameter needs a description — the AI reads it to decide what to pass.`,
        { field: 'params' }
      );
    }
  }

  const cols = Array.isArray(skill.columns) ? skill.columns : [];
  for (const c of cols) {
    if (!IDENT.test(c || '') || !columnSet.has(c)) {
      throw new SkillValidationError(
        `"${skill.viewName}" has no column "${c}".`, { field: 'columns' }
      );
    }
  }

  if (skill.orderBy) {
    // "col", "col DESC", "col DESC NULLS LAST" — a fixed grammar, nothing
    // else. An expression, a function call or a second column is refused
    // rather than interpolated: runSkill puts this string straight into the
    // SQL, so this regex is the injection boundary, not a formatting rule.
    //
    // NULLS FIRST/LAST is allowed because the default is a trap on the views
    // that need it. Postgres sorts NULLs FIRST under DESC, so a list ordered
    // by "value DESC" leads with the rows whose value is missing — exactly
    // the wrong end for "show me the biggest deals". Without this clause the
    // only fix is to reorder in application code, far from the definition.
    const m = String(skill.orderBy).trim()
      .match(/^([a-z][a-z0-9_]*)(\s+(asc|desc))?(\s+nulls\s+(first|last))?$/i);
    if (!m || !columnSet.has(m[1])) {
      throw new SkillValidationError(
        'Sort must be a column name, optionally followed by ASC or DESC, '
        + 'and optionally NULLS FIRST or NULLS LAST.',
        { field: 'orderBy' }
      );
    }
  }

  return { columns };
}
