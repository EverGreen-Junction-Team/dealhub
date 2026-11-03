// The From/To addresses on an expanded email in the deal timeline.
//
// WHY THIS IS TESTED AT ALL, given it renders two grey lines: because the
// field names are a GUESS. `messages` has no from/to columns — migration 031
// promoted thread_id, subject and reply_to_message_id off the email payload
// and deliberately left addresses in raw_message — and nothing in this
// codebase records what GHL names them there. Every other "the UI reads a
// field the API doesn't send" bug in this repo started exactly here.
//
// So the contract under test is not "it finds the address". It is: WHEN THE
// GUESS IS WRONG, THE RESULT IS null — never undefined, never a crash, never
// a rendered "[object Object]". The timeline must show the email regardless;
// the addresses are a nicety on top of it.
//
// Source-parsed rather than imported, matching dealShapeParity in this folder:
// deals.js pulls in db and config, which throw without DATABASE_URL, and the
// question here is purely about one pure function.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'deals.js'), 'utf8');

// Lift the function out of the module. Locating it by name also asserts it
// still EXISTS — a rename or deletion fails here rather than silently
// dropping the addresses from every email in production.
const start = src.indexOf('function emailAddr(raw, kind) {');
assert.notEqual(start, -1, 'emailAddr is gone from deals.js — the timeline From/To block reads null for every email');

// Brace-match to the end of the function. Counting rather than regexing
// because a regex for a balanced body is how an 85-line orphan got left
// behind in this codebase once already.
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
assert.notEqual(end, -1, 'could not brace-match emailAddr');

const emailAddr = new Function(`${src.slice(start, end)}; return emailAddr;`)();

let n = 0;
const t = (name, got, want) => {
  assert.deepEqual(got, want, `${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  n++; console.log('  ok  ' + name);
};

console.log('emailAddr — reads an address, or cleanly reads nothing');

// ── The shapes GHL plausibly sends ──────────────────────────────────────
t('bare from',         emailAddr({ from: 'a@b.com' }, 'from'), 'a@b.com');
t('prefixed emailTo',  emailAddr({ emailTo: 'c@d.com' }, 'to'), 'c@d.com');
t('fromAddress',       emailAddr({ fromAddress: 'e@f.com' }, 'from'), 'e@f.com');
t('toEmail',           emailAddr({ toEmail: 'g@h.com' }, 'to'), 'g@h.com');
t('object form',       emailAddr({ from: { email: 'i@j.com', name: 'I' } }, 'from'), 'i@j.com');
t('whitespace trimmed', emailAddr({ from: '  k@l.com  ' }, 'from'), 'k@l.com');

// Multiple recipients. Showing only the first would answer "who did we email"
// wrongly on exactly the deals where the question matters.
t('array of strings',  emailAddr({ to: ['x@y.com', 'z@y.com'] }, 'to'), 'x@y.com, z@y.com');
t('array of objects',  emailAddr({ to: [{ email: 'x@y.com', name: 'X' }, { address: 'z@y.com' }] }, 'to'), 'x@y.com, z@y.com');
t('array, one usable', emailAddr({ to: ['x@y.com', null] }, 'to'), 'x@y.com');

// ── The guess being wrong must yield null, not junk ─────────────────────
t('unknown field names', emailAddr({ sender: 'a@b.com', recipient: 'c@d.com' }, 'from'), null);
t('missing key',       emailAddr({ subject: 'hi' }, 'from'), null);
t('null raw',          emailAddr(null, 'from'), null);
t('undefined raw',     emailAddr(undefined, 'to'), null);
t('string raw',        emailAddr('not an object', 'from'), null);
t('empty string',      emailAddr({ from: '   ' }, 'from'), null);
t('empty array',       emailAddr({ to: [] }, 'to'), null);
t('array of junk',     emailAddr({ to: [null, 42, {}] }, 'to'), null);
t('number value',      emailAddr({ from: 42 }, 'from'), null);
t('object without email', emailAddr({ from: { name: 'No Address' } }, 'from'), null);

// from and to must not bleed into each other: attributing an outbound email
// to the recipient would be worse than showing nothing.
t('to does not read from', emailAddr({ from: 'a@b.com' }, 'to'), null);
t('from does not read to', emailAddr({ to: 'a@b.com' }, 'from'), null);

// Never a bare `undefined`: React renders it as nothing, but it would reach
// JSON.stringify as a DROPPED KEY, and the dashboard's `m.emailFrom &&` guard
// is the only thing between that and a blank labelled row.
for (const raw of [null, {}, { from: '' }, { to: [] }, 'str', 42]) {
  assert.strictEqual(emailAddr(raw, 'from') === undefined, false,
    `emailAddr returned undefined for ${JSON.stringify(raw)} — must be null`);
}
n++; console.log('  ok  never returns undefined, always null');

console.log(`\n${n} passed`);
