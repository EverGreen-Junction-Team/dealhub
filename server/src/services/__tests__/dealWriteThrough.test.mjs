// A deal change we made is in our own database before the request answers.
//
// Reported as "deals page changes are not reflecting immediately", with a
// screen recording of a deal dragged on the board vanishing until a reload.
// Every deal write went to GHL and our copy waited for GHL's webhook; the
// dashboard guessed at that delay with 2.5 s timers and was wrong whenever the
// webhook was slower. Now the write routes run the webhook's own handler
// straight after GHL accepts the change (services/dealWriteThrough.js), and the
// webhook, when it lands, re-checks against GHL as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// db.js reads this at import time; nothing here connects.
process.env.DATABASE_URL ||= 'postgres://test@127.0.0.1:1/none';
const { mirrorOpportunity, mirrorOpportunityDeleted } = await import('../dealWriteThrough.js');

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', '..', 'routes', 'deals.js'), 'utf8');
const writer = readFileSync(join(here, '..', 'stageHistoryWriter.js'), 'utf8');
const install = { location_id: 'LOC1' };

test('runs the webhook handler with a minimal event, flagged as a write-through', async () => {
  const calls = [];
  const ok = await mirrorOpportunity(install, 'OPP1', {
    eventType: 'OpportunityStageUpdate',
    contactId: 'C1',
    handler: async (...args) => { calls.push(args); return true; }
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const [inst, type, event, opts] = calls[0];
  assert.equal(inst, install);
  assert.equal(type, 'OpportunityStageUpdate');
  // The handler drops an event without a contact, and fetches by these ids.
  assert.equal(event.opportunityId, 'OPP1');
  assert.equal(event.contactId, 'C1');
  assert.equal(event.locationId, 'LOC1');
  assert.ok(!Number.isNaN(new Date(event.timestamp).getTime()), 'a real timestamp, so the stage row is dated now');
  assert.deepEqual(opts, { writeThrough: true });
});

test('a dropped event is reported as not mirrored', async () => {
  const ok = await mirrorOpportunity(install, 'OPP1', { contactId: 'C1', handler: async () => false });
  assert.equal(ok, false);
});

test('a failure never fails the save — GHL already has the change', async () => {
  const ok = await mirrorOpportunity(install, 'OPP1', {
    contactId: 'C1',
    handler: async () => { throw new Error('GHL read-back 502'); }
  });
  assert.equal(ok, false);
});

test('a slow read-back answers on time and finishes in the background', async () => {
  let finished = false;
  const started = Date.now();
  const ok = await mirrorOpportunity(install, 'OPP1', {
    contactId: 'C1',
    timeoutMs: 50,
    handler: () => new Promise((r) => setTimeout(() => { finished = true; r(true); }, 200))
  });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 180, 'the request must not wait for the slow handler');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(finished, true, 'the write still completes');
});

test('missing ids do nothing', async () => {
  let called = false;
  const handler = async () => { called = true; return true; };
  assert.equal(await mirrorOpportunity({}, 'OPP1', { handler }), false);
  assert.equal(await mirrorOpportunity(install, '', { handler }), false);
  assert.equal(called, false);
});

test('a delete is marked at once, and a failure is not an error', async () => {
  const seen = [];
  assert.equal(await mirrorOpportunityDeleted(install, 'OPP9', { mark: async (l, o) => { seen.push([l, o]); return true; } }), true);
  assert.deepEqual(seen, [['LOC1', 'OPP9']]);
  assert.equal(await mirrorOpportunityDeleted(install, 'OPP9', { mark: async () => { throw new Error('db down'); } }), false);
});

test('every deal write route mirrors, and says so', () => {
  const route = (start) => routes.slice(routes.indexOf(start), routes.indexOf('\n});', routes.indexOf(start)));
  const patch = route("dealsRouter.patch('/:id'");
  assert.match(patch, /mirrorOpportunity\(install, opportunityId/);
  assert.match(patch, /OpportunityStageUpdate/);
  assert.match(patch, /contactId: deal\.contact_id/);
  assert.match(patch, /mirrored \}\)/);
  // The clear goes on top of the read-back, never under it.
  assert.ok(patch.indexOf('mirrorOpportunity(') < patch.indexOf('applyClearedCustomFields('));

  const status = route("dealsRouter.put('/:id/status'");
  assert.match(status, /eventType: 'OpportunityStatusUpdate'/);
  assert.match(status, /mirrored,/);
  // After the reason, so GHL's copy includes it.
  assert.ok(status.lastIndexOf('updateGhlOpportunity(') < status.indexOf('mirrorOpportunity('));

  const create = route("dealsRouter.post('/', async");
  assert.match(create, /eventType: 'OpportunityCreate'/);
  assert.match(create, /mirrored \}\)/);

  const del = route("dealsRouter.delete('/:id', async");
  assert.match(del, /mirrorOpportunityDeleted\(install, opportunityId\)/);

  // The handler needs the deal's contact.
  assert.match(routes, /SELECT opportunity_id, name, pipeline_id, status, contact_id/);
});

test('the handler skips only the association refresh on a write-through', () => {
  assert.match(writer, /export async function handleOpportunityEvent\(install, eventType, event, \{ writeThrough = false \} = \{\}\)/);
  assert.match(writer, /if \(!writeThrough\) await refreshAssociationsForOpportunity/);
  // and reports whether it wrote, so `mirrored` is honest
  assert.match(writer, /missing contactId — dropping'\);\n    return false;/);
});

test('a delete closes the open stage row too, as the webhook does', () => {
  const fn = writer.slice(writer.indexOf('export async function markOpportunityDeleted'), writer.indexOf('// Used by the orphan-sweep cron'));
  assert.match(fn, /is_deleted = true/);
  assert.match(fn, /closeStageRow\(client, open\.id, at, \{ markDeleted: true \}\)/);
  assert.match(fn, /pg_advisory_xact_lock/);
});
