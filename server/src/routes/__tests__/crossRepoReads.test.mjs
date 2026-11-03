// A server test must never FAIL because the dashboard is not checked out.
//
// Production runs a server-only clone. `npm test` there hit:
//
//   Error: ENOENT: no such file or directory, open
//   '/root/pipelinePulse-dashboard/src/pages/tabs/DealHubTab.jsx'
//
// which failed the whole suite and blocked a deploy — over five assertions
// about front-end source that have nothing to do with the server.
//
// Cross-repo assertions are still worth having: they catch a server field
// rename that silently breaks the UI. They just have to skip when the
// sibling repo is absent, not throw.
//
// Run: node src/routes/__tests__/crossRepoReads.test.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : (f.endsWith('.mjs') ? [p] : []);
  });
}

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const tests = walk(src).filter((f) => f.includes('__tests__'));
const crossRepo = tests.filter((f) =>
  readFileSync(f, 'utf8').includes('pipelinePulse-dashboard')
);

t('found the test files', tests.length > 5);

for (const f of crossRepo) {
  const body = readFileSync(f, 'utf8');
  const name = f.split('/').pop();

  t(`${name} checks the path exists before reading it`,
    // existsSync guarding the read is what turns a crash into a skip.
    body.includes('existsSync'));

  t(`${name} never reads the dashboard unguarded`,
    // A readFileSync whose path mentions the dashboard and is not wrapped in
    // a presence check is the exact shape that broke the deploy.
    !/readFileSync\(\s*\n?\s*join\([^)]*pipelinePulse-dashboard/.test(body)
    || body.includes('existsSync'));

  t(`${name} says when it skipped, rather than passing silently`,
    // A skip that prints nothing looks identical to a test that ran — which
    // is how a broken path can hide. This bit me on messageMapping.
    /not checked out|skipping/i.test(body));
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
