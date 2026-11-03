// The task card's linked records — the client's October 2026 design.
//
// Run: node --test src/pages/tabs/__tests__/taskCardLinks.test.mjs
//
// A task names up to three records: the contact it is filed against, the deal
// it belongs to, and the business behind them. These were two bare pills — a
// ContactChip and a DealPill — which said WHO and WHICH DEAL but never what
// kind of record each was, and the business was not shown at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tab = readFileSync(new URL('../TasksTab.jsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../DealHubShell.jsx', import.meta.url), 'utf8');
// The linked-record rows, shared with the Notes tab.
const linked = readFileSync(new URL('../../shared/LinkedRecords.jsx', import.meta.url), 'utf8');

test('all three records get a row', () => {
  // The business was missing entirely, though the server has returned
  // `business: { id, name }` on every task all along.
  for (const icon of ['person', 'sell', 'business']) {
    assert.match(linked, new RegExp(`icon="${icon}"`), `no row for ${icon}`);
  }
  assert.match(linked, /business: \{ fill: 'var\(--accent-plum\)', label: 'BUSINESS' \}/);
});

test('only the records a task HAS get a row; a missing deal is called out', () => {
  // The October 2026 designs give a missing contact or business no row —
  // three "No X" lines on an unattached task were most of its item — but a
  // missing DEAL is the state a rep needs to spot, so both views draw a red
  // "No DEAL" pill in its own place.
  assert.match(linked, /if \(contact\) \{/);
  assert.match(linked, /if \(t\.deal\) \{/);
  assert.match(linked, /if \(t\.business\) \{/);
  assert.doesNotMatch(tab, /emptyText="No (contact|business)"/);
  const pills = tab.match(/\{!t\.deal && [\s\S]{0,160}?<DealPill name="No deal" empty/g) || [];
  assert.equal(pills.length, 2, 'one No DEAL pill per view');
});

test('the deal row uses the SHARED DealPill', () => {
  // Opening a deal has one treatment across every surface (dealPill.test.mjs
  // pins it). A fourth one here would make a rep learn the control twice.
  assert.match(tab, /<DealPill/);
  assert.match(tab, /DealPill[^}]*\} from '[^']*ListChrome'/);
});

test('the business row can actually open something', () => {
  // The handler existed in the shell and was never passed down, so the row
  // would have rendered a button that did nothing.
  assert.match(tab, /onOpenBusiness/);
  assert.match(shell, /onOpenBusiness=\{openBusiness\}/);
});

test('both views share one LinkedRecords', () => {
  // View CONTACT / DEAL / BUSINESS must open the same way in rows and grid.
  const uses = tab.match(/<LinkedRecords/g) || [];
  assert.equal(uses.length, 2, 'TaskRow and TaskCard each render LinkedRecords once');
});

// ── The row — October 2026 design ────────────────────────────────────────────

const row = tab.slice(tab.indexOf('function TaskRow('), tab.indexOf('function dueLine('));

test('rows view is four ruled columns: done · who · when · what', () => {
  assert.ok(row.length > 0, 'TaskRow not found');
  assert.match(
    row,
    /gridTemplateColumns: '56px minmax\(280px, 400px\) minmax\(150px, auto\) minmax\(0, 1fr\)'/
  );
  // Ruled apart, with each divider running the full row height.
  assert.match(row, /alignItems: 'stretch'/);
  assert.equal((row.match(/borderRight: rule/g) || []).length, 3, 'three column rules');
});

test('THE DUE DATE IS A SIBLING OF THE TITLE COLUMN, NOT A CHILD', () => {
  // THE BUG THIS FILE EXISTS FOR.
  //
  // The due block was written INSIDE the title column's <div> and carried
  // `order: 2`, which does nothing: `order` sorts SIBLINGS, and its siblings
  // were the title and the description. So the row grid received three items
  // where it declared columns for more, and the date rendered under the title
  // with the edit and delete buttons beside it — exactly what the screenshot
  // showed.
  //
  // Asserted structurally, because the markup was VALID and rendered without
  // complaint; only the position was wrong. The columns are written in order,
  // each opened by its numbered comment.
  const at = (s) => row.indexOf(s);
  const marks = ['1 · DONE', '2 · WHO', '3 · WHEN', '4 · WHAT'].map(at);
  assert.ok(marks.every((i) => i > 0), 'a row column is missing');
  assert.deepEqual([...marks].sort((a, b) => a - b), marks, 'columns out of order');
  // The date and the No DEAL pill live in WHEN; the actions in WHAT.
  const when = row.slice(marks[2], marks[3]);
  assert.match(when, /\{due\.text\}/);
  assert.match(when, /<DealPill name="No deal" empty/);
  const what = row.slice(marks[3]);
  assert.match(what, /icon="edit"/);
  assert.match(what, /icon="close"/);
});

test('only an OVERDUE date is red; the DUE DATE label stays grey', () => {
  const when = row.slice(row.indexOf('3 · WHEN'), row.indexOf('4 · WHAT'));
  assert.match(when, /color: overdue \? 'var\(--status-stuck\)' : 'var\(--text-heading\)'/);
  assert.match(when, /className="pp-label" style=\{\{ marginBottom: 0, color: 'var\(--text-muted\)' \}\}/);
  // Today is black too — "(today)" says it, not a colour.
  assert.match(tab, /text: `\$\{date\} \(today\)`, colour: 'var\(--text-heading\)'/);
  assert.doesNotMatch(tab, /accent-gold-text/);
});

test('linked record names and icons are weighted as the design draws them', () => {
  assert.match(linked, /'wght' 600/);
  assert.match(linked, /fontWeight: 500,\s*\n\s*color: present \? 'var\(--text-heading\)'/);
});

test('no `order` is used to place the row grid columns', () => {
  // The columns are written in the order they appear. Reaching for `order`
  // here is what hid the nesting bug above: the style said four columns while
  // the DOM held three, and the two disagreed silently.
  assert.doesNotMatch(row, /order: [0-9]/, 'the rows grid must not position its columns with order');
});

test('each view has exactly one complete toggle', () => {
  // Rows show a bare circle in their own leading column. The card shows the
  // stacked "MARK / COMPLETE" one in its footer. Two in either view would be
  // two ways to do one thing.
  const ticks = tab.match(/<CompleteToggle/g) || [];
  assert.equal(ticks.length, 2, 'one toggle per view, no more');
  // [\s\S] rather than [^>]: the props hold arrow functions, whose `=>` would
  // end a [^>] match early.
  assert.match(tab, /<CompleteToggle[\s\S]{0,300}?compact\s*\/>/, 'the rows toggle must be compact');
  assert.match(tab, /<CompleteToggle[\s\S]{0,300}?stacked\s*\/>/, 'the card toggle must be stacked');
  // The design's glyph: a tick in a circle, filled once done.
  assert.match(tab, /className=\{done \? 'ms ms-fill' : 'ms'\}/);
});

test('the due date is labelled in BOTH views', () => {
  // A bare date says nothing about what it is — "14 Oct" could be when the
  // task was created — and the calendar icon is what the design leads the
  // line with.
  assert.match(tab, /'calendar_today'/);
  assert.match(tab, /\{done \? 'Done' : 'Due date'\}/);
  // The card: "DUE 18 Sep (overdue)".
  assert.match(tab, /label: 'Due', text: `\$\{date\} \(overdue\)`/);
});

// ── The grid card — October 2026 design ──────────────────────────────────────

const card = tab.slice(tab.indexOf('function TaskCard('), tab.indexOf('function TaskRow('));

test('the grid renders TaskCard and rows render TaskRow', () => {
  assert.ok(card.length > 0, 'TaskCard not found');
  assert.match(tab, /if \(view === 'grid'\) return <TaskCard key=\{t\.id\} \{\.\.\.shared\} \/>/);
  assert.match(tab, /<TaskRow\s*\n\s*key=\{t\.id\}\s*\n\s*\{\.\.\.shared\}/);
});

test('a missing deal is called out in the HEADER', () => {
  // The design draws "No DEAL" beside the title; the deal row only appears
  // when there IS a deal.
  const header = card.indexOf('HEADER');
  const body = card.indexOf('BODY');
  const pill = card.indexOf('<DealPill name="No deal" empty />');
  assert.ok(header > 0 && pill > header && pill < body, 'No DEAL pill must sit in the header');
  assert.match(card, /\{!t\.deal && \(/);
});

test('every linked record can be opened', () => {
  // View CONTACT / DEAL / BUSINESS each route somewhere — a pill that looks
  // like a button and does nothing is worse than no pill. Both views render
  // these through the one LinkedRecords.
  assert.match(linked, /onOpenContact \? \(\) => onOpenContact\(contact\.id\)/);
  assert.match(linked, /onOpenDeal \? \(\) => onOpenDeal\(t\.deal\.id\)/);
  assert.match(linked, /onOpenBusiness \? \(\) => onOpenBusiness\(t\.business\.id\)/);
});

test('the card footer sits BELOW the linked records and carries the actions', () => {
  const links = card.indexOf('LINKED RECORDS');
  const footer = card.indexOf('FOOTER');
  assert.ok(links > 0 && footer > links, 'footer must close the card, under the records');
  const foot = card.slice(footer);
  for (const bit of ['<CompleteToggle', 'icon="edit"', 'icon="close"']) {
    assert.ok(foot.includes(bit), `${bit} must be in the footer`);
  }
  // Nothing absolutely positioned at the top-right any more.
  assert.doesNotMatch(tab, /position: 'absolute', top: 12, right: 12/);
});
