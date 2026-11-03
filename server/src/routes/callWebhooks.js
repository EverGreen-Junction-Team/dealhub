// /webhooks/calls/:provider/:locationId — inbound call events from a phone
// provider. Mounted with the raw-body JSON parser (see index.js) so the
// signature can be checked over the exact bytes.
//
// The location id is in the path because a provider webhook carries no GHL
// identity: the URL we register with the provider IS the tenant binding.
//
// Signature policy: verified → 200. Unverifiable → 401 in production, 200
// with signature_ok=false in development (so a local tunnel + a Postman
// replay works without the secret). Always 200 for a duplicate.

import express from 'express';
import { config } from '../config.js';
import { getProvider } from '../conversationPoint/providers/index.js';
import { getProviderConfig } from '../conversationPoint/providerConfig.js';
import { ingestWebhook } from '../conversationPoint/ingest.js';
import { logger } from '../utils/logger.js';

export const callWebhooksRouter = express.Router();

const KEEP_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'content-type', 'user-agent',
  'x-webhook-signature', 'x-allo-signature', 'x-request-id'];

callWebhooksRouter.post('/:provider/:locationId', async (req, res) => {
  const { provider: providerName, locationId } = req.params;
  let provider;
  try { provider = getProvider(providerName); } catch { return res.status(404).json({ error: 'unknown provider' }); }

  const cfg = await getProviderConfig(locationId, providerName);
  if (!cfg.enabled) return res.status(200).json({ ok: true, ignored: 'provider disabled' });

  const headers = {};
  for (const k of KEEP_HEADERS) if (req.headers[k]) headers[k] = req.headers[k];

  const verdict = provider.verifyWebhook({ rawBody: req.rawBody, headers: req.headers, secret: cfg.webhookSecret });
  if (!verdict.ok) {
    const isProd = config.nodeEnv === 'production';
    logger.warn({ provider: providerName, locationId, method: verdict.method, prod: isProd },
      'call webhook: signature not verified');
    if (isProd && verdict.method !== 'no-secret') {
      return res.status(401).json({ error: 'signature verification failed' });
    }
    if (isProd && verdict.method === 'no-secret') {
      return res.status(401).json({ error: 'webhook secret not configured for this location' });
    }
  }

  try {
    const r = await ingestWebhook({
      provider: providerName, locationId, payload: req.body, headers, signatureOk: verdict.ok
    });
    return res.status(200).json({ ok: true, duplicate: r.duplicate, callId: r.callId, kind: r.kind });
  } catch (err) {
    logger.error({ err, provider: providerName, locationId }, 'call webhook: ingest failed');
    // 500 so the provider retries — the raw event is already stored, and the
    // dedup key makes the retry harmless if it was a transient DB error.
    return res.status(500).json({ error: 'ingest failed' });
  }
});
