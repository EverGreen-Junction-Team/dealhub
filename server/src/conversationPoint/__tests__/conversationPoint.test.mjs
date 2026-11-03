// Pure-logic tests for Conversation Point: phone normalisation, the Allo
// normaliser + signature check, and the silence stats. No DB, no network.
//
//   npm run test:cp

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@localhost:5432/z';

const { toE164, digitTail, isWithheld } = await import('../../utils/phone.js');
const { allo } = await import('../providers/allo.js');
const { silenceStats } = await import('../transcriber.js');

test('toE164 handles UK national, E.164, 00-prefixed, brackets and withheld', () => {
  assert.equal(toE164('07700 900123'), '+447700900123');
  assert.equal(toE164('+44 (0) 7700 900123'), '+447700900123');
  assert.equal(toE164('+447700900123'), '+447700900123');
  assert.equal(toE164('00447700900123'), '+447700900123');
  assert.equal(toE164('447700900123'), '+447700900123');
  assert.equal(toE164('020 7123 4567'), '+442071234567');
  assert.equal(toE164('+33612345678'), '+33612345678');
  assert.equal(toE164('Anonymous'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164('204'), null);            // an extension, not a number
  assert.equal(isWithheld('withheld'), true);
});

test('digitTail is the last 10 digits regardless of formatting', () => {
  assert.equal(digitTail('+44 7700 900123'), '7700900123');
  assert.equal(digitTail('07700900123'), '7700900123');
  assert.equal(digitTail('12345'), null);
});

test('allo.parseEvent normalises the documented call.completed payload', () => {
  const payload = {
    topic: 'call.completed', version: '2.0', timestamp: '2025-03-15T14:45:00.000Z',
    data: {
      id: 'cll_2NfDKEm9sF8xK3pQr1Zt', from_number: '+447700900123', to: '+442071234567',
      type: 'INBOUND', result: 'ANSWERED', summary: 'ignored on purpose',
      recording_url: 'https://storage.withallo.com/recordings/abc123.mp3', duration: 184,
      user: { id: 'usr_1', email: 'Rep@Example.co.uk', name: 'Sam Rep' }
    }
  };
  const ev = allo.parseEvent(payload, { 'webhook-id': 'msg_1' });
  assert.equal(ev.kind, 'call_completed');
  assert.equal(ev.providerEventId, 'msg_1');
  assert.equal(ev.providerCallId, 'cll_2NfDKEm9sF8xK3pQr1Zt');
  const c = ev.call;
  assert.equal(c.direction, 'inbound');
  assert.equal(c.result, 'answered');
  assert.equal(c.customerNumber, '+447700900123');
  assert.equal(c.ourNumber, '+442071234567');
  assert.equal(c.recordingUrl, 'https://storage.withallo.com/recordings/abc123.mp3');
  assert.equal(c.durationSeconds, 184);
  assert.equal(c.providerUserId, 'usr_1');
  assert.equal(c.providerUserEmail, 'rep@example.co.uk');
  assert.equal(c.providerUserName, 'Sam Rep');
  assert.equal(c.raw.summary, 'ignored on purpose'); // kept in raw, never used
});

test('allo.parseEvent: outbound swaps customer/our, non-call topics are ignored', () => {
  const ev = allo.parseEvent({ topic: 'call.completed', data: { id: 'c2', from_number: '+442071234567', to: '07700900123', type: 'OUTBOUND', result: 'NO_ANSWER' } });
  assert.equal(ev.call.direction, 'outbound');
  assert.equal(ev.call.result, 'missed');
  assert.equal(ev.call.customerNumber, '+447700900123');
  assert.equal(ev.call.ourNumber, '+442071234567');
  assert.equal(ev.call.recordingUrl, null);
  assert.equal(allo.parseEvent({ topic: 'sms.received', data: { id: 's1' } }).kind, 'ignore');
  assert.equal(allo.parseEvent({ topic: 'call.answered', data: { id: 'c3', type: 'INBOUND' } }).kind, 'call_update');
});

test('allo.verifyWebhook accepts Standard Webhooks and plain HMAC signatures', () => {
  const secret = 'whsec_' + Buffer.from('topsecret').toString('base64');
  const body = JSON.stringify({ topic: 'call.completed', data: { id: 'c1' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from('topsecret')).update(`msg_1.${ts}.${body}`).digest('base64');
  const ok = allo.verifyWebhook({ rawBody: Buffer.from(body), secret, headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` } });
  assert.deepEqual(ok, { ok: true, method: 'standard-webhooks' });

  const plain = crypto.createHmac('sha256', 'plainsecret').update(body).digest('hex');
  const ok2 = allo.verifyWebhook({ rawBody: body, secret: 'plainsecret', headers: { 'webhook-signature': `sha256=${plain}` } });
  assert.deepEqual(ok2, { ok: true, method: 'hmac-body' });

  const bad = allo.verifyWebhook({ rawBody: body, secret: 'plainsecret', headers: { 'webhook-signature': 'nope' } });
  assert.equal(bad.ok, false);
  assert.equal(allo.verifyWebhook({ rawBody: body, secret: '', headers: {} }).method, 'no-secret');
  assert.equal(allo.verifyWebhook({ rawBody: body, secret: 'x', headers: {} }).method, 'missing-header');
});

test('silenceStats counts gaps over the threshold and talk per speaker', () => {
  const s = silenceStats([
    { speaker: 'rep', start: 0, end: 4, text: 'hi' },
    { speaker: 'customer', start: 4.5, end: 10, text: 'hello' },
    { speaker: 'rep', start: 13, end: 20, text: 'so' },       // 3s gap
    { speaker: 'customer', start: 25, end: 26, text: 'ok' }   // 5s gap
  ]);
  assert.equal(s.gaps, 2);
  assert.equal(s.silence_seconds, 8);
  assert.equal(s.longest_gap_seconds, 5);
  assert.equal(s.talk_seconds_by_speaker.rep, 11);
  assert.equal(s.talk_seconds_by_speaker.customer, 6.5);
  assert.ok(Math.abs(s.talk_ratio.rep + s.talk_ratio.customer - 1) < 0.01);
});
