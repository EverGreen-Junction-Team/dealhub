import test from 'node:test'
import assert from 'node:assert/strict'
import { overlayPending, PENDING_TTL_MS } from '../pendingWrites.js'

// The board reloaded from our database straight after every write, before
// GHL's webhook had updated our row — so accepted moves snapped back and
// accepted statuses never appeared. Found on the live board.

const stale = { id: 'A', startsAt: '2026-12-01T14:15:00.000Z', endsAt: '2026-12-01T14:45:00.000Z', status: 'confirmed', assignedUserId: 'u1' }

test('an accepted move survives a reload that returns the old row', () => {
  const pending = new Map([['A', { at: Date.now(), fields: { startsAt: '2026-12-03T16:00:00+00:00', endsAt: '2026-12-03T16:30:00+00:00' } }]])
  const [a] = overlayPending([stale], pending)
  assert.equal(a.startsAt, '2026-12-03T16:00:00+00:00')
  assert.equal(pending.size, 1, 'dropped before the webhook landed')
})

test('it settles once the server agrees, even in a different ISO spelling', () => {
  const pending = new Map([['A', { at: Date.now(), fields: { startsAt: '2026-12-03T16:00:00+00:00', endsAt: '2026-12-03T16:30:00+00:00' } }]])
  const fresh = { ...stale, startsAt: '2026-12-03T16:00:00.000Z', endsAt: '2026-12-03T16:30:00.000Z' }
  const [a] = overlayPending([fresh], pending)
  assert.equal(a, fresh, 'the server row is used as-is once it agrees')
  assert.equal(pending.size, 0)
})

test('an accepted status shows until the row catches up', () => {
  const pending = new Map([['A', { at: Date.now(), fields: { status: 'cancelled' } }]])
  assert.equal(overlayPending([stale], pending)[0].status, 'cancelled')
  assert.equal(overlayPending([{ ...stale, status: 'cancelled' }], pending)[0].status, 'cancelled')
  assert.equal(pending.size, 0)
})

test('a reassignment settles on the id, not on the name we filled in', () => {
  const pending = new Map([['A', { at: Date.now(), fields: { assignedUserId: 'u2', assignedUserName: 'Local guess' } }]])
  const fresh = { ...stale, assignedUserId: 'u2', assignedUserName: 'Server Name' }
  const [a] = overlayPending([fresh], pending)
  assert.equal(a.assignedUserName, 'Server Name')
  assert.equal(pending.size, 0)
})

test('it never lies forever: expired entries are dropped', () => {
  const pending = new Map([['A', { at: Date.now() - PENDING_TTL_MS - 1, fields: { status: 'cancelled' } }]])
  assert.equal(overlayPending([stale], pending)[0].status, 'confirmed')
  assert.equal(pending.size, 0)
})

test('untouched appointments pass through unchanged', () => {
  const other = { id: 'B', status: 'confirmed' }
  const pending = new Map([['A', { at: Date.now(), fields: { status: 'cancelled' } }]])
  assert.equal(overlayPending([other], pending)[0], other)
})
