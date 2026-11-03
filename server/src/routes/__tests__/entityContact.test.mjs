// Notes and tasks must say WHO they are filed against.
//
// A note and a task are both stored against a CONTACT in GoHighLevel, but
// every surface that listed them named only the author (who wrote the note) or
// the assignee (which internal user owns the task). On a deal with several
// people, "call back" gave no indication of who to call.
//
// Four surfaces list them, and they must agree — a contact visible in the
// tasks tab but missing on the deal hub reads as data loss:
//
//   GET /api/tasks          -> TasksTab
//   GET /api/notes          -> NotesTab
//   GET /api/deals/:id      -> the deal-hub rails AND the merged timeline
//
// Source-parsed rather than served: booting these routers needs a database, a
// session and GHL credentials, and the question is purely which keys each
// query selects and each response object carries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, '..', f), 'utf8');
const tasks = read('tasks.js');
const notes = read('notes.js');
const deals = read('deals.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('every note/task surface names its contact');

t('GET /api/tasks sends a contact', () => {
  assert.match(tasks, /contact: t\.contact_id \? \{/);
  assert.match(tasks, /name: contactLabel\(t\)/,
    'a raw name join yields null for a nameless contact and renders an invisible chip');
});

t('GET /api/notes sends a contact', () => {
  assert.match(notes, /contact: n\.contact_id \? \{/);
  assert.match(notes, /name: contactLabel\(n\)/);
});

t('the deal route sends a contact on BOTH notes and tasks', () => {
  // These feed the deal-hub rails and the merged timeline, which had no
  // contact data at all — not even a null field to render.
  assert.match(deals, /contact: n\.contact_id \? \{[\s\S]{0,120}name: contactLabel\(n\)/,
    'the deal timeline note mapping has no contact');
  assert.match(deals, /contact: t\.contact_id \? \{[\s\S]{0,120}name: contactLabel\(t\)/,
    'the deal timeline task mapping has no contact');
});

// A label needs the columns behind it. Selecting only first/last name means
// contactLabel falls straight through to 'Unknown contact' for exactly the
// contacts this was meant to fix.
console.log('\nthe fallback columns are actually selected');

const FALLBACK = ['first_name', 'last_name', 'email', 'phone', 'company_name'];

t('tasks.js selects every identifier contactLabel reads', () => {
  for (const col of FALLBACK) {
    assert.ok(new RegExp(`c\\.${col}`).test(tasks), `tasks.js does not select c.${col}`);
  }
});

t('notes.js selects every identifier', () => {
  for (const col of FALLBACK) {
    assert.ok(new RegExp(`c\\.${col}`).test(notes), `notes.js does not select c.${col}`);
  }
});

t('deals.js joins contacts for notes AND tasks', () => {
  // Aliased nc/tc because both joins live in the same file.
  assert.match(deals, /LEFT JOIN contacts nc/, 'the notes query has no contact join');
  assert.match(deals, /LEFT JOIN contacts tc/, 'the tasks query has no contact join');
  for (const col of FALLBACK) {
    assert.ok(new RegExp(`nc\\.${col}`).test(deals), `deals.js notes query lacks nc.${col}`);
    assert.ok(new RegExp(`tc\\.${col}`).test(deals), `deals.js tasks query lacks tc.${col}`);
  }
});

t('the joins are LEFT, so a task with no contact still lists', () => {
  // An inner join would silently drop every unlinked task from the deal hub.
  assert.ok(!/\bJOIN contacts (nc|tc)\b/.test(deals.replace(/LEFT JOIN contacts/g, 'X')),
    'an inner join on contacts would hide unlinked notes/tasks');
});

t('the contact is null-guarded, not assumed', () => {
  // `contact_id ? {...} : null` — an unlinked note must send null rather than
  // an object whose name is 'Unknown contact', which would render a chip
  // implying a link that does not exist.
  for (const [src, alias, file] of [[tasks, 't', 'tasks.js'], [notes, 'n', 'notes.js']]) {
    assert.ok(new RegExp(`contact: ${alias}\\.contact_id \\?`).test(src),
      `${file} does not guard on contact_id`);
  }
});

console.log(`\n${n} passed`);
