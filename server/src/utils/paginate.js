// Cursor pagination for the list routes.
//
// Keyset, not OFFSET. Offset pagination re-runs the sort and counts forward, so
// on a table that's constantly receiving webhooks page 2 can repeat a row page
// 1 already showed, or skip one entirely — and the cost grows with the offset.
// A keyset cursor says "everything after this exact row", which is stable
// under concurrent inserts and stays cheap at any depth.
//
// The sort keys here are nullable timestamps (COALESCE(updated_at_ghl,
// created_at_ghl) can still be NULL), so the cursor carries a tiebreaker id and
// the WHERE clause has to handle the NULL tail explicitly. Sorting NULLS LAST
// means "the next page after a NULL row" is "a NULL row with a later id", which
// is why the predicate looks the way it does.

import crypto from 'node:crypto';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export function parseLimit(raw, def = DEFAULT_LIMIT) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Encode a cursor. Opaque to the client on purpose — the shape is ours to
 * change, and a client that parses it will break when we do.
 */
export function encodeCursor({ ts, id, num }) {
  // `num` is the NUMERIC sort key (money, counts) and is carried separately
  // from `ts` rather than reusing it: a number pushed through
  // `new Date(...).toISOString()` becomes an epoch-offset timestamp, which
  // compares as a plausible date instead of failing, so the bug would surface
  // as a quietly mis-ordered page rather than an error.
  const payload = num === undefined
    ? { t: ts ? new Date(ts).toISOString() : null, i: id }
    : { n: num === null ? null : Number(num), i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.i !== 'string') return null;
    // A numeric cursor ('n') and a timestamp cursor ('t') are different
    // shapes; which one this is decides the predicate built below.
    if ('n' in parsed) {
      if (parsed.n !== null && !Number.isFinite(parsed.n)) return null;
      return { num: parsed.n, id: parsed.i };
    }
    // A malformed timestamp would silently produce an always-false predicate
    // and an empty page, which reads as "end of list" — reject it instead.
    if (parsed.t !== null && Number.isNaN(new Date(parsed.t).getTime())) return null;
    return { ts: parsed.t, id: parsed.i };
  } catch (err) {
    return null;
  }
}

/**
 * Build the keyset WHERE fragment for a DESC-NULLS-LAST sort.
 *
 * @param {object} opts
 * @param {string} opts.tsExpr   SQL expression for the sort timestamp
 *                               (e.g. "COALESCE(o.updated_at_ghl, o.created_at_ghl)")
 * @param {string} opts.idExpr   SQL expression for the tiebreaker id
 * @param {object} opts.cursor   decoded cursor, or null
 * @param {Array}  params        the query's params array — appended in place
 * @returns {string} '' when there's no cursor, else 'AND (...)'
 */
// MILLISECOND TRUNCATION, AND WHY THE COMPARISON ALLOWS FOR IT.
//
// Postgres stores a timestamptz to microseconds. node-postgres converts it to
// a JS Date, which holds milliseconds — so a cursor built from a row with
// 16:59:12.226520 carries 16:59:12.226, very slightly EARLIER than the row it
// came from. A strict `ts < cursor` then re-qualifies that row, and the last
// item of every page reappears as the first item of the next.
//
// It cannot be fixed in the cursor: by the time the value reaches us the
// microseconds are already gone. So the comparison truncates the COLUMN to
// milliseconds too, which puts both sides on the same footing.
//
// date_trunc('milliseconds', …) is index-unfriendly on its own, which is why
// the raw column keeps a range guard beside it: Postgres can still use the
// index to narrow to the right second, and only then applies the exact test.
const MS = (expr) => `date_trunc('milliseconds', ${expr})`;

