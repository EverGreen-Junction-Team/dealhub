import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from './logger.js';

// GHL signs webhook payloads over the *raw* request body. Two schemes exist:
//
//   • X-GHL-Signature  — Ed25519 (the current scheme). Preferred.
//   • X-WH-Signature    — RSA-SHA256 (legacy, deprecated by GHL on 2026-09-01).
//
// Per GHL's migration guidance, both headers may be present during the
// transition; we prefer X-GHL-Signature whenever it's available and only fall
// back to the legacy RSA header when the new one is absent. After 2026-09-01
// GHL sends only X-GHL-Signature, so the fallback becomes dead but harmless.
//
// Every function returns true/false and NEVER throws — a verification failure
// is a "reject the webhook" decision, not a crash.

// Ed25519 verification of X-GHL-Signature (base64) against the raw body.
function verifyEd25519(req) {
  const sig = req.get('x-ghl-signature');
  if (!sig) return null; // signal "not applicable" so caller can try legacy

  if (!config.ghl.webhookEd25519PublicKey) {
    if (config.nodeEnv === 'production') {
      logger.error('webhook: GHL_WEBHOOK_ED25519_PUBLIC_KEY not configured — rejecting');
      return false;
    }
    logger.warn('webhook: GHL_WEBHOOK_ED25519_PUBLIC_KEY not configured — allowing in dev mode');
    return true;
  }
  if (!req.rawBody) {
    logger.error('webhook: rawBody missing — express.json verify hook not wired');
    return false;
  }
  try {
    const publicKey = crypto.createPublicKey(config.ghl.webhookEd25519PublicKey);
    // Ed25519 uses no separate digest algorithm — pass null.
    return crypto.verify(null, req.rawBody, publicKey, Buffer.from(sig, 'base64'));
  } catch (err) {
    logger.error({ err }, 'webhook: Ed25519 signature verification threw');
    return false;
  }
}

// Legacy RSA-SHA256 verification of X-WH-Signature (base64) against the raw body.
function verifyRsa(req) {
  const sig = req.get('x-wh-signature');
  if (!sig) return null;

  if (!config.ghl.webhookPublicKey) {
    if (config.nodeEnv === 'production') {
      logger.error('webhook: GHL_WEBHOOK_PUBLIC_KEY not configured — rejecting');
      return false;
    }
    logger.warn('webhook: GHL_WEBHOOK_PUBLIC_KEY not configured — allowing in dev mode');
    return true;
  }
  if (!req.rawBody) {
    logger.error('webhook: rawBody missing — express.json verify hook not wired');
    return false;
  }
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(req.rawBody);
    verifier.end();
    return verifier.verify(config.ghl.webhookPublicKey, sig, 'base64');
  } catch (err) {
    logger.error({ err }, 'webhook: RSA signature verification threw');
    return false;
  }
}

// Verify a GHL webhook. Prefers Ed25519 (X-GHL-Signature); falls back to the
// legacy RSA header only when no Ed25519 signature is present.
export function verifyGhlWebhook(req) {
  const ed = verifyEd25519(req);
  if (ed !== null) return ed; // X-GHL-Signature present → its result is authoritative

  const rsa = verifyRsa(req);
  if (rsa !== null) return rsa;

  // Neither header present.
  logger.warn('webhook: no signature header (x-ghl-signature or x-wh-signature)');
  return false;
}
