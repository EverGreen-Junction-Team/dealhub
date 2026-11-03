// Route-shadowing guard. Express matches in declaration order, so any
// single-segment GET registered AFTER '/:id' is swallowed and returns a deal
// lookup for the literal string. That has already happened twice in this file
// (/lost-reasons, /custom-field-options), so it gets a test rather than a
// comment.
//
// Parses the source instead of booting the app: the real router needs a
// database, a session and GHL credentials, none of which this question depends
// on. What matters is purely the ORDER of the declarations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved relative to this file so the test runs from any cwd.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'deals.js'), 'utf8');

const gets = [...src.matchAll(/dealsRouter\.get\('([^']+)'/g)]
  .map((m) => ({ path: m[1], at: m.index }));

const idRoute = gets.find((g) => g.path === '/:id');
assert.ok(idRoute, "expected a GET '/:id' route to exist");

// Single-segment literal paths — the ones '/:id' can shadow.
const shadowable = gets.filter(
  (g) => g.path !== '/:id' && g.path !== '/' && !g.path.includes(':') && g.path.split('/').length === 2
);

console.log('deals.js route order');
console.log('  GET /:id declared at offset', idRoute.at);

let n = 0;
for (const r of shadowable) {
  assert.ok(
    r.at < idRoute.at,
    `GET '${r.path}' is declared AFTER '/:id' (${r.at} > ${idRoute.at}) — ` +
    `'/:id' will capture it and look up a deal named "${r.path.slice(1)}"`
  );
  n++;
  console.log(`  ok  ${r.path} precedes /:id`);
}

assert.ok(n >= 4, `expected at least 4 single-segment routes, found ${n}`);

// The two routes this feature adds must be present, or the edit row has no
// pipelines and no owner list.
for (const required of ['/pipelines', '/users']) {
  assert.ok(
    shadowable.some((r) => r.path === required),
    `missing GET ${required}`
  );
  console.log(`  ok  ${required} exists`);
}

console.log(`\n${n + 2} passed`);
