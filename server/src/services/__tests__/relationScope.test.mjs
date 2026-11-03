// The note/task relation writes must not be able to halt a location.
//
// WHAT HAPPENED. A PUT /notes/:id/relations returned
//   401 {"statusCode":401,"message":"The token is not authorized for this scope."}
// GHL said "scope", not "expired". ghlClient force-refreshed anyway, GHL issued
// a NEW token, the retry 401'd identically — and because the call was not
// scope-optional, the install was marked reauth_required. That halts EVERY
// sync for the location: conversations, call recordings, opportunities. One
// failed deal-link on one note took all of it down, and the caller got a bare
// `internal_error` 500 that named none of this.
//
// TWO causes, both fixed:
//   1. /notes/:id is a v3 family. ghlClient sends Version: 2021-07-28 for
//      every request, and a v3 path with the v1 header is rejected as 401 —
//      which reads exactly like a dead token. Same trap that halted a
//      sub-account earlier (see noteWriter.js).
//   2. No scopeOptional, so the 401 condemned the install.
//
// Asserted against the SOURCE: the failure is a missing option on a request,
// which no unit test of the exported function would notice.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../ghlAssociations.js'), 'utf8');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// Each ghlRequest call, as its own text block, so an option added to one is
// not credited to another.
const blocks = src
  .split('ghlRequest(install, {')
  .slice(1)
  .map((b) => b.slice(0, b.indexOf('\n  });')));

t('there are four relation requests to check', blocks.length === 4);

// ── Blast radius ─────────────────────────────────────────────────────
//
// The one that actually took the location down.
t('EVERY relation request is scope-optional',
  blocks.every((b) => /scopeOptional:\s*true/.test(b)));

// Named individually so a failure says which one regressed.
const find = (needle) => blocks.find((b) => b.includes(needle));
t('note relations — scope-optional',
  /scopeOptional:\s*true/.test(find('/notes/') || ''));
t('relation create (task links) — scope-optional',
  /scopeOptional:\s*true/.test(blocks.find((b) => /method:\s*'POST'/.test(b)) || ''));
t('relation deletes — scope-optional',
  blocks.filter((b) => /method:\s*'DELETE'/.test(b)).length === 2
  && blocks.filter((b) => /method:\s*'DELETE'/.test(b))
      .every((b) => /scopeOptional:\s*true/.test(b)));

// ── The version header ───────────────────────────────────────────────
t('the note relations call pins its API version',
  /headers:\s*\{\s*Version:/.test(find('/notes/') || ''));

t('and pins it to v3, not the app-wide default',
  /const NOTE_API_VERSION = 'v3'/.test(src));

t('the app-wide default is NOT v3 — this override is load-bearing',
  // If config ever changed to v3 the override would be redundant; if it
  // changed away from 2021-07-28 this comment would be stale. Either way the
  // assertion should be revisited, not silently pass.
  readFileSync(join(here, '../../config.js'), 'utf8').includes("apiVersion: '2021-07-28'"));

// ── The generic endpoint is NOT v3 ───────────────────────────────────
t('/associations/relations does NOT get the v3 header',
  // It is a 2021-07-28 endpoint. Pinning v3 here would break a path that
  // currently works — the opposite failure.
  blocks.filter((b) => b.includes('/associations/relations'))
    .every((b) => !/Version:/.test(b)));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
