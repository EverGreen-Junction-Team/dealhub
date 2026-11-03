// Tests for notePatch.js — the mapper between our note fields and GHL's
// create/update note endpoints. Dependency-free, like the module under test.

import { buildNotePatch, NoteWriteError } from '../notePatch.js';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n        got  ${g}\n        want ${w}`); }
};

const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

function throwsWith(name, fn, { field = undefined, match = undefined } = {}) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${name}\n        expected a throw, got none`);
  } catch (err) {
    if (!(err instanceof NoteWriteError)) {
      failed++;
      console.log(`FAIL  ${name}\n        threw ${err.name}, not NoteWriteError`);
      return;
    }
    if (field !== undefined && err.field !== field) {
      failed++;
      console.log(`FAIL  ${name}\n        field ${err.field}, expected ${field}`);
      return;
    }
    if (match && !err.message.toLowerCase().includes(match.toLowerCase())) {
      failed++;
      console.log(`FAIL  ${name}\n        "${err.message}" lacks "${match}"`);
      return;
    }
    passed++;
    console.log(`  ok  ${name}`);
  }
}

console.log('\n--- create: body is the only required field ---');

eq('minimal create', buildNotePatch({ body: 'Rang, no answer' }, { create: true }).patch,
  { body: 'Rang, no answer' });

throwsWith('create with no body',
  () => buildNotePatch({ title: 'Just a title' }, { create: true }),
  { field: 'body', match: 'needs something written' });

throwsWith('create with a whitespace-only body',
  () => buildNotePatch({ body: '   ' }, { create: true }), { field: 'body' });

eq('every field at once',
  buildNotePatch({
    body: 'lorem ipsum', title: 'Follow-up summary',
    color: '#FFAA00', pinned: false, userId: 'GCs5KuzPqTls7vWclkEV'
  }, { create: true }).patch,
  {
    body: 'lorem ipsum', title: 'Follow-up summary',
    color: '#FFAA00', pinned: false, userId: 'GCs5KuzPqTls7vWclkEV'
  });

console.log('\n--- update: partial bodies ---');

eq('pinned only', buildNotePatch({ pinned: true }).patch, { pinned: true });
eq('body only', buildNotePatch({ body: 'revised' }).patch, { body: 'revised' });
eq('text is trimmed', buildNotePatch({ body: '  spaced  ' }).patch, { body: 'spaced' });
eq('title can be cleared', buildNotePatch({ title: '' }).patch, { title: '' });
eq('colour can be cleared with null', buildNotePatch({ color: null }).patch, { color: null });
eq('colour can be cleared with an empty string',
  buildNotePatch({ color: '' }).patch, { color: null });
eq('undefined means "not changing"',
  buildNotePatch({ body: 'keep', title: undefined }).patch, { body: 'keep' });

throwsWith('an empty update', () => buildNotePatch({}), { match: 'nothing to update' });

// Emptying the body would leave a blank row in the timeline. Deleting is the
// honest action and there's an endpoint for it.
throwsWith('emptying the body on an edit',
  () => buildNotePatch({ body: '' }),
  { field: 'body', match: 'delete it instead' });

console.log('\n--- colour must be a hex GHL accepts ---');

eq('6-digit hex', buildNotePatch({ color: '#FFAA00' }).patch.color, '#FFAA00');
eq('3-digit hex', buildNotePatch({ color: '#FFF' }).patch.color, '#FFF');
// Same colour picked twice must not store as two different strings, or an
// unchanged field reads as an edit.
eq('lowercase hex is normalised up',
  buildNotePatch({ color: '#ffaa00' }).patch.color, '#FFAA00');
eq('surrounding space is trimmed',
  buildNotePatch({ color: '  #ffaa00 ' }).patch.color, '#FFAA00');

throwsWith('a missing hash', () => buildNotePatch({ color: 'FFAA00' }), { field: 'color' });
throwsWith('a named colour', () => buildNotePatch({ color: 'orange' }), { field: 'color' });
throwsWith('rgb()', () => buildNotePatch({ color: 'rgb(255,170,0)' }), { field: 'color' });
throwsWith('8-digit hex with alpha',
  () => buildNotePatch({ color: '#FFAA00FF' }), { field: 'color' });
throwsWith('4 digits is neither form',
  () => buildNotePatch({ color: '#FFAA' }), { field: 'color' });
throwsWith('a number is not a colour',
  () => buildNotePatch({ color: 16755200 }), { field: 'color' });

console.log('\n--- unknown fields are dropped, not passed through ---');

// An unknown key makes GHL reject the WHOLE request, so a typo must not travel
// alongside the valid fields.
eq('unknown keys dropped',
  buildNotePatch({ body: 'x', id: 'n1', dealId: 'd1', status: 'active' }).patch,
  { body: 'x' });
