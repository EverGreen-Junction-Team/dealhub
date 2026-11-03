// Errors shown to a sales rep must not be diagnostics.
//
// A note dialog displayed this, verbatim, to a rep at Veritas Glazing:
//
//   "Note saved, but couldn't link it: GHL rejected
//    /notes/p2Azywtmpwoec YENicow/relations?locationId=kHcvavc8fEeqkEPTK2T8
//    with 401 — the app is missing the scope for this endpoint"
//
// Three problems: it means nothing to the person reading it, it puts an
// endpoint path and a location id on screen, and it reads like a crash
// report in a product that is working as designed.
//
// The technical text still reaches the logs. This is about what the UI shows.

import { userMessage } from '../userMessage.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = (f) => readFileSync(join(here, '../..', f), 'utf8');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── Our own validation errors are already user-facing ────────────────
class NoteWriteError extends Error {
  constructor(m) { super(m); this.name = 'NoteWriteError'; }
}
t('a validation message we wrote is shown as-is',
  userMessage(new NoteWriteError('Colour must be a hex value like #FFAA00'), 'x')
    === 'Colour must be a hex value like #FFAA00');

// ── Everything else is replaced ──────────────────────────────────────
const scopeErr = new Error(
  'GHL rejected /notes/p2Azy/relations?locationId=kHcvavc8fEeqkEPTK2T8 with 401 — missing scope'
);
scopeErr.code = 'GHL_SCOPE_MISSING';
const shown = userMessage(scopeErr, 'It could not be linked to that deal.');

t('an upstream diagnostic is not shown', shown !== scopeErr.message);
t('no endpoint path reaches the UI', !shown.includes('/notes/'));
t('no location id reaches the UI', !shown.includes('kHcvavc8f'));
t('no HTTP status or scope talk', !/\b401\b|scope/i.test(shown));

t('a database error is replaced',
  userMessage(new Error('connect ECONNREFUSED 10.0.0.1:5432'), 'fallback') === 'fallback');
t('a programming error is replaced',
  userMessage(new TypeError('x is not a function'), 'fallback') === 'fallback');
t('null does not throw', userMessage(null, 'fallback') === 'fallback');

// ── The source of the original message ───────────────────────────────
const client = server('services/ghlClient.js');
const thrown = (client.match(/const err = new Error\(\s*'([^']+)'/) || [])[1] || '';

t('ghlClient throws a plain sentence',
  thrown.length > 0 && !thrown.includes('/') && !/401|scope/i.test(thrown));

t('and keeps the diagnostic on err.detail',
  // Lost entirely it would be harder to debug, so it moves rather than goes.
  /err\.detail = `GHL rejected/.test(client));

// ── The routes that surface it ───────────────────────────────────────
for (const f of ['routes/notes.js', 'routes/tasks.js']) {
  const src = server(f);
  if (!src.includes('relationError =')) continue;
  t(`${f} passes relationError through userMessage`,
    /relationError = userMessage\(err,/.test(src));
  t(`${f} still logs the real error`,
    /logger\.warn\(\s*\{ err,/.test(src));
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
