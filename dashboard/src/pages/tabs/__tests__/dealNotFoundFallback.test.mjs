// Deal Hub's fallback when the selected deal 404s.
//
// Reported: opening Deal Hub landed on a dead end — the switcher dropdown
// said "Select a deal…" (never populated, because the fetch failed) sitting
// above a flat "Deal not found" banner, with no way out except typing a
// search into a dropdown that had nothing in it yet. The restored dealId
// (from localStorage's pp.position.<locationId>, which has no expiry) no
// longer resolved — won/lost/archived differently, deleted in GHL, or just
// stale — and DealHubTab's existing "land on a real deal, never empty"
// auto-select only guarded `!dealId`, never "dealId is set but dead".
//
// Mirrored from DealHubTab's catch handler rather than imported: the real
// effect needs React state and a live API client. The decision logic —
// which id to fall back to, and when to give up and show the error — is
// plain data, so it is tested as that.

import assert from 'node:assert/strict';

// Mirrors the catch branch added to DealHubTab's deal-load effect.
function fallbackFor(err, dealId, deals) {
  if (err.status !== 404) return { action: 'show-error', message: err.message };
  if (deals && deals.length > 0) {
    if (deals[0].id !== dealId) return { action: 'select', id: deals[0].id };
    // The "first" deal IS the one that just failed — a stale LIST, not a
    // stale dealId. Selecting it again would refire the same 404 forever.
    return { action: 'show-error', message: err.message };
  }
  return { action: 'fetch-first' };
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('deal hub 404 fallback');

t('a 404 on a restored dealId falls back to the first open deal', () => {
  const r = fallbackFor({ status: 404, message: 'Deal not found' }, 'dead-id', [{ id: 'd1' }, { id: 'd2' }]);
  assert.deepEqual(r, { action: 'select', id: 'd1' });
});

t('anything other than a 404 still shows the real error', () => {
  // A network failure or a 500 silently swapped for another deal would hide
  // a genuine problem rather than explain it.
  for (const status of [500, 401, undefined]) {
    const r = fallbackFor({ status, message: 'Something went wrong' }, 'x', [{ id: 'd1' }]);
    assert.equal(r.action, 'show-error');
  }
});

t('the deals list not having arrived yet triggers a fresh fetch, not a crash', () => {
  // Both effects fire in parallel on mount; this one can win the race.
  const r = fallbackFor({ status: 404 }, 'dead-id', []);
  assert.deepEqual(r, { action: 'fetch-first' });
  assert.deepEqual(fallbackFor({ status: 404 }, 'dead-id', null), { action: 'fetch-first' });
});

t('a stale LIST whose own first id already failed does not loop', () => {
  // The "first" deal IS the dead one — selecting it again would refire the
  // same 404 for ever rather than surface anything to the rep.
  const r = fallbackFor({ status: 404, message: 'Deal not found' }, 'd1', [{ id: 'd1' }]);
  assert.equal(r.action, 'show-error');
});

console.log(`\n${n} passed`);
