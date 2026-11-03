// Tests for opportunityPatch.js — the mapper between our deal fields and GHL's
// opportunity endpoints. Dependency-free, like the module under test.

import {
  buildOpportunityPatch, buildStatusPatch, buildFollowerList,
  toForecastDate, toMonetaryValue, STATUSES, OpportunityWriteError
} from '../opportunityPatch.js';

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
    if (!(err instanceof OpportunityWriteError)) {
      failed++;
      console.log(`FAIL  ${name}\n        threw ${err.name}`);
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

console.log('\n--- our UI names map to GHL names ---');

// The deal card calls these value / expectedCloseDate / owner. If these ever
// stop mapping, an edit reports success and GHL never receives the field.
eq('value -> monetaryValue',
  buildOpportunityPatch({ value: 26000 }).patch, { monetaryValue: 26000 });
eq('expectedCloseDate -> forecastExpectedCloseDate',
  buildOpportunityPatch({ expectedCloseDate: '2026-04-23' }).patch,
  { forecastExpectedCloseDate: '2026-04-23' });
eq('owner -> assignedTo',
  buildOpportunityPatch({ owner: 'u1' }).patch, { assignedTo: 'u1' });
eq('GHL names pass through unchanged',
  buildOpportunityPatch({ monetaryValue: 100, assignedTo: 'u2' }).patch,
  { monetaryValue: 100, assignedTo: 'u2' });

console.log('\n--- monetaryValue accepts what a rep would type ---');

eq('a plain number', toMonetaryValue(26000), 26000);
eq('a numeric string', toMonetaryValue('26000'), 26000);
// The UI renders "£26,000"; typing it back must not fail.
eq('a formatted currency string', toMonetaryValue('£26,000'), 26000);
eq('with spaces', toMonetaryValue(' £26,000 '), 26000);
eq('dollars and euros too', toMonetaryValue('$1,500.50'), 1500.5);
eq('decimals survive', toMonetaryValue('26000.75'), 26000.75);
eq('null clears it', toMonetaryValue(null), null);
eq('empty string clears it', toMonetaryValue(''), null);

throwsWith('text is not a value', () => toMonetaryValue('a lot'), { field: 'monetaryValue' });
throwsWith('a negative deal value',
  () => toMonetaryValue(-5), { field: 'monetaryValue', match: 'negative' });
throwsWith('a negative formatted value', () => toMonetaryValue('-£5'), { field: 'monetaryValue' });
throwsWith('Infinity', () => toMonetaryValue(Infinity), { field: 'monetaryValue' });
throwsWith('an object', () => toMonetaryValue({}), { field: 'monetaryValue' });

console.log('\n--- forecast date is DATE ONLY (GHL truncates) ---');

// GHL stores YYYY-MM-DD. Sending a timestamp is accepted then truncated, so the
// echo would differ from what we sent — normalise here instead.
eq('a bare date', toForecastDate('2026-04-23'), '2026-04-23');
eq('a timestamp is truncated to the date',
  toForecastDate('2026-04-23T11:00:00Z'), '2026-04-23');
eq('a Date object', toForecastDate(new Date('2026-04-23T00:00:00Z')), '2026-04-23');
eq('null clears it', toForecastDate(null), null);
eq('empty string clears it', toForecastDate(''), null);

throwsWith('nonsense text', () => toForecastDate('next spring'),
  { field: 'forecastExpectedCloseDate' });
// JS rolls 31 February over to 3 March; a deal forecast a fortnight from the
// date typed is worse than a rejection.
throwsWith('an impossible date does not roll over',
  () => toForecastDate('2026-02-31'), { field: 'forecastExpectedCloseDate' });
throwsWith('a number is not a date', () => toForecastDate(1776945600000),
  { field: 'forecastExpectedCloseDate' });

console.log('\n--- status enum ---');

eq('the four valid statuses', STATUSES, ['open', 'won', 'lost', 'abandoned']);
eq('status is lower-cased', buildOpportunityPatch({ status: 'WON' }).patch, { status: 'won' });
// GHL's own docs list `all` for create/update; it is a SEARCH filter and is
// rejected on a write.
throwsWith('"all" is a search filter, not a status',
  () => buildOpportunityPatch({ status: 'all' }), { field: 'status' });
throwsWith('an invented status',
  () => buildOpportunityPatch({ status: 'pending' }), { field: 'status' });
throwsWith('a number is not a status',
  () => buildOpportunityPatch({ status: 1 }), { field: 'status' });

console.log('\n--- forecastProbability is 0-100 ---');

eq('a valid probability', buildOpportunityPatch({ forecastProbability: 20 }).patch,
  { forecastProbability: 20 });
eq('a numeric string', buildOpportunityPatch({ forecastProbability: '75' }).patch,
  { forecastProbability: 75 });
eq('0 is valid, not falsy-dropped',
  buildOpportunityPatch({ forecastProbability: 0 }).patch, { forecastProbability: 0 });
eq('100 is valid', buildOpportunityPatch({ forecastProbability: 100 }).patch,
  { forecastProbability: 100 });
throwsWith('over 100', () => buildOpportunityPatch({ forecastProbability: 101 }),
  { field: 'forecastProbability' });
throwsWith('negative', () => buildOpportunityPatch({ forecastProbability: -1 }),
  { field: 'forecastProbability' });

console.log('\n--- create requires name and pipeline ---');

eq('minimal create',
  buildOpportunityPatch({ name: 'Crittall roof', pipelineId: 'p1' }, { create: true }).patch,
  { name: 'Crittall roof', pipelineId: 'p1', status: 'open' });
ok('status defaults to open on create',
  buildOpportunityPatch({ name: 'x', pipelineId: 'p1' }, { create: true }).patch.status === 'open');
throwsWith('create with no name',
  () => buildOpportunityPatch({ pipelineId: 'p1' }, { create: true }),
  { field: 'name', match: 'needs a name' });
throwsWith('create with no pipeline',
  () => buildOpportunityPatch({ name: 'x' }, { create: true }),
  { field: 'pipelineId', match: 'needs a pipeline' });

console.log('\n--- update: partial bodies ---');

throwsWith('an empty update', () => buildOpportunityPatch({}), { match: 'nothing to update' });
throwsWith('clearing the name',
  () => buildOpportunityPatch({ name: '' }), { field: 'name', match: 'cannot be cleared' });
eq('one field', buildOpportunityPatch({ name: 'Renamed' }).patch, { name: 'Renamed' });
eq('undefined means not changing',
  buildOpportunityPatch({ name: 'keep', value: undefined }).patch, { name: 'keep' });

console.log('\n--- caller-owned fields are dropped, not sent ---');

// locationId is REQUIRED on create and REJECTED on update; contactId is hidden
// on update. Both come from the route, never the client — so they are dropped
// rather than 422-ing an edit made from a whole record.
eq('locationId dropped',
  buildOpportunityPatch({ name: 'x', locationId: 'l1' }).patch, { name: 'x' });
eq('contactId dropped',
  buildOpportunityPatch({ name: 'x', contactId: 'c1' }).patch, { name: 'x' });
eq('id dropped', buildOpportunityPatch({ name: 'x', id: 'o1' }).patch, { name: 'x' });
// lostReasonId has no home on the update endpoint — it only works via /status.
eq('lostReasonId dropped from a general edit',
  buildOpportunityPatch({ name: 'x', lostReasonId: 'r1' }).patch, { name: 'x' });
eq('...and reported',
  buildOpportunityPatch({ name: 'x', lostReasonId: 'r1' }).dropped, ['lostReasonId']);

console.log('\n--- unknown fields dropped, not passed through ---');

eq('unknown keys dropped',
  buildOpportunityPatch({ name: 'x', stage: 'Quote Sent', dealTag: 'z' }).patch, { name: 'x' });
// Our read model's names for things — silent data loss if they reached GHL.
eq('our `stage` name is NOT pipelineStageId',
  buildOpportunityPatch({ name: 'x', stage: 'Quote Sent' }).dropped, ['stage']);
eq('our `pipeline` name is NOT pipelineId',
  buildOpportunityPatch({ name: 'x', pipeline: 'Sales' }).dropped, ['pipeline']);

console.log('\n--- status patch: the ONLY route that records a lost reason ---');

eq('a plain status', buildStatusPatch({ status: 'won' }), { status: 'won' });
eq('lost with a reason',
  buildStatusPatch({ status: 'lost', lostReasonId: 'r1' }),
  { status: 'lost', lostReasonId: 'r1' });
eq('lost without a reason is fine', buildStatusPatch({ status: 'lost' }), { status: 'lost' });
eq('an empty reason is omitted, not sent as ""',
  buildStatusPatch({ status: 'lost', lostReasonId: '' }), { status: 'lost' });

// A reason on a won deal is meaningless and GHL ignores it — refuse rather than
// let the caller believe it was recorded.
throwsWith('a reason on a WON deal',
  () => buildStatusPatch({ status: 'won', lostReasonId: 'r1' }),
  { field: 'lostReasonId', match: 'marked lost' });
throwsWith('a reason on an OPEN deal',
  () => buildStatusPatch({ status: 'open', lostReasonId: 'r1' }),
  { field: 'lostReasonId' });
throwsWith('no status at all', () => buildStatusPatch({}), { field: 'status' });
throwsWith('an invalid status', () => buildStatusPatch({ status: 'nope' }), { field: 'status' });

console.log('\n--- followers: max 10, deduped ---');

eq('one follower', buildFollowerList({ followers: ['u1'] }), ['u1']);
eq('a plain array works too', buildFollowerList(['u1', 'u2']), ['u1', 'u2']);
eq('duplicates collapse', buildFollowerList({ followers: ['u1', 'u1'] }), ['u1']);
eq('trimmed', buildFollowerList({ followers: [' u1 '] }), ['u1']);
ok('ten is allowed',
  buildFollowerList({ followers: Array.from({ length: 10 }, (_, i) => `u${i}`) }).length === 10);
throwsWith('eleven is not',
  () => buildFollowerList({ followers: Array.from({ length: 11 }, (_, i) => `u${i}`) }),
  { field: 'followers', match: '10' });
throwsWith('an empty list', () => buildFollowerList({ followers: [] }), { field: 'followers' });
throwsWith('a blank id', () => buildFollowerList({ followers: ['u1', '  '] }),
  { field: 'followers' });
throwsWith('a non-string id', () => buildFollowerList({ followers: [7] }), { field: 'followers' });
throwsWith('the verb reaches the message',
  () => buildFollowerList({ followers: [] }, { verb: 'remove' }), { match: 'remove' });

console.log('\n--- the primary contact (opt-in) ---');

// contactId is @HideApiProperty on GHL's PUT /opportunities/:id: absent from
// the marketplace docs, but the service still applies it —
//
//     if (body.contactId) opportunity.contactId = body.contactId
//
// having validated the contact exists and is not deleted. On CREATE it is
// required and fully documented.
//
// It is OPT-IN on update because reassigning a deal changes which contact GHL
// files future notes and tasks against, and the deal editor PATCHes whole
// records. Without a gate, any edit carrying a stale contactId would silently
// move the deal to a different person.

ok('an ordinary update DROPS contactId',
  (() => {
    const { patch, dropped } = buildOpportunityPatch({ name: 'Renamed', contactId: 'someoneElse' });
    return patch.contactId === undefined && dropped.includes('contactId') && patch.name === 'Renamed';
  })(),
  'a whole-record PATCH must not be able to reassign the deal');

eq('opting in keeps it',
  buildOpportunityPatch({ contactId: 'abc123' }, { allowPrimaryContact: true }).patch,
  { contactId: 'abc123' });

ok('CREATE keeps it with no opt-in needed',
  buildOpportunityPatch(
    { name: 'New deal', pipelineId: 'p1', contactId: 'abc123' }, { create: true }
  ).patch.contactId === 'abc123',
  'contactId is required and documented on POST');

eq('it is trimmed',
  buildOpportunityPatch({ contactId: '  abc123  ' }, { allowPrimaryContact: true }).patch.contactId,
  'abc123');

// An opportunity with no contact cannot hold notes or tasks, and GHL rejects
// the write anyway — a clear local message beats their 400.
throwsWith('a blank contactId is refused',
  () => buildOpportunityPatch({ contactId: '   ' }, { allowPrimaryContact: true }),
  { field: 'contactId', match: 'must have a contact' });

throwsWith('null is refused too',
  () => buildOpportunityPatch({ contactId: null }, { allowPrimaryContact: true }),
  { field: 'contactId' });

ok('undefined is a no-op, not an error',
  (() => {
    // What a form sends for "unchanged".
    const { patch } = buildOpportunityPatch(
      { name: 'x', contactId: undefined }, { allowPrimaryContact: true });
    return !('contactId' in patch) && patch.name === 'x';
  })(),
  'an unchanged field must not throw');


console.log('\n--- custom fields: opportunities use camelCase ---');

// THE SPELLING DIFFERS BY OBJECT:
//   contacts      -> field_value  (snake)
//   opportunities -> fieldValue   (camel)
//
// GHL accepts the wrong one on the request and then silently ignores it, so
// the rep sees a successful save and an unchanged field. This file previously
// passed the array through unreshaped with a comment naming the SNAKE
// spelling, so whichever a caller used went straight to the wire.

eq('camelCase is what reaches the wire',
  buildOpportunityPatch({ customFields: [{ id: 'f1', fieldValue: 'Cortizo' }] }).patch.customFields,
  [{ id: 'f1', fieldValue: 'Cortizo' }]);

eq('a caller sending snake_case is CONVERTED, not passed through',
  buildOpportunityPatch({ customFields: [{ id: 'f1', field_value: 'Cortizo' }] }).patch.customFields,
  [{ id: 'f1', fieldValue: 'Cortizo' }]);

eq('a key may be used instead of an id',
  buildOpportunityPatch({ customFields: [{ key: 'opportunity.client_type', fieldValue: 'x' }] }).patch.customFields,
  [{ key: 'opportunity.client_type', fieldValue: 'x' }]);

eq('a cleared field sends an empty string, not a dropped key',
  buildOpportunityPatch({ customFields: [{ id: 'f1', fieldValue: null }] }).patch.customFields,
  [{ id: 'f1', fieldValue: '' }]);

eq('several fields keep their order',
  buildOpportunityPatch({ customFields: [
    { id: 'a', fieldValue: '1' }, { id: 'b', fieldValue: '2' }
  ] }).patch.customFields.map((f) => f.id).join(','),
  'a,b');

ok('a numeric value survives',
  buildOpportunityPatch({ customFields: [{ id: 'f1', fieldValue: 42 }] })
    .patch.customFields[0].fieldValue === 42);

ok('an id is trimmed',
  buildOpportunityPatch({ customFields: [{ id: '  f1  ', fieldValue: 'x' }] })
    .patch.customFields[0].id === 'f1');

throwsWith('a non-array is refused',
  () => buildOpportunityPatch({ customFields: { id: 'f1' } }),
  { field: 'customFields', match: 'must be a list' });

throwsWith('a field with neither id nor key is refused',
  () => buildOpportunityPatch({ customFields: [{ fieldValue: 'x' }] }),
  { field: 'customFields', match: 'no id' });

throwsWith('a non-object entry is refused',
  () => buildOpportunityPatch({ customFields: ['f1'] }),
  { field: 'customFields', match: 'not valid' });


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
