// Which contacts the picker offers.
//
// Three rules, all of which were wrong or missing on the deal's "add person"
// flow:
//
//   1. SHOW SOMETHING BEFORE TYPING. The dropdown opened on "Start typing to
//      find a contact", a dead end for a rep who does not already know who is
//      in the CRM.
//   2. EXCLUDE PEOPLE ALREADY ON THE DEAL. A duplicate was offered, clicked,
//      and only then rejected with an error — making the reader do the
//      remembering.
//   3. CAP AT 11 (a primary plus ten). A product rule, tighter than GHL's own
//      25-contact association cap.
//
// Source-parsed: these components import antd and the API client, and the
// question is about the option-list rules, not the rendering.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const picker = readFileSync(join(here, '..', 'ContactPicker.jsx'), 'utf8');
const people = readFileSync(join(here, '..', '..', 'dealhub', 'PeopleSection.jsx'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// The option-building rule, mirrored from ContactPicker.
const buildOptions = ({ chosen, seed = [], results = [], exclude = [], value }) => {
  const seen = new Set();
  const blocked = new Set(exclude.filter(Boolean));
  const rows = [];
  for (const c of [chosen, ...seed, ...results].filter(Boolean)) {
    if (!c.id || seen.has(c.id)) continue;
    if (blocked.has(c.id) && c.id !== value) continue;
    seen.add(c.id);
    rows.push(c.id);
  }
  return rows;
};

console.log('which contacts are offered');

t('people already on the deal are excluded', () => {
  const out = buildOptions({
    results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    exclude: ['b']
  });
  assert.deepEqual(out, ['a', 'c'], 'b is already on the deal and must not be offered');
});

t('excluding everyone yields an empty list, not a crash', () => {
  assert.deepEqual(buildOptions({ results: [{ id: 'a' }], exclude: ['a'] }), []);
});

t('THE CURRENT VALUE survives exclusion', () => {
  // In an editor the contact already on the task is in `exclude` by
  // definition. Dropping it would blank the field on the next list refresh.
  const out = buildOptions({
    chosen: { id: 'b' }, results: [{ id: 'a' }, { id: 'b' }],
    exclude: ['b'], value: 'b'
  });
  assert.ok(out.includes('b'), 'the chosen contact must stay in the list');
});

t('duplicates across seed and results collapse', () => {
  assert.deepEqual(buildOptions({ seed: [{ id: 'a' }], results: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
});

t('contacts with no id are dropped rather than rendering a blank row', () => {
  assert.deepEqual(buildOptions({ results: [{ id: null }, {}, { id: 'a' }] }), ['a']);
});

t('an empty exclude list changes nothing', () => {
  assert.deepEqual(buildOptions({ results: [{ id: 'a' }, { id: 'b' }], exclude: [] }), ['a', 'b']);
});

console.log('\nthe wiring');

t('the picker fetches before anything is typed', () => {
  // Defaults ON: every picker shows a first page rather than a dead end.
  // Two callers used to opt in and four did not, so the same control behaved
  // differently depending on where it was opened.
  assert.match(picker, /showInitial = true/);
  assert.match(picker, /if \(!q && !showInitial\)/,
    'an empty query must still fetch when showInitial is set');
  // …and the request omits q entirely rather than sending q=''.
  assert.match(picker, /\.\.\.\(q \? \{ q \} : \{\}\)/);
});

t('the deal flow asks for the initial list and excludes its people', () => {
  assert.match(people, /showInitial/, 'the add-person picker still opens on a dead end');
  assert.match(people, /exclude=\{\[\.\.\.alreadyOn\]\}/,
    'people already on the deal are not excluded from the list');
});

t('the 11-person cap exists and gates the button', () => {
  assert.match(people, /const MAX_PEOPLE = 11/);
  assert.match(people, /const full = \(people\?\.length \|\| 0\) >= MAX_PEOPLE/);
  assert.match(people, /disabled=\{!dealId \|\| full\}/,
    'the add button must be disabled at the cap');
});

t('the cap is enforced in the handler too, not only the button', () => {
  // A stale render could still reach add().
  assert.match(people, /if \(full\) \{/);
  assert.match(people, /A deal can hold \$\{MAX_PEOPLE\} people/);
});

t('the disabled button says WHY', () => {
  // A greyed "Add someone" with no explanation reads as broken.
  assert.match(people, /limit reached/);
});

t('11 is at or under GHL own association cap', () => {
  // OPPORTUNITIES_CONTACTS_ASSOCIATION caps at 25 on the server. A tighter
  // product rule can never produce a call GHL would reject; a looser one
  // would fail at the API.
  const MAX = Number(/const MAX_PEOPLE = (\d+)/.exec(people)[1]);
  assert.ok(MAX <= 25, `MAX_PEOPLE ${MAX} exceeds GHL cap of 25`);
  assert.equal(MAX, 11, 'the product rule is 1 primary + 10 additional');
});

// ── Removing a contact from a deal ──────────────────────────────────────
//
// The Remove button sat inert as "coming next" in the deal hub. The endpoint
// (DELETE /api/deals/:id/contacts/:relationId) had always existed; what was
// missing was relationId in the detail route's people payload, so the client
// had nothing to call it with.
console.log('\nremoving a contact');

t('the deal hub Remove button is wired to a handler', () => {
  // Remove now ASKS first — it opens a confirm rather than unlinking on the
  // click. The actual call happens from the dialog's onConfirm.
  assert.match(people, /onRemove=\{\(\) => \{ setRemoveError\(null\); setConfirming\(p\) \}\}/,
    'Remove must open a confirm, not unlink immediately');
  assert.match(people, /onConfirm=\{\(\) => removePerson\(confirming\)\}/,
    'the confirm must be what performs the removal');
  assert.match(people, /await dealsAPI\.removeContact\(dealId, p\.relationId\)/,
    'removal must use the LINK id, not the contact id');
  assert.ok(!/Remove from deal — coming next/.test(people),
    'the placeholder title is still there');
});

t('Remove is hidden without a relationId', () => {
  // A synthesised primary row (a deal whose contact has no
  // opportunity_contacts entry) has no link to delete — calling with
  // undefined would 404.
  assert.match(people, /allowRemove && p\.relationId/);
});

t('the last contact cannot be removed', () => {
  // GHL files notes and tasks against a contact, so a deal with none can
  // hold neither.
  assert.match(people, /allowRemove=\{people\.length > 1\}/);
});

t('a failed removal is reported, not swallowed', () => {
  assert.match(people, /setRemoveError/);
  // Rendered inline for actions with no dialog (Make primary), and inside the
  // confirm for a removal — guarded so the two never show at once.
  assert.match(people, /\{removeError && !confirming && \(/,
    'the inline error must not double up with the dialog\'s own');
  assert.match(people, /error=\{removeError\}/,
    'the confirm dialog must surface the failure');
});

t('MAKE PRIMARY is wired, not a placeholder', () => {
  // contactId is @HideApiProperty on PUT /opportunities/:id — absent from the
  // marketplace docs, which is why this sat as "coming next", but the service
  // applies it:  if (body.contactId) opportunity.contactId = body.contactId
  assert.match(people, /await dealsAPI\.setPrimaryContact\(dealId, p\.id\)/,
    'Make primary must call the dedicated endpoint');
  assert.ok(!/Set as primary — coming next/.test(people),
    'the placeholder is still there');
  // Hidden on the contact that already is primary.
  assert.match(people, /\{!p\.primary && \(/);
});

t('the edit panel offers it too', () => {
  const panel = readFileSync(
    join(here, '..', '..', 'deals', 'DealEditPanel.jsx'), 'utf8');
  assert.match(panel, /await dealsAPI\.setPrimaryContact\(dealId, p\.id\)/);
  // A badge on the primary, a button on everyone else.
  assert.match(panel, /\{p\.primary \? \(/);
});

// ── The three fixes from the People cards ───────────────────────────────
console.log('\nPeople card actions');

t('"View contact" is wired, not disabled', () => {
  // It sat greyed with a "coming next" title purely because nothing passed
  // onOpenContact down — the shell has had openContact all along, and the
  // Tasks and Notes tabs already used it.
  assert.match(people, /onClick=\{onViewContact\}/);
  assert.ok(!/Contact record — coming next/.test(people),
    'the placeholder title is still there');
  const shell = readFileSync(join(here, '..', '..', 'DealHubShell.jsx'), 'utf8');
  assert.match(shell, /onOpenContact=\{openContact\}/,
    'the shell must pass openContact to the deal hub');
  const hub = readFileSync(join(here, '..', '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.match(hub, /onOpenContact=\{onOpenContact\}/,
    'the deal hub must pass it to PeopleSection');
});

t('"Show in thread" TOGGLES rather than only filtering on', () => {
  // It always sent [p.id], so once a person was filtered the only way back
  // was the "Everyone" chip, and a second press did nothing while the button
  // stayed lit.
  assert.match(people, /peopleFilter\.includes\(p\.id\)\s*\?\s*peopleFilter\.filter/,
    'a second press must clear the filter');
  // And it says which way it goes.
  assert.match(people, /filterActive \? 'Showing in thread' : 'Show in thread'/);
});

t('Remove asks before unlinking, in BOTH places', () => {
  const panel = readFileSync(
    join(here, '..', '..', 'deals', 'DealEditPanel.jsx'), 'utf8');
  for (const [src, file] of [[people, 'PeopleSection'], [panel, 'DealEditPanel']]) {
    assert.match(src, /<ConfirmDialog/, `${file} unlinks with no confirmation`);
    assert.match(src, /confirmLabel="Remove"/, `${file} confirm is not labelled`);
    // The dialog names who is going, so the reader can check the right card
    // was clicked.
    assert.match(src, /preview=\{\[nameFor\(confirming\)/, `${file} does not show who`);
  }
});

t('the confirm explains what is NOT deleted', () => {
  // Unlinking a contact from a deal is not deleting the contact, and a
  // dialog that does not say so invites the reader to assume the worst.
  assert.match(people, /contact record and its history are not deleted/i);
});

// ── The search spinner ──────────────────────────────────────────────────
console.log('\nthe search spinner');

t('the spinner is on the control, not only in notFoundContent', () => {
  // antd renders notFoundContent ONLY when the option list is empty. Typing
  // forward narrows a query while the previous results are still on screen,
  // so there was always something to render and no spinner appeared —
  // backspacing often widens to a query with no cached match, the list
  // empties, and it did. Hence "the loader only shows on backspace".
  assert.match(picker, /loading=\{loading\}/,
    'Select needs the loading prop, which renders in the suffix regardless '
    + 'of whether options are showing');
});

t('notFoundContent still covers the genuinely-empty cases', () => {
  // Belt and braces: it is right for "no match" and the first-load spinner.
  assert.match(picker, /notFoundContent=\{/);
  assert.match(picker, /<Spin size="small" \/>/);
});

// ── The add button in the edit panel ────────────────────────────────────
t('"Add someone" hugs its content instead of spanning the panel', () => {
  const panel = readFileSync(
    join(here, '..', '..', 'deals', 'DealEditPanel.jsx'), 'utf8');
  // The parent is a single-column grid, so alignSelf governs the VERTICAL
  // axis only — justifySelf is what stops the horizontal stretch. Measured:
  // 682px before, 112px after.
  assert.match(panel, /justifySelf: 'start'/,
    'without justifySelf the button stretches the full panel width');
});

console.log(`\n${n} passed`);
