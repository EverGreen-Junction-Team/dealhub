// Tests for utils/outcomeReason.js — the dashboard's half of the mapping.
//
// Run: node src/pages/__tests__/outcomeReason.test.mjs
//
// The server owns status -> GHL field. What is asserted here is the UI
// contract that sits on top of it: which statuses demand a reason, and that
// every one of them has wording to ask with. A status added to CLOSING_STATUSES
// without a label renders a dialog with an empty heading.

import {
  CLOSING_STATUSES, REASON_LABEL, REASON_PLACEHOLDER, STATUS_VERB
} from '../../utils/outcomeReason.js'

let pass = 0
const failures = []
const t = (name, cond) => { cond ? pass++ : failures.push(name) }

// ── Which statuses close a deal ──────────────────────────────────────
t('won, lost and abandoned all close a deal',
  ['won', 'lost', 'abandoned'].every((s) => CLOSING_STATUSES.includes(s)))
t('open does NOT — there is no outcome to explain',
  !CLOSING_STATUSES.includes('open'))
t('exactly three closing statuses', CLOSING_STATUSES.length === 3)

// ── Every closing status can be asked about ──────────────────────────
// The dialog's heading and placeholder are looked up by status. A missing
// entry renders a blank heading above a box with no hint of what to type.
for (const s of CLOSING_STATUSES) {
  t(`${s} has a question`, typeof REASON_LABEL[s] === 'string' && REASON_LABEL[s].length > 0)
  t(`${s} has a placeholder`,
    typeof REASON_PLACEHOLDER[s] === 'string' && REASON_PLACEHOLDER[s].length > 0)
  t(`${s}'s question is a question`, REASON_LABEL[s].trim().endsWith('?'))
}

// Open must NOT have one — its presence would mean someone intended to ask.
t('open has no question', !(  'open' in REASON_LABEL))

// ── The questions are distinct ───────────────────────────────────────
// "Why was this deal closed?" three times over would make the dialog
// ambiguous about which outcome is being recorded.
t('each outcome asks its own question',
  new Set(CLOSING_STATUSES.map((s) => REASON_LABEL[s])).size === CLOSING_STATUSES.length)

// ── Confirmation wording ─────────────────────────────────────────────
t('every status has a verb, including open',
  ['won', 'lost', 'abandoned', 'open'].every((s) => typeof STATUS_VERB[s] === 'string'))
t('open reads as reopened, not "opened"', STATUS_VERB.open === 'reopened')

console.log(`${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
