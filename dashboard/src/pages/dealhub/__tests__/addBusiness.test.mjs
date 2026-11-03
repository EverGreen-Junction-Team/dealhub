// "Add business" on the Deal Hub's deal card.
//
// GHL has no opportunities.business_id. A deal reaches a business only
// through the contacts on it (contacts.business_id), so "add a business to
// this deal" means setting businessId on the deal's PRIMARY contact — the
// Businesses block then shows it through them. Until now the block could
// only display a business a contact already had; there was no way to set one.
//
// Mirrored from DealSection / DealHubTab rather than imported: the real
// components render through antd and a portal and need a DOM. The decisions
// underneath — which contact, whether to offer the button, how the
// optimistic paint behaves — are plain data, so they are tested as that.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const section = readFileSync(new URL('../DealSection.jsx', import.meta.url), 'utf8');
// The linking WRITE and the picker's own list live in the shared modal, not in
// DealSection: Deal Hub and the contact record both open this one component,
// which is what stops the two surfaces drifting on what "link" means. These
// assertions follow the code rather than pinning it to where it used to sit.
const picker = readFileSync(new URL('../../shared/BusinessPickerModal.jsx', import.meta.url), 'utf8');
const tab = readFileSync(new URL('../../tabs/DealHubTab.jsx', import.meta.url), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Mirrors BusinessBlock's choice of contact.
const primaryFor = (deal) =>
  (deal.people || []).find((p) => p.primary) || (deal.people || [])[0] || null;

// Mirrors DealHubTab's onBusinessLinked optimistic paint.
const paint = (deal, business) => {
  const have = new Set((deal.businesses || []).map((b) => b.id));
  if (have.has(business.id)) return deal;
  return {
    ...deal,
    businesses: [...(deal.businesses || []), {
      id: business.id, name: business.name || 'Unnamed business', city: business.city || null
    }]
  };
};

console.log('add business to a deal');

t('the link goes on the PRIMARY contact', () => {
  const p = primaryFor({ people: [{ id: 'c2', primary: false }, { id: 'c1', primary: true }] });
  assert.equal(p.id, 'c1');
});

t('falls back to the first contact when none is flagged primary', () => {
  const p = primaryFor({ people: [{ id: 'c9' }, { id: 'c8' }] });
  assert.equal(p.id, 'c9');
});

t('a deal with NO contacts offers no button — nothing to hang a business on', () => {
  // There is no deal↔business endpoint to fall back to; the contact IS the
  // link. Offering the button here would open a picker that cannot save.
  assert.equal(primaryFor({ people: [] }), null);
  assert.match(section, /\{primary && \(/);
});

t('the optimistic paint adds the business before the webhook lands', () => {
  const d = paint({ businesses: [] }, { id: 'b1', name: 'Acme', city: 'Leeds' });
  assert.deepEqual(d.businesses, [{ id: 'b1', name: 'Acme', city: 'Leeds' }]);
});

t('linking the same business twice does not list it twice', () => {
  // Two contacts at one company would otherwise show it doubled until the
  // 2.5s refetch de-duped it server-side.
  const once = paint({ businesses: [{ id: 'b1', name: 'Acme', city: null }] }, { id: 'b1', name: 'Acme' });
  assert.equal(once.businesses.length, 1);
});

t('the paint is followed by a DELAYED reconcile, not an immediate one', () => {
  // The write goes to GHL; our contacts.business_id only updates when the
  // ContactUpdate webhook lands. An immediate GET returns the old deal and
  // would wipe the paint — the same race that hit custom fields and people.
  // Moved out of the JSX into a named handler so the People cards' Business
  // pencil can share it.
  const at = tab.indexOf('const linkBusiness = (business) => {');
  const handler = tab.slice(at, tab.indexOf('  return (', at));
  assert.match(handler, /window\.setTimeout\(/);
  assert.match(handler, /2500\)/);
});

t('the write is a contact PATCH carrying businessId — the only link GHL has', () => {
  assert.match(picker, /contactsAPI\.update\(contact\.id, \{ businessId: picked\.id \}\)/);
});

t('already-linked businesses are excluded from the picker', () => {
  // The common mistake — relinking the one already there — cannot be clicked.
  assert.match(picker, /filter\(\(b\) => !alreadyLinked\.has\(b\.id\)\)/);
});

// ── The reconcile must not undo the link ─────────────────────────────
// Reported after the server-side relation writer was already fixed: the
// business "still removes itself". A second, independent bug — this
// handler's refetch was a wholesale setDeal(fresh), unlike the custom-field
// reconcile beside it which merges. When 2.5s loses the race against GHL's
// webhook, `fresh` has no business on it and the painted one is discarded.

const mergeFresh = (fresh, pinned) => {
  const list = fresh.businesses || [];
  if (list.some((b) => b.id === pinned.id)) return fresh;
  return { ...fresh, businesses: [...list, pinned] };
};

t('a stale refetch does not drop the business just linked', () => {
  const r = mergeFresh({ businesses: [] }, { id: 'b1', name: 'Acme', city: 'Leeds' });
  assert.deepEqual(r.businesses, [{ id: 'b1', name: 'Acme', city: 'Leeds' }]);
});

t("once the server has caught up, ITS copy wins", () => {
  // The pin is a stopgap for a slow webhook, not a source of truth — the
  // server's canonical name must not be overwritten by ours.
  const r = mergeFresh(
    { businesses: [{ id: 'b1', name: 'Acme Ltd', city: 'Leeds' }] },
    { id: 'b1', name: 'Acme', city: 'Leeds' }
  );
  assert.equal(r.businesses[0].name, 'Acme Ltd');
  assert.equal(r.businesses.length, 1);
});

t('a business already on the deal is preserved alongside the new one', () => {
  const r = mergeFresh({ businesses: [{ id: 'b9', name: 'Other' }] }, { id: 'b1', name: 'Acme' });
  assert.deepEqual(r.businesses.map((b) => b.id), ['b9', 'b1']);
});

t('the handler merges rather than replacing wholesale', () => {
  // Moved out of the JSX into a named handler so the People cards' Business
  // pencil can share it.
  const at = tab.indexOf('const linkBusiness = (business) => {');
  const handler = tab.slice(at, tab.indexOf('  return (', at));
  assert.ok(
    !/dealsAPI\.get\(dealId\)\.then\(setDeal\)/.test(handler),
    'a wholesale setDeal discards the painted business — the reported bug'
  );
  assert.match(handler, /const pinnedBusiness = \{/);
});

console.log(`\n${n} passed`);
