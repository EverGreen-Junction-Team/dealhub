// cpAlloRegisterWebhook.js — create (or list / delete) the Allo webhook for
// one location.
//
//   npm run cp:allo:register-webhook -- --location <locationId>
//   npm run cp:allo:register-webhook -- --location <locationId> --list
//   npm run cp:allo:register-webhook -- --location <locationId> --delete <webhookId>
//
// Uses the location's call_providers.api_key, else ALLO_API_KEY from .env.
// The URL registered is PUBLIC_BASE_URL/webhooks/calls/allo/<locationId>.
// If Allo returns a signing secret on create it is stored on the row.

import { config } from '../config.js';
import { pool } from '../db.js';
import { getProvider } from '../conversationPoint/providers/index.js';
import { getProviderConfig, upsertProviderConfig } from '../conversationPoint/providerConfig.js';

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const locationId = arg('location');
  if (!locationId) throw new Error('--location <locationId> is required');
  const provider = getProvider('allo');
  const cfg = await getProviderConfig(locationId, 'allo');
  const api = provider.api(cfg);

  if (flag('list')) {
    console.log(JSON.stringify(await api.listWebhooks(), null, 2));
    return;
  }
  const del = arg('delete');
  if (del) {
    console.log(JSON.stringify(await api.deleteWebhook(del), null, 2));
    return;
  }

  const url = `${config.publicBaseUrl.replace(/\/$/, '')}/webhooks/calls/allo/${locationId}`;
  console.log(`Registering ${url} for topics ${provider.webhookTopics.join(', ')}`);
  const created = await api.createWebhook(url, provider.webhookTopics);
  console.log(JSON.stringify(created, null, 2));
  const webhookId = created?.id || created?.data?.id || null;
  const secret = created?.secret || created?.data?.secret || created?.signing_secret || null;
  await upsertProviderConfig(locationId, 'allo', { webhookId, webhookSecret: secret || undefined });
  console.log(secret
    ? 'Signing secret stored on call_providers.'
    : 'No secret in the response — copy it from the Allo dashboard into call_providers.webhook_secret (or ALLO_WEBHOOK_SECRET).');
}

main()
  .catch((err) => { console.error(err.message, err.body || ''); process.exitCode = 1; })
  .finally(() => pool.end());
