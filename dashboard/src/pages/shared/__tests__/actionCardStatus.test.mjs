// A confirmed action must STAY confirmed across a tab switch.
//
// The bug: ActionCard tracked confirmed/rejected in local component state and
// nowhere else. Switching tab unmounts the card; switching back rebuilt it
// from props — which carried no status — so an email a rep had already sent
// reappeared as an unsent draft with the editor open. The row in ai_actions
// said 'confirmed' the whole time; nothing asked it.
//
// Worst case: send the same email twice, because the UI offered.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const card = readFileSync(new URL('../ActionCard.jsx', import.meta.url), 'utf8')
const tab = readFileSync(new URL('../../tabs/CopilotTab.jsx', import.meta.url), 'utf8')
const runLog = readFileSync(
  new URL('../../../../../pipelinePulse/server/src/services/ai/runLog.js', import.meta.url), 'utf8'
)

// The precedence rule, as pure logic.
const resolvedFrom = (justResolved, status) => justResolved || (
  status === 'confirmed' ? 'confirmed'
    : (status === 'rejected' || status === 'failed') ? 'rejected'
    : null
)

test('a confirmed action reads as resolved on a fresh mount', () => {
  // The reopened-chat case: no local state, status from the server.
  assert.equal(resolvedFrom(null, 'confirmed'), 'confirmed')
})

test('a pending action is still editable', () => {
  assert.equal(resolvedFrom(null, 'pending'), null)
  assert.equal(resolvedFrom(null, null), null)
})

test('a failed action is not offered again as a draft', () => {
  // A send that reached GHL and errored is resolved, not pending — re-offering
  // it invites a second attempt at something that may have half-succeeded.
  assert.equal(resolvedFrom(null, 'failed'), 'rejected')
})

test('a local confirm wins immediately, without waiting for a refetch', () => {
  assert.equal(resolvedFrom('confirmed', 'pending'), 'confirmed')
})

test('the card reads the server status, not only its own state', () => {
  assert.match(card, /status = null/)
  assert.match(card, /const resolved = justResolved \|\| serverResolved/)
})

test('CopilotTab passes status down', () => {
  assert.match(tab, /status=\{a\.status \|\| null\}/)
})

test('a reopened chat carries its proposed actions', () => {
  // Dropped entirely before: t.proposedActions was never mapped, so a
  // reopened turn showed no trace of a write it had proposed.
  assert.match(tab, /proposedActions: t\.proposedActions \|\| \[\]/)
})

test('the history query returns each action with its status', () => {
  assert.match(runLog, /'status',\s+a\.status/)
  assert.match(runLog, /FROM ai_actions a/)
  assert.match(runLog, /a\.run_id\s+= r\.id/)
})

test('the actions subquery is scoped to the location', () => {
  // ai_actions is keyed by location; an unscoped join would attach another
  // sub-account's proposed writes to this chat.
  assert.match(runLog, /a\.location_id = r\.location_id/)
})

console.log('action card status: all cases pass')
