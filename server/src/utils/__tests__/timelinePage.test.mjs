// Tests for utils/timelinePage.js — the Deal Hub timeline's infinite scroll.
//
// Run: node src/utils/__tests__/timelinePage.test.mjs

import { readFileSync } from 'node:fs';
import { pageTimeline } from '../timelinePage.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const at = (min) => new Date(Date.UTC(2026, 9, 20, 12, 0) - min * 60e3).toISOString();
// Newest first, as the route merges it.
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, ts: at(i) }));

// ── unpaged / short ──────────────────────────────────────────────────
const all = rows(10);
t('no page size returns everything', pageTimeline(all, null).page.length === 10);
t('no page size has no more', pageTimeline(all, null).hasMore === false);
t('a short timeline is one page with nothing more',
  pageTimeline(all, 50).page.length === 10 && pageTimeline(all, 50).hasMore === false
  && pageTimeline(all, 50).nextBefore === null);

// ── a real cut ───────────────────────────────────────────────────────
const big = rows(51);   // limit + 1 from one source
const p = pageTimeline(big, 50);
t('the newest page size rows are returned', p.page.length === 50 && p.page[0].id === 'r0');
t('more is reported', p.hasMore === true);
t('the cursor is the last row on the page', p.nextBefore === big[49].ts);

// The next page is everything strictly before the cursor.
const next = big.filter((r) => new Date(r.ts) < new Date(p.nextBefore));
t('nothing is skipped or repeated across the cut',
  next.length === 1 && next[0].id === 'r50');

// ── same-instant rows are never split ────────────────────────────────
const tied = [...rows(49), { id: 'a', ts: at(49) }, { id: 'b', ts: at(49) }, { id: 'c', ts: at(60) }];
const pt = pageTimeline(tied, 50);
t('a tie at the cut is kept together', pt.page.map((r) => r.id).includes('b'));
t('the page grows past the size only for the tie', pt.page.length === 51);
t('the next page starts after the tied group', pt.nextBefore === at(49) && pt.hasMore);

// ── rows without a timestamp ─────────────────────────────────────────
const undated = [...rows(50), { id: 'u1', ts: null }];
const pu = pageTimeline(undated, 50);
t('an undated row lands after the dated ones', pu.hasMore && pu.page.length === 50);
t('the cursor is still a real instant', !Number.isNaN(new Date(pu.nextBefore).getTime()));

// ── the route uses it ────────────────────────────────────────────────
const route = readFileSync(new URL('../../routes/deals.js', import.meta.url), 'utf8');
const handler = route.slice(route.indexOf("dealsRouter.get('/:id/timeline'"));
t('the route pages with the helper', /pageTimeline\(merged, pageSize\)/.test(handler));
t('each source is cut in SQL, with one extra row',
  (handler.slice(0, handler.indexOf('pageTimeline(')).match(/LIMIT \$4/g) || []).length === 3
  && /pageSize \? pageSize \+ 1 : null/.test(handler));
t('each source honours the cursor, undated rows as the epoch',
  (handler.slice(0, handler.indexOf('pageTimeline(')).match(/'epoch'::timestamptz\) < \$3::timestamptz/g) || []).length === 3);
t('the page size is bounded', /Math\.min\(Math\.max\(parseInt\(req\.query\.limit, 10\) \|\| 0, 1\), 200\)/.test(handler));
t('a bad cursor is a 400', /before must be a timestamp/.test(handler));
t('the response carries hasMore and nextBefore', /hasMore,\s*\n\s*nextBefore/.test(handler));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
