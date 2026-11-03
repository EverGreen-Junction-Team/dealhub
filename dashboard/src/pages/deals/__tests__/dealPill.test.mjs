// Reaching the deal hub from the Deals TABLE.
//
// Every other list — Notes, Tasks, Businesses — opens a deal through the same
// green DealPill, sitting beside the thing it belongs to. The Deals table had
// only a small icon at the far right of the row, past six other columns: the
// one list entirely about deals was the hardest place to open one from, and
// the control did not look like the control that does this everywhere else.
//
// These pin the chip, its wiring, and the two things that silently break it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const table = read('../DealTable.jsx');
const tab = read('../../tabs/DealsTab.jsx');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('the table opens the hub through the shared chip', () => {
  assert.match(table, /<DealPill/, 'no DealPill in the deals table');
  // Imported, or it is a ReferenceError at render — the component would have
  // looked fine in review and crashed the whole table in the browser.
  assert.match(
    table, /import \{[^}]*DealPill[^}]*\} from '\.\.\/shared\/ListChrome'/,
    'DealPill is used but never imported'
  );
});

t('the chip is wired to the hub, not the editor', () => {
  const at = table.indexOf('<DealPill');
  const chip = table.slice(at, at + 220);
  assert.match(chip, /onOpenInHub/, 'the chip does not call onOpenInHub');
  assert.ok(!/onOpenDeal\(/.test(chip), 'the chip opens the editor instead of the hub');
});

t('clicking the chip does not also fire the row', () => {
  // The ROW opens the editor on click. Without stopPropagation both fire and
  // the editor wins — the chip would look broken while doing exactly what it
  // was told.
  const at = table.indexOf('<DealPill');
  const cell = table.slice(table.lastIndexOf('<td', at), at);
  assert.match(
    cell, /stopPropagation/,
    'the chip cell does not stop the row handler — the editor would open instead'
  );
});

t('the header has a column for it', () => {
  // A <td> with no matching <th> shifts every header one column left, which
  // misaligns the whole table rather than erroring.
  const headerBlock = table.slice(table.indexOf('<th style={TH}>Deal</th>'), table.indexOf('</tr>', table.indexOf('<th style={TH}>Deal</th>')));
  const ths = (headerBlock.match(/<th/g) || []).length;
  assert.ok(ths >= 3, `expected a spacer <th> between Deal and Contact, found ${ths} headers`);
  assert.match(headerBlock, /aria-label="Open on the deal hub"/, 'the spacer header is unlabelled for screen readers');
});

t('the tab actually passes a handler in', () => {
  // The chip renders inert without this — present, styled, does nothing.
  // The list view is DealList now (the Figma List, Oct 2026). Its row has no
  // DEAL pill in the design; the hub is reached from the Tasks and Notes
  // menus, which need the same handler.
  const at = tab.indexOf('<DealList');
  assert.notEqual(at, -1, 'DealList is no longer rendered by the tab');
  const props = tab.slice(at, tab.indexOf('/>', at));
  assert.match(props, /onOpenInHub=/, 'DealList is rendered without onOpenInHub');
});


t('every surface opens a deal the SAME way', () => {
  // Four treatments existed for one action: a green chip (Notes, Tasks), a
  // ghost "Open deal →" (Businesses), and a solid brand button (Contacts).
  // Each was defensible alone; together they meant a rep learned the control
  // three times. Pinned so a new surface does not quietly invent a fourth.
  const surfaces = [
    ['../../tabs/NotesTab.jsx', 'Notes'],
    ['../../tabs/TasksTab.jsx', 'Tasks'],
    ['../../tabs/BusinessesTab.jsx', 'Businesses'],
    ['../../contacts/ContactDetail.jsx', 'Contacts'],
    ['../DealBoard.jsx', 'Deals board'],
    ['../../tabs/ContactsTab.jsx', 'Contacts grid'],
  ];
  for (const [rel, label] of surfaces) {
    const src = read(rel);
    assert.match(src, /<DealPill/, `${label} does not use the shared DealPill`);
    assert.match(
      src, /DealPill[^}]*\} from '[^']*ListChrome'/,
      `${label} uses DealPill without importing it`
    );
  }
});

t('the old one-off deal buttons are gone', () => {
  // The exact strings the two converted surfaces used. If either comes back,
  // the inconsistency is back with it.
  for (const rel of ['../../tabs/BusinessesTab.jsx', '../../contacts/ContactDetail.jsx']) {
    const src = read(rel);
    assert.ok(
      !/>\s*Open deal\s*</.test(src),
      `${rel} still renders its own "Open deal" button alongside the chip`
    );
  }
});


t('the board chip does not break card dragging', () => {
  // A button inside a draggable element starts its OWN drag on mousedown,
  // which cancels the click — so the board card's control has always needed
  // draggable={false} and an onDragStart guard. The square icon button it
  // replaced carried both; a bare chip would have silently broken dragging
  // on every card, which no amount of staring at the deal hub would reveal.
  const board = read('../DealBoard.jsx');
  const at = board.indexOf('<DealPill');
  assert.notEqual(at, -1, 'the board has no DealPill');
  const chip = board.slice(at, board.indexOf('/>', at));
  assert.match(chip, /draggable=\{false\}/, 'the board chip can start its own drag');
  assert.match(chip, /onDragStart=/, 'the board chip has no drag guard');
  assert.match(chip, /stopPropagation/, 'the board chip would also open the editor');

  // And the shared component must actually FORWARD them — passing props a
  // component ignores looks right and does nothing.
  const chrome = read('../../shared/ListChrome.jsx');
  const dealChip = chrome.slice(chrome.indexOf('export function DealPill'), chrome.indexOf('export function Chip'));
  assert.match(dealChip, /draggable/, 'DealPill does not accept draggable');
  assert.match(dealChip, /onDragStart/, 'DealPill does not accept onDragStart');
  const plainChip = chrome.slice(chrome.indexOf('export function Chip'));
  assert.match(plainChip, /draggable=\{draggable\}/, 'Chip never forwards draggable to the element');
});


