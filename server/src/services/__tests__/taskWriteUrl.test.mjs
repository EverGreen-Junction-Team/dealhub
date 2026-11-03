// Which endpoint a task write goes to.
//
// GHL has TWO task surfaces:
//
//   /contacts/:contactId/tasks/:taskId      needs a contact
//   /locations/:locationId/tasks/:taskId    needs none
//
// Every write here used the first, so a task created by a workflow, an import,
// or directly in the GHL UI — none of which attach a contact — could be
// listed but never edited, completed or deleted. The route 400'd with "This
// task isn't linked to a contact, so it can't be changed here", and there was
// no "here" that could change it.
//
// Source-parsed: ghlTaskWrite reaches the network and the database, and the
// question is purely which URL is built.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svc = readFileSync(join(here, '..', 'ghlTaskWrite.js'), 'utf8');
const route = readFileSync(join(here, '..', '..', 'routes', 'tasks.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// The rule, mirrored from the three call sites.
const urlFor = ({ contactId, locationId, taskId, completed = false }) => {
  if (contactId) {
    return completed
      ? `/contacts/${contactId}/tasks/${taskId}/completed`
      : `/contacts/${contactId}/tasks/${taskId}`;
  }
  // The location path has no /completed sub-resource: completion there is an
  // ordinary update with { completed } in the body.
  return `/locations/${locationId}/tasks/${taskId}`;
};

console.log('endpoint selection');

t('a task WITH a contact keeps the contact path', () => {
  // Unchanged on purpose: every task in this app has been written through it,
  // and switching wholesale would risk a regression for no gain.
  assert.equal(
    urlFor({ contactId: 'c1', locationId: 'loc1', taskId: 't1' }),
    '/contacts/c1/tasks/t1'
  );
});

t('a task WITHOUT a contact uses the location path', () => {
  assert.equal(
    urlFor({ contactId: null, locationId: 'fJNuIdxGgchGpJ9OoBbk', taskId: 'pK7rihziXGGNu7fVZA50' }),
    '/locations/fJNuIdxGgchGpJ9OoBbk/tasks/pK7rihziXGGNu7fVZA50'
  );
});

t('completion uses /completed only on the contact path', () => {
  assert.equal(
    urlFor({ contactId: 'c1', locationId: 'loc1', taskId: 't1', completed: true }),
    '/contacts/c1/tasks/t1/completed'
  );
  // The location path has no such sub-resource — a { completed } body instead.
  assert.equal(
    urlFor({ contactId: null, locationId: 'loc1', taskId: 't1', completed: true }),
    '/locations/loc1/tasks/t1'
  );
});

t('an empty-string contactId is treated as absent', () => {
  // A left join can hand back '' as easily as null.
  assert.equal(
    urlFor({ contactId: '', locationId: 'loc1', taskId: 't1' }),
    '/locations/loc1/tasks/t1'
  );
});

console.log('\nthe source implements it');

t('all three verbs branch on contactId', () => {
  // update, complete, delete. Create is excluded: a task cannot be created
  // without a contact, so its guard stays.
  const branches = svc.match(/contactId\s*\n?\s*\? `\/contacts\//g) || [];
  assert.ok(branches.length >= 3,
    `expected update, complete and delete to branch; found ${branches.length}`);
  assert.match(svc, /function locationTaskUrl\(install, taskId/);
});

t('CREATE still requires a contact', () => {
  // GHL has no way to create a task with no owner, so this guard is correct.
  assert.match(svc, /export async function createGhlTask[\s\S]{0,120}requireContactId\(contactId\)/);
});

t('the route no longer rejects a contactless task', () => {
  assert.ok(!/tasks are edited through the contact they belong to/.test(route),
    'the 400 that made contactless tasks uneditable is back');
});

t('a 401 on the location path names the likely missing scope', () => {
  // The contact path uses contacts.write, so every other task write keeps
  // working and a missing locations/tasks.write looks like a dead token.
  assert.match(svc, /locations\/tasks\.write/);
  assert.match(svc, /function noteLocationScope/);
});

console.log(`\n${n} passed`);
