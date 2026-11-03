// Tests for classifyError — services/ai/claudeClient.js
//
// Run: node src/services/ai/__tests__/errorClassify.test.mjs
//
// The case this exists for: an exhausted credit balance arrives as a plain
// 400 invalid_request_error, which looked identical to a malformed prompt.
// It was classified api_error, isRetryable() said "try again", and the UI
// told reps to retry something that could never succeed until the account
// was topped up. Seen in production 2026-09-25.

import assert from 'node:assert';

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough';

const { classifyError, isRetryable } = await import('../claudeClient.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// The verbatim error body from the production log.
const creditErr = new Error(
  '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"Your credit balance is too low to access the Anthropic API. Please go to ' +
  'Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CfPz73mSmKtLxeMmUuzEA"}'
);
creditErr.status = 400;

t('the real production error is no_credit', () => {
  assert.equal(classifyError(creditErr), 'no_credit');
});

t('no_credit is NOT retryable', () => {
  // The whole point: retrying a billing failure cannot work.
  assert.equal(isRetryable('no_credit'), false);
});

t('an unrelated 400 is still api_error', () => {
  const e = new Error('400 {"error":{"message":"messages: at least one message is required"}}');
  e.status = 400;
  assert.equal(classifyError(e), 'api_error');
});

t('a non-400 mentioning credit is not misclassified', () => {
  // Matching on message alone would make any 500 that happens to quote the
  // phrase look like a billing problem.
  const e = new Error('upstream said: credit balance is too low');
  e.status = 500;
  assert.equal(classifyError(e), 'api_error');
});

t('an unconfigured key is still api_error', () => {
  const e = new Error('ANTHROPIC_API_KEY is not configured');
  e.code = 'AI_NOT_CONFIGURED';
  assert.equal(classifyError(e), 'api_error');
});

t('timeout and rate_limited remain retryable', () => {
  assert.ok(isRetryable('timeout'));
  assert.ok(isRetryable('rate_limited'));
  assert.ok(isRetryable('api_error'));
});

console.log(`\n${n} passed, 0 failed`);
