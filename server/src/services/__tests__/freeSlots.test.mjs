import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSlots, slotWindow } from '../freeSlots.js';

test('slots from every date key, sorted, other keys ignored', () => {
  const got = pickSlots({
    '2026-12-01': { slots: ['2026-12-01T10:30:00+00:00', '2026-12-01T09:00:00+00:00'] },
    traceId: 'abc'
  });
  assert.deepEqual(got, ['2026-12-01T09:00:00+00:00', '2026-12-01T10:30:00+00:00']);
});

test('a date with no free slots is simply absent — not an error', () => {
  assert.deepEqual(pickSlots({ traceId: 'abc' }), []);
  assert.deepEqual(pickSlots(null), []);
  assert.deepEqual(pickSlots('nonsense'), []);
});

test('junk inside slots is dropped, not passed to the card', () => {
  assert.deepEqual(pickSlots({ '2026-12-01': { slots: ['not a time', 42, '2026-12-01T09:00:00Z'] } }), ['2026-12-01T09:00:00Z']);
});

test('the window is epoch ms, end after start, at most 31 days', () => {
  assert.deepEqual(slotWindow('2026-12-01T00:00:00Z', '2026-12-02T00:00:00Z'), { startDate: 1796083200000, endDate: 1796169600000 });
  assert.equal(slotWindow('2026-12-02T00:00:00Z', '2026-12-01T00:00:00Z'), null);
  assert.equal(slotWindow('x', 'y'), null);
  assert.equal(slotWindow('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'), null);
});