eq('...and reported for logging',
  buildNotePatch({ body: 'x', id: 'n1', dealId: 'd1' }).dropped.sort(),
  ['dealId', 'id']);

// Our own field names for things GHL calls something else — silent data loss if
// they ever reached the patch unmapped.
eq('our `author` is not GHL userId',
  buildNotePatch({ body: 'x', author: 'Ollie' }).dropped, ['author']);
eq('our `authorUserId` is not GHL userId',
  buildNotePatch({ body: 'x', authorUserId: 'u1' }).dropped, ['authorUserId']);
eq('`noteChips` never travels',
  buildNotePatch({ body: 'x', noteChips: [] }).dropped, ['noteChips']);

console.log('\n--- type validation ---');

throwsWith('pinned must be boolean, not "true"',
  () => buildNotePatch({ pinned: 'true' }), { field: 'pinned' });
throwsWith('pinned must be boolean, not 1',
  () => buildNotePatch({ pinned: 1 }), { field: 'pinned' });
throwsWith('body must be text', () => buildNotePatch({ body: 42 }), { field: 'body' });
throwsWith('title must be text', () => buildNotePatch({ title: {} }), { field: 'title' });
throwsWith('userId must be a string id',
  () => buildNotePatch({ userId: { id: 'u1' } }), { field: 'userId' });
throwsWith('a non-object body', () => buildNotePatch('body=x'), { match: 'nothing to save' });
throwsWith('an array is not a field set', () => buildNotePatch(['x']), { match: 'nothing to save' });

console.log('\n--- length limits (GHL: body 65000, title 255) ---');

ok('a body at the limit is accepted',
  buildNotePatch({ body: 'a'.repeat(65000) }).patch.body.length === 65000);
throwsWith('an over-long body is rejected, not truncated',
  () => buildNotePatch({ body: 'a'.repeat(65001) }), { field: 'body', match: '65000' });

ok('a title at the limit is accepted',
  buildNotePatch({ title: 'a'.repeat(255) }).patch.title.length === 255);
throwsWith('an over-long title is rejected',
  () => buildNotePatch({ title: 'a'.repeat(256) }), { field: 'title', match: '255' });

// ── THE LOCAL MIRROR ─────────────────────────────────────────────────
// A note PATCH went to GHL and returned GHL's copy — our own notes row was
// never written. NoteUpdate fires, but it takes a moment, and until it lands
// every read returns the OLD row.
//
// The visible bug was an off-by-one on the title: rename to "test1" and the
// row showed it (the editor passes what it applied), but REOPENING read the
// note back from our table and the box held the previous name. Rename to
// "test2" and the rep saw "test1". Every edit appeared one behind.
{
  const writer = readFileSync(
    new URL('../ghlNoteWrite.js', import.meta.url), 'utf8'
  );
  const update = writer.slice(
    writer.indexOf('export async function updateGhlNote'),
    writer.indexOf('export async function deleteGhlNote')
  );

  ok('a note update writes our own row too', /UPDATE notes SET/.test(update));
  ok('it is scoped to the tenant and the note',
    /location_id = \$1 AND note_id = \$2/.test(update));
  ok('it skips a row already deleted', /deleted_at IS NULL/.test(update));

  // ONLY the columns the patch set. A title-only edit that wrote every column
  // would blank the body — a far worse bug than the one being fixed.
  ok('only the patched columns are written', /if \(key in patch\)/.test(update));

  // updated_at is what the sync and the webhook use to decide what is stale.
  // Claiming a write time for a row the webhook has not confirmed would hide
  // its own correction.
  ok('updated_at is left for the webhook', !/updated_at\s*=\s*now\(\)/.test(update));

  // GHL has already accepted the change. A local mirror that fails must not
  // report the save as failed.
  ok('a local failure does not fail the save',
    /updated in GHL but the local row did not follow/.test(update));

  // The SET clause itself, built the same way.
  const build = (patch) => {
    const sets = []; const vals = ['LOC', 'N1'];
    for (const [col, key] of [['body', 'body'], ['title', 'title'], ['color', 'color'], ['pinned', 'pinned']]) {
      if (key in patch) { vals.push(patch[key]); sets.push(`${col} = $${vals.length}`); }
    }
    return { sets, vals };
  };
  ok('a title-only patch touches only title',
    build({ title: 'test2' }).sets.join() === 'title = $3');
  ok('a title-only patch does not carry the body',
    build({ title: 'test2' }).vals.length === 3);
  ok('a full patch numbers every placeholder in order',
    build({ title: 't', body: 'b', color: 'red', pinned: true }).sets.join(', ')
      === 'body = $3, title = $4, color = $5, pinned = $6');
  ok('a patch with no local columns writes nothing',
    build({ businessId: 'x' }).sets.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