// DealPill alone — RecordPill now sits between it and Chip.
const dealPillSource = (chrome) =>
  chrome.slice(chrome.indexOf('export function DealPill'), chrome.indexOf('const RECORD_FILL'));

t('the pill has both halves, in both states', () => {
  const pill = dealPillSource(read('../../shared/ListChrome.jsx'));
  // Green "View | 🏷" when linked, red "No | 🏷" when not: the COLOUR carries
  // the state. The capsule is a GLYPH now (Oct 2026), not the word DEAL —
  // the word is its tooltip and accessible name.
  assert.match(pill, /'View'/, 'the pill never says View');
  assert.match(pill, /'No'/, 'the pill has no unlinked state');
  assert.match(pill, />sell</, 'the white tag capsule is gone');
  assert.match(pill, /aria-label="Deal"/, 'the capsule has no accessible name');
  assert.match(pill, /--green-500/, 'the linked state is not green');
  assert.match(pill, /--status-stuck/, 'the unlinked state is not red');
});

t('an unlinked pill is not clickable', () => {
  const chrome = read('../../shared/ListChrome.jsx');
  const pill = chrome.slice(chrome.indexOf('export function DealPill'), chrome.indexOf('export function Chip'));
  // "No DEAL" must not look or behave like a link to a deal that is not there.
  assert.match(pill, /&& !empty/, 'an empty pill is still rendered as a live button');
});


t('the board uses the compact pill', () => {
  // A board column is ~260px wide. The full-size pill is ~106px of that, and
  // with flex:none it does not yield — so the title beside it was squeezed to
  // nothing and cards showed a pill with no deal name at all.
  const board = read('../DealBoard.jsx');
  const at = board.indexOf('<DealPill');
  const pill = board.slice(at, board.indexOf('/>', at));
  assert.match(pill, /compact/, 'the board renders the full-size pill and crushes its own titles');
});

t('the pill never yields its size to a long title', () => {
  // flex:none is what makes the TITLE ellipsise instead of the control
  // collapsing into an unreadable sliver.
  const chrome = read('../../shared/ListChrome.jsx');
  const pill = chrome.slice(chrome.indexOf('export function DealPill'), chrome.indexOf('export function Chip'));
  assert.match(pill, /flex: 'none'/, 'the pill can be squeezed by a long deal name');
});

t('compact changes size, not identity', () => {
  // Same two halves, same colours — a rep must not have to learn a second
  // control on the board.
  const chrome = read('../../shared/ListChrome.jsx');
  const pill = chrome.slice(chrome.indexOf('export function DealPill'), chrome.indexOf('export function Chip'));
  for (const prop of ['height', 'padding', 'fontSize']) {
    assert.ok(
      new RegExp(`${prop}: compact \\?`).test(pill),
      `${prop} does not scale with compact — the variant would be the same size`
    );
  }
  assert.ok(!/compact \? '[^']*red|compact \? '[^']*No'/.test(pill), 'compact alters the pill\'s meaning, not just its size');
});


t('the contacts card keeps its deal detail AND gains the pill', () => {
  // These rows are not just an action: they carry the deal's name, value,
  // stage and whether this contact owns it. A bare pill shows none of that,
  // so the row stays and the pill is added to it.
  const contacts = read('../../tabs/ContactsTab.jsx');
  const at = contacts.indexOf('<DealPill');
  assert.notEqual(at, -1, 'the contacts card has no pill');
  const block = contacts.slice(Math.max(0, at - 2200), at);
  assert.match(block, /PRIMARY/, 'the PRIMARY badge was lost');
  assert.match(block, /money\(d\.value\)/, 'the deal value was lost');
  assert.match(block, /d\.stage/, 'the stage was lost');
});

t('the contacts deal row is not a button around a button', () => {
  // The row used to be a <button> that opened the deal. With the pill inside
  // it that is a button nested in a button — invalid HTML, and two tab stops
  // for one destination.
  const contacts = read('../../tabs/ContactsTab.jsx');
  const at = contacts.indexOf('<DealPill');
  const rowStart = contacts.lastIndexOf('{c.deals.map', at);
  const row = contacts.slice(rowStart, at);
  assert.ok(!/<button/.test(row), 'the deal row is still a button wrapping the pill');
});

t('the pill text is small enough for a control', () => {
  const pill = dealPillSource(read('../../shared/ListChrome.jsx'));
  // The full-size label stays two below the 12/13px tokens it started on —
  // at --text-base the word "View" outweighed the deal names beside it. The
  // compact size is the linked-records size (--text-sm), shared with the
  // CONTACT and BUSINESS pills.
  const m = pill.match(/fontSize: compact \? 'var\(--text-sm\)' : (\d+)/);
  assert.ok(m, 'the label size is not compact ? --text-sm : N');
  assert.ok(Number(m[1]) <= 11, `label is ${m[1]}px, expected 11 or less`);
  // The capsule holds a glyph, sized on its own.
  assert.match(pill, /className="ms" style=\{\{ fontSize: 13 \}\}>sell</, 'the tag glyph lost its size');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  NOT OK  ${name}\n    ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
