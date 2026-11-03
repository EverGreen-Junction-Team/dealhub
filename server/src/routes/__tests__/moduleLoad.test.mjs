// Every module must actually LOAD.
//
// WHAT THIS DOES AND DOES NOT CATCH — worth stating, because I got it wrong.
//
// It catches import-time failures: a bad specifier, a missing file, a circular
// import that leaves a binding undefined, a module-level throw.
//
// It does NOT catch the bug that prompted it. `contactLabel is not defined`
// took the deal timeline down with a 500, and importing the module does not
// throw for that: the identifier is referenced inside a route handler, so the
// ReferenceError is deferred until that line executes on a real request.
// Verified by removing the import and watching this test still pass.
//
// The thing that DOES catch it is `npx eslint src` (no-undef). That ran clean
// locally, which means the deployed file was not the file that was linted —
// the server had the calls without the import line. So the real lesson is
// about deploying a verified artifact, not about a missing test.
//
// Kept anyway: it is cheap, and an import-time failure is a whole-process
// crash rather than one broken route.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The minimum env these modules need at import time. Requiring a real database
// to prove a file parses would defeat the point.
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..');

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    // index.js starts the HTTP server and the cron schedule on import.
    // scripts/ are one-shot CLIs that run on import by design.
    if (!e.name.endsWith('.js')) continue;
    if (full.endsWith(join('src', 'index.js'))) continue;
    if (full.includes(join('src', 'scripts'))) continue;
    files.push(full);
  }
};
walk(SRC);

let n = 0;
const failures = [];

console.log(`module load — ${files.length} files`);

for (const f of files.sort()) {
  const rel = f.slice(SRC.length + 1);
  try {
    await import(f);
    n++;
  } catch (err) {
    // A ReferenceError here is the exact production failure: an identifier
    // used without being imported.
    failures.push(`${rel}\n      ${err.constructor.name}: ${err.message}`);
  }
}

if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log('  FAIL  ' + f);
}

assert.deepEqual(failures, [],
  `${failures.length} module(s) failed to load — these throw at runtime on the `
  + 'first request that reaches them');

console.log(`\n${n} modules loaded, 0 failures`);
