// The Co-Pilot sidebar shell, against the client's October 2026 design.
//
// Run: node --test src/pages/shared/__tests__/copilotSidebar.test.mjs
//
// One component serves two callers: the Deal hub's Deal AI panel and the
// portfolio Co-Pilot tab. They differ in what they can actually do, and the
// sidebar has to stop offering what the caller cannot honour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bar = readFileSync(new URL('../CopilotSidebar.jsx', import.meta.url), 'utf8');
const askDeal = readFileSync(new URL('../../dealhub/AskDeal.jsx', import.meta.url), 'utf8');
const copilot = readFileSync(new URL('../../tabs/CopilotTab.jsx', import.meta.url), 'utf8');

test('the nav icons are the ones the design shows', () => {
  // auto_stories and grid_view read as a magazine and a plain grid — close
  // enough to be wrong rather than obviously different.
  assert.match(bar, /icon: 'menu_book',\s+label: 'Templates'/);
  assert.match(bar, /icon: 'dashboard_customize', label: 'Customize'/);
  assert.match(bar, /icon="edit_note" label="New chat"/);
});

test('RECENTS is a section divider, not another nav row', () => {
  // Uppercase and small, so it reads as a heading over the chat titles rather
  // than as a fifth item under Customize.
  assert.match(bar, /textTransform: 'uppercase'/);
  assert.match(bar, /const RECENTS_LABEL = \{/);
});

test('the chevron only appears where it does something', () => {
  // Deal hub passes a no-op toggle, so its chevron was a control that looked
  // interactive and did nothing — worse than the plain label the design
  // shows. The portfolio tab wires a real toggle and keeps it.
  assert.match(bar, /recentsCollapsible = true,/);
  assert.match(bar, /\{recentsCollapsible \? \(/);
  assert.match(askDeal, /recentsCollapsible=\{false\}/);
  assert.doesNotMatch(copilot, /recentsCollapsible/,
    'the Co-Pilot tab must keep its working chevron (default true)');
});

test('collapsibility is declared, not sniffed from the handler', () => {
  // Reading a function's source to guess whether it is a no-op works in dev
  // and silently flips under minification.
  assert.doesNotMatch(bar, /onToggleRecentsCollapsed\.toString\(\)/);
});

test('a Recents row shows WHEN, not just the title', () => {
  // Four chats that all begin "create a task title:" are indistinguishable
  // without it. `lastAt` was on every conversation already.
  assert.match(bar, /conv\.lastAt && \(/);
  assert.match(bar, /formatChatStamp\(conv\.lastAt\)/);
});

test('the stamp uses the house date helper, not a locale call', () => {
  // en-GB renders September as "Sept" — a different width from every other
  // month, and not what the design shows. MONTHS gives a uniform three.
  assert.match(bar, /formatDate\(at, false\)/);
  // The phrase survives in a COMMENT explaining why — check the call, not
  // the file.
  assert.doesNotMatch(bar, /d\.toLocaleDateString\(/);
});

test('the Account avatar degrades to an icon, not a stray dot', () => {
  // fullName comes from matching the session's user id against the location's
  // users list, and the session carries only an id — so an agency user who is
  // not a member of the sub-account has no name to initial, and the avatar
  // rendered as a lone "·" that read as a rendering fault.
  assert.match(bar, /if \(!name\) return null/);
  assert.match(bar, /initialsOf\(fullName\) \|\| \(/);
});

test('Recents rows are spaced apart, not run together', () => {
  // At 1px a title sat closer to the NEXT row's title than to its own
  // timestamp, so four chats read as one block of text — exactly what a list
  // of near-identical questions must not do.
  assert.match(bar, /marginBottom: 6,/);
  assert.match(bar, /display: 'block', marginTop: 3,/);
});

test('the signed-in name comes from /me, not the rep picker', () => {
  // /deals/users is filtered to active ACCOUNT users attached to this
  // sub-account. The person holding the session is often an agency admin who
  // owns the location without being a member of it, so a name resolved from
  // that list could never be found — and the avatar fell back to an icon.
  const askDeal = readFileSync(
    new URL('../../dealhub/AskDeal.jsx', import.meta.url), 'utf8'
  );
  const copilot = readFileSync(
    new URL('../../tabs/CopilotTab.jsx', import.meta.url), 'utf8'
  );
  for (const [name, src] of [['AskDeal', askDeal], ['CopilotTab', copilot]]) {
    assert.match(src, /dealsAPI\.me\(\)/, `${name} still reads the rep list`);
    assert.doesNotMatch(src, /\(r\?\.users \|\| \[\]\)\.find/, `${name} still filters the rep list`);
  }
});

test('/me answers for ANY user type', () => {
  // A filter here would reintroduce the bug it exists to fix.
  const deals = readFileSync(
    new URL('../../../../../pipelinePulse/server/src/routes/deals.js', import.meta.url), 'utf8'
  );
  const route = deals.slice(deals.indexOf("dealsRouter.get('/me'"), deals.indexOf("dealsRouter.get('/users'"));
  assert.match(route, /WHERE location_id = \$1 AND user_id = \$2/);
  assert.doesNotMatch(route, /user_type = 'account'/);
  // null, not 404: an unsynced user is a normal answer.
  assert.match(route, /res\.json\(\{ user: null \}\)/);
});
