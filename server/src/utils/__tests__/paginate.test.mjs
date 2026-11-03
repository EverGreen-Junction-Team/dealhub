// Tests for cursor pagination — utils/paginate.js.
//
// Run: node src/utils/__tests__/paginate.test.mjs
//
// The two cases that break naive cursors, and the reason this isn't OFFSET:
//   • duplicate sort timestamps (needs the id tiebreaker)
//   • a NULL-timestamp tail (sorts last, needs its own predicate branch)
// A bug in either silently drops or repeats rows, which is invisible in the UI
// until someone notices a contact that never appears.
//
// NOTE: the simulation compares timestamps as TIME VALUES, not strings. The
// cursor round-trips through toISOString() so '…09:00:00Z' becomes
// '…09:00:00.000Z' — string comparison would spuriously fail here while the
// real query (Postgres comparing timestamptz) is fine.

import {
  encodeCursor, decodeCursor, keysetClause, orderBy, toPage, parseLimit
} from '../paginate.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── Cursor encoding ──────────────────────────────────────────────────
const c = encodeCursor({ ts: '2026-08-20T10:00:00.000Z', id: 'abc' });
t('round trips', (() => { const d = decodeCursor(c); return d.ts === '2026-08-20T10:00:00.000Z' && d.id === 'abc'; })());
t('opaque to clients', !c.includes('2026'));
t('null timestamp round trips', (() => { const d = decodeCursor(encodeCursor({ ts: null, id: 'z' })); return d.ts === null && d.id === 'z'; })());

// Malformed input must be rejected, not turned into an always-false predicate
// (which would render as a silent empty page — "end of list" when it isn't).
t('rejects garbage', decodeCursor('not-base64!!') === null);
t('rejects empty', decodeCursor('') === null);
t('rejects null', decodeCursor(null) === null);
t('rejects bad date', decodeCursor(Buffer.from(JSON.stringify({ t: 'nonsense', i: 'x' })).toString('base64url')) === null);
t('rejects missing id', decodeCursor(Buffer.from(JSON.stringify({ t: null })).toString('base64url')) === null);

// ── Clause construction ──────────────────────────────────────────────
{
  const p = ['loc'];
  t('no cursor means no clause', keysetClause({ tsExpr: 'ts', idExpr: 'id', cursor: null }, p) === '' && p.length === 1);
}
{
  const p = ['loc'];
  const cl = keysetClause({ tsExpr: 'ts', idExpr: 'id', cursor: { ts: '2026-01-01T00:00:00.000Z', id: 'm5' } }, p);
  t('appends both params', p.length === 3);
  t('includes the null tail', cl.includes('ts IS NULL'));
  t('has the tiebreaker branch', cl.includes('id >'));
}
{
  const p = ['loc'];
  const cl = keysetClause({ tsExpr: 'ts', idExpr: 'id', cursor: { ts: null, id: 'm9' } }, p);
  t('null cursor stays inside the tail', cl.includes('IS NULL') && !cl.includes('<'));
}
t('order matches the cursor', orderBy({ tsExpr: 'ts', idExpr: 'id' }) === 'ORDER BY ts DESC NULLS LAST, id ASC');

// ── Limits ───────────────────────────────────────────────────────────
t('default limit', parseLimit(undefined) === 20);
t('caps at 100', parseLimit(9999) === 100);
t('rejects junk', parseLimit('abc') === 20);
t('rejects zero and negatives', parseLimit(0) === 20 && parseLimit(-5) === 20);

// ── Full walk: duplicate timestamps + NULL tail ──────────────────────
{
  const rows = [
    { id: 'a', ts: '2026-08-20T10:00:00Z' },
    { id: 'b', ts: '2026-08-20T09:00:00Z' },
    { id: 'c', ts: '2026-08-20T09:00:00Z' },   // duplicate ts — needs tiebreaker
    { id: 'd', ts: '2026-08-19T08:00:00Z' },
    { id: 'e', ts: null },                      // NULL tail
    { id: 'f', ts: null }
  ];
  const T = (v) => (v === null ? null : new Date(v).getTime());
  const cmp = (x, y) => {
    const a = T(x.ts), b = T(y.ts);
    if (a === null && b === null) return x.id < y.id ? -1 : 1;
    if (a === null) return 1;
    if (b === null) return -1;
    if (a !== b) return a < b ? 1 : -1;
    return x.id < y.id ? -1 : 1;
  };
  // Emulates the generated SQL: WHERE, then ORDER BY, then LIMIT limit+1.
  const LIMIT = 2;
  const query = (cur) => rows.filter((r) => {
    if (!cur) return true;
    const rt = T(r.ts), ct = T(cur.ts);
    if (ct === null) return rt === null && r.id > cur.id;
    if (rt === null) return true;
    if (rt < ct) return true;
    if (rt === ct && r.id > cur.id) return true;
    return false;
  }).sort(cmp).slice(0, LIMIT + 1);

  let cur = null, seen = [], pages = 0;
  while (pages < 20) {
    const pg = toPage(query(cur), LIMIT, (r) => ({ ts: r.ts, id: r.id }));
    seen.push(...pg.rows.map((r) => r.id));
    pages++;
    if (!pg.nextCursor) break;
    cur = decodeCursor(pg.nextCursor);
  }
  const expected = [...rows].sort(cmp).map((r) => r.id).join(',');
  t('walks every row in sort order', seen.join(',') === expected);
  t('never repeats a row', new Set(seen).size === seen.length);
  t('terminates', pages < 20);
}