export function keysetClause({ tsExpr, numExpr, idExpr, cursor, dir = 'desc' }, params) {
  if (!cursor) return '';

  // NUMERIC sort key (Value). Same three-branch shape as the timestamp case —
  // strictly past the cursor, the tie broken by id, plus the NULL tail — but
  // with no millisecond truncation, because a numeric column has no precision
  // that survives the client round-trip differently from the database.
  if (numExpr) {
    const nullCmp = dir === 'asc' ? '>' : '<';
    if (cursor.num === null || cursor.num === undefined) {
      // ASC puts NULLs first and DESC last, so in both directions "already in
      // the NULL group" means only larger-id NULL rows remain.
      params.push(cursor.id);
      return `AND (${numExpr} IS NULL AND ${idExpr} > $${params.length})`;
    }
    params.push(cursor.num);
    const nP = params.length;
    params.push(cursor.id);
    // Under DESC the NULL tail still lies ahead, so it has to be admitted here;
    // under ASC the nulls came first and re-admitting them replays every one of
    // them on every page.
    const tail = dir === 'asc' ? '' : `\n    OR ${numExpr} IS NULL`;
    return `AND (
       ${numExpr} ${nullCmp} $${nP}
    OR (${numExpr} = $${nP} AND ${idExpr} > $${params.length})${tail}
  )`;
  }

  // ASC — oldest first. A mirror of the DESC case below, not a variation of
  // it: the comparison flips, and the NULL tail moves to the FRONT because
  // NULLS FIRST is what pairs with ASC in orderBy. Getting either half wrong
  // silently skips or repeats rows at a page boundary rather than erroring.
  if (dir === 'asc') {
    if (cursor.ts === null) {
      // Still in the NULL head: only NULL rows with a larger id remain.
      params.push(cursor.id);
      return `AND (${tsExpr} IS NULL AND ${idExpr} > $${params.length})`;
    }
    params.push(cursor.ts);
    const tsP = params.length;
    params.push(cursor.id);
    // No `OR ts IS NULL` here — under ASC the nulls came FIRST and are already
    // behind us. Including it would replay them on every page.
    return `AND (
         ${MS(tsExpr)} > $${tsP}
      OR (${MS(tsExpr)} = $${tsP} AND ${idExpr} > $${params.length})
    )`;
  }

  if (cursor.ts === null) {
    // We're already in the NULL tail: only NULL-timestamp rows with a larger
    // id remain. (Ties inside the tail are ordered by id ASC — see orderBy.)
    params.push(cursor.id);
    return `AND (${tsExpr} IS NULL AND ${idExpr} > $${params.length})`;
  }

  params.push(cursor.ts);
  const tsParam = params.length;
  params.push(cursor.id);
  const idParam = params.length;

  // Strictly older, OR the same instant with a larger id, OR anything in the
  // NULL tail (which sorts after every non-null row).
  //
  // Both sides truncated to milliseconds — see the MS note above. Without it
  // the row the cursor was built FROM compares as newer than its own cursor
  // and comes back at the top of the next page.
  return `AND (
       ${MS(tsExpr)} < $${tsParam}
    OR (${MS(tsExpr)} = $${tsParam} AND ${idExpr} > $${idParam})
    OR ${tsExpr} IS NULL
  )`;
}

// The ORDER BY that the cursor above assumes. Kept next to it so the two can't
// drift — a mismatch between sort and cursor silently drops or repeats rows.
export function orderBy({ tsExpr, numExpr, idExpr, dir = 'desc' }) {
  if (numExpr) {
    return dir === 'asc'
      ? `ORDER BY ${numExpr} ASC NULLS FIRST, ${idExpr} ASC`
      : `ORDER BY ${numExpr} DESC NULLS LAST, ${idExpr} ASC`;
  }
  // NULLS FIRST under ASC, LAST under DESC — in both cases the undated rows
  // sit at the END of a "newest first" reading and the START of an "oldest
  // first" one, which is the same rule stated twice. keysetClause mirrors it.
  return dir === 'asc'
    ? `ORDER BY ${tsExpr} ASC NULLS FIRST, ${idExpr} ASC`
    : `ORDER BY ${tsExpr} DESC NULLS LAST, ${idExpr} ASC`;
}

/**
 * Turn rows into a page. Fetch limit+1 and pass the whole array: the extra row
 * is how we know another page exists without a COUNT(*) over the table.
 */
export function toPage(rows, limit, cursorOf) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
    hasMore
  };
}
