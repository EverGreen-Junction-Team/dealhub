// Webhook payloads never reach the log whole — they are archived in ghl_raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';
const { slimEvent } = await import('../logger.js');

const big = {
  type: 'ContactUpdate', webhookId: 'wh1', id: 'c1', locationId: 'L1',
  email: 'someone@example.com', phone: '+440000', customFields: [{ id: 'x', value: 'y'.repeat(5000) }]
};

test('an event is logged as its type, ids and field names — not its contents', () => {
  const s = slimEvent(big);
  assert.deepEqual(s, {
    type: 'ContactUpdate', webhookId: 'wh1', id: 'c1', locationId: 'L1',
    keys: ['type', 'webhookId', 'id', 'locationId', 'email', 'phone', 'customFields']
  });
  assert.ok(!JSON.stringify(s).includes('someone@example.com'));
  assert.ok(JSON.stringify(s).length < 300);
});

test('odd inputs pass through rather than throw', () => {
  assert.equal(slimEvent(null), null);
  assert.equal(slimEvent('x'), 'x');
  assert.deepEqual(slimEvent({}), { keys: [] });
});

test('the logger summarises `event` and `payload` fields', () => {
  const src = readFileSync(new URL('../logger.js', import.meta.url), 'utf8');
  assert.match(src, /event: slimEvent,\s*\n\s*payload: slimEvent/);
});

test('the webhook route no longer logs every payload', () => {
  const src = readFileSync(new URL('../../routes/webhooks.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /raw payload received/);
  assert.doesNotMatch(src, /payload: event/);
});
