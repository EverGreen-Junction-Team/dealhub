// providers/index.js — the connector registry.
//
// Conversation Point is provider-agnostic: everything after this file works
// on the normalised call shape (see normalise.js). A connector's job is only
// to turn the provider's webhook / API into that shape, verify its
// signatures, and fetch audio. Adding a provider = adding one file here.
//
// Connector contract:
//   name                       'allo'
//   webhookTopics              topics to subscribe to when we register
//   verifyWebhook({ rawBody, headers, secret }) → { ok, method }
//   parseEvent(payload, headers) → { providerEventId, topic, providerCallId,
//                                    kind: 'call_completed'|'call_update'|'ignore',
//                                    call: <partial normalised call> | null }
//   fetchRecording(url, creds)  → { buffer, contentType }
//   api(creds)                  → { listUsers, listNumbers, listCalls,
//                                   createWebhook, listWebhooks, deleteWebhook }

import { allo } from './allo.js';

const REGISTRY = new Map([[allo.name, allo]]);

export function getProvider(name) {
  const p = REGISTRY.get(String(name || '').toLowerCase());
  if (!p) {
    const err = new Error(`Unknown call provider: ${name}`);
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  return p;
}

export function listProviders() {
  return [...REGISTRY.keys()];
}