// ── toPage ───────────────────────────────────────────────────────────
{
  const rows = Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  const pg = toPage(rows, 20, (r) => ({ ts: r.at, id: r.id }));
  t('trims the probe row', pg.rows.length === 20);
  t('reports hasMore', pg.hasMore === true);
  t('cursor points at the last kept row', decodeCursor(pg.nextCursor).id === 'r19');
  const last = toPage(rows.slice(0, 5), 20, (r) => ({ ts: r.at, id: r.id }));
  t('final page has no cursor', last.nextCursor === null && last.hasMore === false);
  const empty = toPage([], 20, (r) => ({ ts: r.at, id: r.id }));
  t('empty result is safe', empty.rows.length === 0 && empty.nextCursor === null);
}

// ── NUMERIC sort key: the Value column ───────────────────────────────
//
// A number must not round-trip through the timestamp branch: Date(5000) is a
// valid 1970 instant, so the bug would be a quietly mis-ordered page rather
// than an error. These assert the shape stays numeric, and that a full walk
// over duplicate values and a NULL tail still visits every row exactly once.
{
  const d = decodeCursor(encodeCursor({ num: 5000, id: 'd1' }));
  t('numeric cursor round trips', d.num === 5000 && d.id === 'd1' && d.ts === undefined);
  t('numeric zero survives', decodeCursor(encodeCursor({ num: 0, id: 'z' })).num === 0);
  t('null numeric round trips', decodeCursor(encodeCursor({ num: null, id: 'n' })).num === null);
  t('rejects non-finite numeric', decodeCursor(Buffer.from(JSON.stringify({ n: 'abc', i: 'x' })).toString('base64url')) === null);

  const p = ['loc'];
  const cl = keysetClause({ numExpr: 'val', idExpr: 'id', cursor: { num: 100, id: 'm1' }, dir: 'desc' }, p);
  t('numeric desc admits the null tail', cl.includes('val IS NULL'));
  t('numeric clause has no date_trunc', !cl.includes('date_trunc'));
  const pa = ['loc'];
  const ca = keysetClause({ numExpr: 'val', idExpr: 'id', cursor: { num: 100, id: 'm1' }, dir: 'asc' }, pa);
  t('numeric asc does not replay nulls', !ca.includes('IS NULL'));
  t('numeric order matches', orderBy({ numExpr: 'val', idExpr: 'id' }) === 'ORDER BY val DESC NULLS LAST, id ASC');

  const rows = [
    { id: 'a', val: 9000 },
    { id: 'b', val: 500 },
    { id: 'c', val: 500 },   // duplicate value — needs the tiebreaker
    { id: 'd', val: 0 },     // zero is a real value, not an absent one
    { id: 'e', val: null },  // NULL tail
    { id: 'f', val: null }
  ];
  const cmp = (x, y) => {
    if (x.val === null && y.val === null) return x.id < y.id ? -1 : 1;
    if (x.val === null) return 1;
    if (y.val === null) return -1;
    if (x.val !== y.val) return x.val < y.val ? 1 : -1;
    return x.id < y.id ? -1 : 1;
  };
  const LIMIT = 2;
  const query = (cur) => rows.filter((r) => {
    if (!cur) return true;
    if (cur.num === null) return r.val === null && r.id > cur.id;
    if (r.val === null) return true;
    if (r.val < cur.num) return true;
    if (r.val === cur.num && r.id > cur.id) return true;
    return false;
  }).sort(cmp).slice(0, LIMIT + 1);

  const seen = [];
  let cur = null, pages = 0;
  while (pages++ < 20) {
    const pg = toPage(query(cur), LIMIT, (r) => ({ num: r.val, id: r.id }));
    seen.push(...pg.rows.map((r) => r.id));
    if (!pg.nextCursor) break;
    cur = decodeCursor(pg.nextCursor);
  }
  t('numeric walk covers every row in order', seen.join(',') === [...rows].sort(cmp).map((r) => r.id).join(','));
  t('numeric walk never repeats a row', new Set(seen).size === seen.length);
  t('numeric walk terminates', pages < 20);
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL: ${f}`);
process.exit(failures.length ? 1 : 0);
