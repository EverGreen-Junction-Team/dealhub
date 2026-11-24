// The deal picker only ever offers the chosen contact's deals.
//
// Run: node --test src/pages/shared/__tests__/dealPickerScope.test.mjs
//
// ── THE BUG ──────────────────────────────────────────────────────────
//
// A rep filled in New task for "james stevens", opened the Deal dropdown,
// picked the only thing in it, and was told:
//
//   Task created, but its links did not save: That deal is not on this
//   contact, so the task cannot be filed against it
//
// The server was right. The dropdown was wrong — and worse, it was
// half-right in a way that hid the problem. The SEARCH was already scoped
// to the contact, so typing found the correct deals. The SEED, shown
// before anything is typed, was `linkTargets.deals`: twenty-five deals
// preloaded for the whole sub-account. A rep who opened the list and
// clicked rather than typing was choosing from the wrong list entirely.
//
// The task was still created, because the link is a second write. So the
// failure arrives after the thing it is about has already happened.
//
// ── WHAT HAS TO STAY TRUE ────────────────────────────────────────────
//
// Three things, none of them visible from reading one line:
//
//   1. The seed is not the location-wide list.
//   2. The picker is disabled until a contact is chosen — with no contact
//      the scoped search has nothing to scope to, and dealsAPI drops a null
//      param, so it quietly returns the whole sub-account again.
//   3. Changing the contact clears the chosen deal, or the box keeps
//      showing a deal that is no longer in its own list.
//
// Source assertions rather than a rendered test: these are wiring, and the
// repo has no DOM harness. A test that imported the component would need
// TipTap, antd and a browser to prove a prop is not passed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const shared = join(dirname(fileURLToPath(import.meta.url)), '..');

const EDITORS = [
  ['TaskEditor', readFileSync(join(shared, 'TaskEditor.jsx'), 'utf8')],
  ['NoteEditor', readFileSync(join(shared, 'NoteEditor.jsx'), 'utf8')],
];

/** The <RemotePicker> element whose search is the contact-scoped one. */
function dealPicker(src) {
  const at = src.indexOf('search={dealSearchForContact}');
  assert.notEqual(at, -1, 'the deal picker must use the contact-scoped search');
  const open = src.lastIndexOf('<RemotePicker', at);
  // Bounded by the enclosing </Field>, NOT by the first '/>'. The picker's
  // own props contain JSX — a <br /> inside the empty-state message — so
  // the first self-closing tag is somewhere in the middle of the element,
  // and slicing there silently drops the props after it. The two
  // assertions about the empty state passed vacuously until this changed.
  const close = src.indexOf('</Field>', at);
  assert.ok(open !== -1 && close !== -1, 'could not bound the deal picker');
  return src.slice(open, close);
}

for (const [name, src] of EDITORS) {
  test(`${name}: the deal seed is not the whole sub-account`, () => {
    // THE ACTUAL BUG. `deals` is the link-targets preload — every deal in
    // the location, regardless of who is on them.
    const el = dealPicker(src);
    assert.doesNotMatch(
      el, /seed=\{deals\.map/,
      'seeding from the location-wide deal list is what caused the refusal'
    );
    assert.match(el, /seed=\{dealSeed\}/, 'it must use the scoped seed');
  });

  test(`${name}: the seed keeps the link the record already has`, () => {
    // A contact can be taken off a deal after a task was filed against it.
    // The scoped search will not return that deal, so without it in the
    // seed the picker would show nothing and the next save would silently
    // unfile the record.
    const seed = src.slice(src.indexOf('const dealSeed'), src.indexOf('const dealSeed') + 700);
    assert.match(seed, /opportunityId/, 'the seed is built from the existing link');
  });

  test(`${name}: the picker is disabled until a contact is chosen`, () => {
    // Without this the scoped search sends contactId: null, axios drops a
    // null param, and the server answers with the whole sub-account — the
    // same wrong list reached a different way.
    const el = dealPicker(src);
    assert.match(el, /disabled=\{saving \|\| !contactId\}/);
  });

  test(`${name}: changing the contact clears the chosen deal`, () => {
    assert.match(
      src, /seenContact\.current = contactId[\s\S]{0,120}setOpportunityId\(null\)/,
      'a deal belonging to the previous contact must not survive the switch'
    );
  });

  test(`${name}: clearing is skipped on the first render`, () => {
    // Otherwise opening an existing record immediately discards the deal it
    // was saved with, and the rep's next save unfiles it.
    assert.match(
      src, /const seenContact = useRef\(contactId\)/,
      'the ref must start AT the current contact, not at null'
    );
  });

  test(`${name}: an empty list says WHY it is empty`, () => {
    // The list is scoped to the contact, so empty is a fact about them —
    // not a prompt to search harder. RemotePicker's generic default,
    // "Nothing to choose from yet", left a rep unable to tell a loading
    // list from one they had to type into from a contact with no deals.
    const el = dealPicker(src);
    assert.match(el, /noneText=/, 'the deal picker must explain its own empty state');
    assert.match(el, /isn&apos;t on any deals/);
  });

  test(`${name}: and says the record saves without a deal`, () => {
    // The question an empty state raises is "so can I still save this?".
    // Both editors allow it — neither canSave nor the server requires an
    // opportunityId — so the answer belongs here rather than being found
    // out by pressing the button.
    assert.match(dealPicker(src), /saves fine without one/);
  });

  test(`${name}: the COMPANY picker does not borrow the deal wording`, () => {
    // Easy to copy and wrong. The deal list is scoped to the contact, so
    // empty means "not one of theirs". The company list is scoped to
    // nothing — searchBusinesses asks the whole sub-account — so empty
    // means there are none here at all. Blaming the contact would send a
    // rep looking for a problem nowhere near them.
    const at = src.indexOf('search={searchBusinesses}');
    assert.notEqual(at, -1, 'the company picker must use the unscoped search');
    const el = src.slice(src.lastIndexOf('<RemotePicker', at), src.indexOf('</Field>', at));
    assert.match(el, /No companies in this sub-account yet/);
    // Comments stripped before the negative assertion. The comment beside
    // this prop explains the trap by quoting the wrong wording, and
    // matching against that failed the test for saying why it exists.
    const shown = el.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(shown, /this contact/i, 'an empty company list is not about the contact');
  });

  test(`${name}: the search stays bound to the contact`, () => {
    assert.match(
      src, /searchDeals\(q, \{ contactId \}\)/,
      'the search half must not regress either'
    );
  });
}
