// Tests for services/outcomeReason.js — the status -> reason field mapping.
//
// Run: node src/services/__tests__/outcomeReason.test.mjs
//
// This mapping is worth testing precisely because it looks trivial and is not
// guessable: lost is 9, won is 10, abandoned is 11. Nothing about a status
// name implies its number, so a transposition (the win reason written into
// the lost field) is silent — GHL accepts it, the deal saves, and the
// reporting view then reads a win reason as a loss reason for ever.

import {
  OUTCOME_REASON_FIELD, outcomeReasonKey, outcomeReasonFor, CLOSED_STATUSES
} from '../outcomeReason.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── The mapping itself, spelled out ──────────────────────────────────
// Written as literals, NOT derived from the module, so a change to the
// source has to be made here too rather than silently agreeing with itself.
t('lost      -> meddic_9',  OUTCOME_REASON_FIELD.lost === 'meddic_9');
t('won       -> meddic_10', OUTCOME_REASON_FIELD.won === 'meddic_10');
t('abandoned -> meddic_11', OUTCOME_REASON_FIELD.abandoned === 'meddic_11');

t('no two statuses share a field',
  new Set(Object.values(OUTCOME_REASON_FIELD)).size ===
  Object.keys(OUTCOME_REASON_FIELD).length);

t('open has no reason field', !('open' in OUTCOME_REASON_FIELD));

// ── Keys are fully qualified ─────────────────────────────────────────
// The definitions table stores 'opportunity.meddic_11'; a bare 'meddic_11'
// matches nothing and the write silently no-ops.
t('key is prefixed with the object type',
  outcomeReasonKey('abandoned') === 'opportunity.meddic_11');
t('won key',  outcomeReasonKey('won')  === 'opportunity.meddic_10');
t('lost key', outcomeReasonKey('lost') === 'opportunity.meddic_9');

t('an open deal has no key', outcomeReasonKey('open') === null);
t('an unknown status has no key', outcomeReasonKey('zzz') === null);
t('undefined is handled', outcomeReasonKey(undefined) === null);

// ── Case and whitespace ──────────────────────────────────────────────
// GHL and our own UI have both sent 'Won' and 'won'.
t('status is case-insensitive', outcomeReasonKey('WON') === 'opportunity.meddic_10');
t('mixed case', outcomeReasonKey('Abandoned') === 'opportunity.meddic_11');

// ── Reading a reason off a row ───────────────────────────────────────
t('reads the field its status points at',
  outcomeReasonFor({ status: 'abandoned', meddic_11: 'Client went quiet' })
    === 'Client went quiet');

t('IGNORES the other outcome fields',
  // A deal can carry a stale reason from an earlier outcome — a deal marked
  // lost, reopened, then won keeps meddic_9. Only the field matching the
  // CURRENT status may be read.
  outcomeReasonFor({ status: 'won', meddic_9: 'Went elsewhere', meddic_10: 'Best price' })
    === 'Best price');

t('a stale reason alone reads as no reason',
  outcomeReasonFor({ status: 'won', meddic_9: 'Went elsewhere' }) === null);

t('an open deal has no reason even when a field is populated',
  outcomeReasonFor({ status: 'open', meddic_10: 'Best price' }) === null);

t('blank is null, not an empty string',
  outcomeReasonFor({ status: 'won', meddic_10: '   ' }) === null);
t('a reason is trimmed',
  outcomeReasonFor({ status: 'won', meddic_10: '  Best price  ' }) === 'Best price');

t('a missing row is null', outcomeReasonFor(null) === null);
t('a row with no status is null', outcomeReasonFor({ meddic_10: 'x' }) === null);

// ── CLOSED_STATUSES drives the "reason required" check ───────────────
t('open is not a closed status', !CLOSED_STATUSES.includes('open'));
t('all three outcomes are closed statuses',
  ['won', 'lost', 'abandoned'].every((s) => CLOSED_STATUSES.includes(s)));
t('exactly three', CLOSED_STATUSES.length === 3);

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
