// Custom fields in the deal edit panel.
//
// The deal HUB has shown Client Type / Product System / Product Type as chips
// for a while. The EDITOR showed none, so changing one meant leaving the
// panel — and the text fields ("Multi line Opportunity", "Last activity") had
// no home at all: /custom-field-options filtered on `options IS NOT NULL`,
// which excluded every non-picklist.
//
// THE SPELLING TRAP. Contacts take field_value (snake), opportunities take
// fieldValue (camel). GHL accepts the wrong one on the request and then
// silently ignores it — a successful save and an unchanged field.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, '..', 'DealEditPanel.jsx'), 'utf8');
const route = readFileSync(
  join(here, '..', '..', '..', '..', '..', 'pipelinePulse', 'server',
    'src', 'routes', 'deals.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Value resolution, mirrored from the panel.
const valueFor = (customFields, f) =>
  customFields?.[f.id] ?? customFields?.[f.key] ?? customFields?.[f.shortKey] ?? null;

console.log("finding a field's current value");

t('by field id', () => {
  assert.equal(valueFor({ abc: 'Cortizo' }, { id: 'abc' }), 'Cortizo');
});

t('by the full key when the id is not the blob key', () => {
  assert.equal(
    valueFor({ 'opportunity.client_type': 'Architect' },
      { id: 'abc', key: 'opportunity.client_type' }),
    'Architect');
});

t('by the short key the deal response uses', () => {
  assert.equal(
    valueFor({ clientType: 'Homeowner' },
      { id: 'abc', key: 'opportunity.client_type', shortKey: 'clientType' }),
    'Homeowner');
});

t('an unset field is null, not undefined', () => {
  assert.equal(valueFor({}, { id: 'abc' }), null);
  assert.equal(valueFor(undefined, { id: 'abc' }), null);
});

t('a false or 0 value survives', () => {
  // ?? not ||: a checkbox answered "no" is an answer.
  assert.equal(valueFor({ abc: false }, { id: 'abc' }), false);
  assert.equal(valueFor({ abc: 0 }, { id: 'abc' }), 0);
});

console.log('\nwhat is sent on save');

t('the panel sends fieldValue in CAMEL case', () => {
  assert.match(panel, /fieldValue: Array\.isArray\(v\) \? v\.join\(','\) : \(v \?\? ''\)/,
    'opportunities use fieldValue; field_value is silently ignored');
});

t('a multi-select is joined, not sent as an array', () => {
  assert.match(panel, /Array\.isArray\(v\) \? v\.join\(','\)/);
});

t('custom fields are a SEPARATE call from the field patch', () => {
  // Merging them would mean a rejected custom field also loses a perfectly
  // good name change.
  assert.match(panel, /if \(Object\.keys\(cfDraft\)\.length > 0\)/);
});

t('they count towards the unsaved-changes total', () => {
  // Otherwise Save stays disabled after editing only a custom field.
  assert.match(panel, /Object\.keys\(cfDraft\)\.length/);
});

t('Discard clears them too', () => {
  assert.match(panel, /setCfDraft\(\{\}\)/);
});

console.log('\nthe server sends what the editor needs');

t('every active field, not only the picklists', () => {
  assert.ok(!/AND options IS NOT NULL/.test(route),
    'the picklist-only filter is back — text fields would vanish from the editor');
  assert.match(route, /AND d\.is_active = true/);
});

t('grouped into folders, with the flat picklist shape kept', () => {
  // The deal card's chips still read `fields`; breaking that to add the
  // editor would be a regression.
  assert.match(route, /fields: byField/);
  assert.match(route, /fieldGroups,/);
});

t('the deal carries its custom field values', () => {
  // Four promoted columns are not enough, and promoting one per field would
  // mean a migration per client request.
  //
  // The blob now goes through withPromotedFields, which fills any gap from
  // the promoted COLUMN — the editor rendered "Not set" over values the card
  // above it was already showing, because the two are separate copies and the
  // blob is only as fresh as the last event that landed. The guard against a
  // non-object blob moved into that helper.
  assert.match(route, /customFields: withPromotedFields\(d\.custom_fields, d\)/);
  assert.match(route, /blob && typeof blob === 'object' \? blob : \{\}/);
});

t('FILE_UPLOAD is flagged UPLOADABLE, not read-only', () => {
  // The server said readOnly on the claim that GHL has no upload API for
  // custom fields. It does — that claim was about EMAIL attachments.
  assert.match(route, /upload: \/FILE_UPLOAD\/i\.test/);
  assert.ok(!/readOnly: \/FILE_UPLOAD\/i\.test/.test(route),
    'the wrong read-only flag is back');
});

// ── Follow-up counts ────────────────────────────────────────────────────
//
// The DETAIL route has carried task and note counts for the nav pills. The
// LIST route did not — and the edit panel renders from a list row, so it
// could not say whether a deal had any follow-up on it at all.
console.log('\nfollow-up counts');

t('the list route counts open tasks and live notes', () => {
  assert.match(route, /AS open_task_count/);
  assert.match(route, /AS note_count/);
  assert.match(route, /openTaskCount: Number\(d\.open_task_count \|\| 0\)/);
  assert.match(route, /noteCount: Number\(d\.note_count \|\| 0\)/);
});

t('COMPLETED and soft-deleted tasks are excluded', () => {
  // "3 open tasks" must mean three things still to do. Verified against a
  // real Postgres: 3 rows in, 1 counted.
  assert.match(route, /t\.status <> 'completed'/);
  assert.match(route, /t\.deleted_at IS NULL/);
});

t('only ACTIVE notes count', () => {
  assert.match(route, /n\.status = 'active'/);
});

t('correlated subqueries, not joins', () => {
  // A join would multiply the row and force a GROUP BY over every column
  // already selected.
  assert.match(route, /\(SELECT COUNT\(\*\)::int FROM tasks t\s*\n\s*WHERE t\.location_id/);
});

t('the panel shows the line only when there IS follow-up', () => {
  // "0 open tasks" on every deal is noise.
  assert.match(panel, /deal\.openTaskCount > 0 \|\| deal\.noteCount > 0/);
});

t('the counts are singular or plural correctly', () => {
  assert.match(panel, /deal\.openTaskCount === 1 \? '' : 's'/);
  assert.match(panel, /deal\.noteCount === 1 \? '' : 's'/);
});

// ── Follow-up on the CARD, not behind Edit ──────────────────────────────
console.log('\nfollow-up chips on the cards');

const chips = readFileSync(
  join(here, '..', '..', 'shared', 'ListChrome.jsx'), 'utf8');
const dealsTab = readFileSync(
  join(here, '..', '..', 'tabs', 'DealsTab.jsx'), 'utf8');
const contactsTab = readFileSync(
  join(here, '..', '..', 'tabs', 'ContactsTab.jsx'), 'utf8');
const contactsRoute = readFileSync(
  join(here, '..', '..', '..', '..', '..', 'pipelinePulse', 'server',
    'src', 'routes', 'contacts.js'), 'utf8');

t('nothing renders at zero', () => {
  // "0 tasks" on every untouched record is noise, and a non-empty chip is
  // only worth noticing if an empty one is absent.
  assert.match(chips, /if \(!tasks && !notes\) return null/);
});

t('one component, used by BOTH cards', () => {
  // Two copies would drift on wording and threshold.
  assert.match(chips, /export function FollowUpChips/);
  assert.match(dealsTab, /FollowUpChips/);
  assert.match(contactsTab, /FollowUpChips/);
  assert.ok(!/from '\.\/DealsTab'/.test(contactsTab),
    'importing a component from a sibling tab is fragile — it belongs in shared');
});

t('the contacts route sends its counts', () => {
  // These did not exist: a contact with three open tasks looked identical
  // to one with none.
  assert.match(contactsRoute, /AS open_task_count/);
  assert.match(contactsRoute, /AS note_count/);
  assert.match(contactsRoute, /openTaskCount: Number\(c\.open_task_count \|\| 0\)/);
});

t('completed and soft-deleted tasks are excluded on contacts too', () => {
  // Verified against a real Postgres: 5 task rows in, 2 counted.
  assert.match(contactsRoute, /t\.status <> 'completed'/);
  assert.match(contactsRoute, /t\.deleted_at IS NULL/);
  assert.match(contactsRoute, /n\.status = 'active'/);
});

t('the counts are scoped to the contact, not the location', () => {
  // Without the contact_id predicate every row would show the location total.
  assert.match(contactsRoute, /t\.contact_id  = c\.contact_id/);
  assert.match(contactsRoute, /n\.contact_id  = c\.contact_id/);
});

console.log(`\n${n} passed`);
