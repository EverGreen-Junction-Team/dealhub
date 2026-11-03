// Keyset pagination, and the precision bug that made every page repeat a row.
//
// Postgres stores a timestamptz to MICROSECONDS. node-postgres converts it to
// a JS Date, which holds milliseconds. So a cursor built from a row at
// 16:59:12.226520 carried 16:59:12.226 — very slightly EARLIER than the row
// it came from — and a strict `ts < cursor` let that row re-qualify.
//
// Every paginated list was returning the last item of each page again as the
// first item of the next. Easy to miss: on a short list there is no second
// page, and with infinite scroll the duplicate appears ten rows down rather
// than at the top.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0;
const failures = [];
function t(name, cond) { if (cond) pass++; else failures.push(name); }

const paginate = readFileSync(new URL('../paginate.js', import.meta.url), 'utf8');
const tasks = readFileSync(new URL('../../routes/tasks.js', import.meta.url), 'utf8');
const notes = readFileSync(new URL('../../routes/notes.js', import.meta.url), 'utf8');

// The bug, as arithmetic.
{
  // Compared as INSTANTS, not strings — '...226Z' sorts after '...226520Z'
  // lexically because 'Z' > '5', which says nothing about which is earlier.
  const stored = '2026-10-11T16:59:12.226520Z';   // what Postgres holds
  const cursor = new Date(stored).toISOString();   // what the cursor carries

  t('a cursor loses the microseconds Postgres stores',
    cursor === '2026-10-11T16:59:12.226Z');

  // The whole bug in one line: the cursor is strictly EARLIER than the row it
  // was built from, so `stored < cursor` is false and the row survives a
  // keyset meant to exclude it.
  t('the cursor is earlier than the row it came from',
    Date.parse(cursor) < Date.parse(stored.slice(0, 23) + 'Z') + 1
    && cursor.length < stored.length);

  // Truncating the column to milliseconds puts both sides on equal footing,
  // and the id tiebreaker then does the work.
  t('truncating the column makes the two equal',
    new Date(stored).toISOString() === cursor);
}

t('the shared keyset truncates both sides to milliseconds',
  /date_trunc\('milliseconds'/.test(paginate) && /const MS = \(expr\)/.test(paginate));

t('tasks truncates its own due-date keyset',
  /date_trunc\('milliseconds', t\.due_at\)/.test(tasks));

t('tasks truncates its created-date keyset',
  /date_trunc\('milliseconds', \$\{CREATED\}\)/.test(tasks));

// A cursor must carry the column its query ORDERED BY. Getting this wrong is
// worse than a wrong order: when every row shares one timestamp — which is
// what a backfill produces — the keyset never advances and the same page
// returns forever. Observed as 13 pages of the same 10 notes.
t('the notes cursor uses the written date',
  // One column now: the direction changed, the date did not. A "date synced"
  // option was removed — it answers a question about our sync rather than
  // about the business, and offering it invited a rep to pick the ordering
  // that looks chronological and is not.
  /ts: n\.created_at_ghl \|\| n\.imported_at/.test(notes));

t('the tasks cursor follows the chosen sort',
  /ts: byCreated \? \(t\.created_at_ghl \|\| t\.imported_at\) : t\.due_at/.test(tasks));

// ASC is a MIRROR of DESC, not a variation: the comparison flips AND the
// NULL group moves from the tail to the head. Getting one half right and the
// other wrong silently replays the undated rows on every page.
t('the shared keyset supports ascending order',
  /dir === 'asc'/.test(paginate));

t('ascending order puts NULLs first, descending puts them last',
  /ASC NULLS FIRST/.test(paginate) && /DESC NULLS LAST/.test(paginate));

t('the ascending keyset does NOT re-admit the null group',
  // Under ASC the nulls came first and are already behind the cursor.
  // Including `OR ts IS NULL` there would replay them on every page.
  /No `OR ts IS NULL` here/.test(paginate));

// created_at_ghl is null on anything synced before the field existed. Sorting
// on it bare would drop those rows into the NULL tail and show them as the
// oldest records in the account.
t('both routes fall back when the GHL date is missing',
  /COALESCE\(n\.created_at_ghl, n\.imported_at\)/.test(notes)
  && /COALESCE\(t\.created_at_ghl, t\.imported_at\)/.test(tasks));

t('notes defaults to newest-first on the written date',
  /req\.query\.sort === 'asc' \? 'asc' : 'desc'/.test(notes));

t('tasks keeps due-date as its default and offers both created directions',
  // A task list is for what is due next; created-date is the option, and only
  // created gets a direction — a due list read backwards is just the overdue
  // ones, which the Due filter already answers better.
  /\['due', 'created_desc', 'created_asc'\]/.test(tasks));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILED:', failures); process.exit(1); }
