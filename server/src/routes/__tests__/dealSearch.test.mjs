// Finding a deal by the person it belongs to.
//
// A deal did not appear in the switcher on a location with 356 open deals.
// Two independent causes:
//
//   1. THE SWITCHER SEARCHED A CACHED PAGE. It fetched `limit: 200`, the
//      server caps at 100 (MAX_LIMIT), and then filtered that array in the
//      browser. So it could only ever find the first 100 deals, and reported
//      "0 of 100 match" — which a rep reads as "none of your deals match".
//
//   2. THE SERVER MATCHED o.name ALONE. Searching a customer's email or
//      phone found nothing even within those 100 — and GHL names an
//      opportunity after its contact, so a rep types a person far more often
//      than a deal title.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, '..', 'deals.js'), 'utf8');
const paginate = readFileSync(join(here, '..', '..', 'utils', 'paginate.js'), 'utf8');
// The dashboard is a SEPARATE repository.
//
// On a server-only checkout — which is what production is — this file does
// not exist, and a bare readFileSync threw ENOENT and failed `npm test`
// before a deploy. The server's own assertions have nothing to do with the
// dashboard, so they must still run.
const HUB = join(here, '..', '..', '..', '..', '..', 'pipelinePulse-dashboard', 'src',
  'pages', 'tabs', 'DealHubTab.jsx');
const hub = existsSync(HUB) ? readFileSync(HUB, 'utf8') : null;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('the server search');

t('matches the deal name AND its contact', () => {
  // Verified against a real Postgres: 'jsmillie', '447885' and 'Smillie'
  // all find the deal now; only 'Ed Rose' and 'cortec' did before.
  // Columns are space-aligned in the SQL, so match on the pair rather than
  // an exact spacing — the first version of this test failed on whitespace.
  for (const col of ['first_name', 'last_name', 'email', 'phone', 'company_name']) {
    assert.match(route, new RegExp(`c\\.${col}\\s+ILIKE`), `${col} is not searched`);
  }
  assert.match(route, /o\.name ILIKE/);
});

t('all the terms share ONE parameter, captured at PUSH time', () => {
  // Six placeholders would need six pushes; reusing the index keeps the
  // params array in step with the clause.
  //
  // The index must be `qParam`, captured where q is pushed — NOT
  // `params.length` read where the clause is built. This clause is assembled
  // ~75 lines after the push, so params.length there points at whichever
  // filter pushed last: with q + owner + tag set it referenced $6 while the
  // value sat at $2, and Postgres answered "could not determine data type of
  // parameter $3". It only ever worked while q happened to be the last filter
  // to push, which adding the tag filter ended.
  const clause = /const qClause = q\s*\n\s*\? `AND \(([\s\S]*?)\)`/.exec(route);
  assert.ok(clause, 'the qClause shape changed');
  const nums = [...clause[1].matchAll(/\$\$\{qParam\}/g)];
  assert.equal(nums.length, 6, `expected 6 uses of one param, found ${nums.length}`);
  assert.doesNotMatch(clause[1], /params\.length/,
    'the clause must not read params.length — it is built long after q is pushed');
  assert.match(route, /let qParam = 0;\s*\n\s*if \(q\) \{ params\.push/,
    'qParam must be captured at the moment q is pushed');
});

t('the contacts join is LEFT, so a deal with no contact still matches', () => {
  // An inner join would hide every contactless deal from search entirely.
  assert.match(route, /LEFT JOIN contacts c\s*\n\s*ON c\.location_id = o\.location_id/);
});

console.log('\nthe cap that hid the deal');

t('the server caps a page at 100', () => {
  // The number in "0 of 100 match" was this, not a count of the location.
  assert.match(paginate, /const MAX_LIMIT = 100/);
});

if (!hub) {
  console.log('  (dashboard repo not checked out — skipping its 5 checks)');
} else {
  t('the switcher no longer filters a cached page', () => {
    assert.ok(!/deals\.filter\(\(d\) =>/.test(hub),
      'client-side filtering is back — it can only ever see one page');
    assert.match(hub, /dealsAPI\.list\(\{ q, status: 'all', limit: 50 \}\)/,
      'the switcher must ask the server');
  });

  t('an explicit search covers closed deals too', () => {
    // The default list is open-only, but someone searching by name is often
    // after a deal they have already won or lost.
    assert.match(hub, /status: 'all'/);
  });

  t('the count reports RESULTS, not the cached page size', () => {
    assert.ok(!/\$\{visible\.length\} of \$\{deals\.length\} match/.test(hub),
      '"0 of 100 match" is back — it describes the cache, not the location');
    assert.match(hub, /deals' : 'deals'\}\` found\`|\} found\`/);
  });

  t('the empty state says how widely it looked', () => {
    // "No deals match X" invites the reader to assume we only checked a subset
    // — which is exactly what used to be true.
    assert.match(hub, /searched every deal in this/);
  });

  t('the request is debounced and stale replies are dropped', () => {
    // Typing fast otherwise leaves an earlier query's results on screen.
    // Two separate assertions rather than one span: the comment between them
    // is longer than any sensible window, and a brittle gap made this fail on
    // documentation rather than behaviour.
    assert.match(hub, /const t = window\.setTimeout\(\(\) => \{/);
    assert.match(hub, /window\.clearTimeout\(t\)/);
    assert.match(hub, /if \(alive\) setSwitcherHits/);
  });
}

console.log(`\n${n} passed`);
