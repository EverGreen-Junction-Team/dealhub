// providerConfig.js — which credentials apply to (location, provider).
//
// A call_providers row is the normal case (set from the dashboard or the
// admin route). The env-level ALLO_* values are a fallback so a single-tenant
// pilot works with nothing but .env — they are never written to the DB.

import { rawQuery } from '../db.js';
import { config } from '../config.js';

export async function getProviderConfig(locationId, provider) {
  const { rows } = await rawQuery(
    `SELECT location_id, provider, enabled, api_key, webhook_secret, provider_account_id,
            webhook_id, settings, created_at, updated_at
       FROM call_providers WHERE location_id = $1 AND provider = $2`,
    [locationId, provider]
  );
  const row = rows[0] || null;
  const env = config.conversationPoint[provider] || {};
  const settings = row?.settings || {};
  return {
    locationId,
    provider,
    exists: !!row,
    enabled: row ? row.enabled !== false : true,
    apiKey: row?.api_key || env.apiKey || '',
    webhookSecret: row?.webhook_secret || env.webhookSecret || '',
    apiBaseUrl: settings.api_base_url || env.apiBaseUrl || undefined,
    providerAccountId: row?.provider_account_id || null,
    webhookId: row?.webhook_id || null,
    settings: {
      defaultCountry: settings.default_country || config.conversationPoint.defaultCountry,
      repChannel: settings.rep_channel || null,          // 'left' | 'right' | null
      ourNumbers: Array.isArray(settings.our_numbers) ? settings.our_numbers : [],
      ...settings
    }
  };
}

export async function upsertProviderConfig(locationId, provider, {
  enabled, apiKey, webhookSecret, providerAccountId, webhookId, settings
} = {}) {
  const { rows } = await rawQuery(
    `INSERT INTO call_providers
       (location_id, provider, enabled, api_key, webhook_secret, provider_account_id, webhook_id, settings)
     VALUES ($1,$2, COALESCE($3, true), $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb))
     ON CONFLICT (location_id, provider) DO UPDATE SET
       enabled             = COALESCE($3, call_providers.enabled),
       api_key             = COALESCE($4, call_providers.api_key),
       webhook_secret      = COALESCE($5, call_providers.webhook_secret),
       provider_account_id = COALESCE($6, call_providers.provider_account_id),
       webhook_id          = COALESCE($7, call_providers.webhook_id),
       settings            = call_providers.settings || COALESCE($8::jsonb, '{}'::jsonb),
       updated_at          = now()
     RETURNING location_id, provider, enabled, provider_account_id, webhook_id, settings,
               (api_key IS NOT NULL) AS has_api_key, (webhook_secret IS NOT NULL) AS has_webhook_secret`,
    [locationId, provider,
     typeof enabled === 'boolean' ? enabled : null,
     apiKey || null, webhookSecret || null, providerAccountId || null, webhookId || null,
     settings ? JSON.stringify(settings) : null]
  );
  return rows[0];
}

export async function listProviderConfigs(locationId) {
  const { rows } = await rawQuery(
    `SELECT location_id, provider, enabled, provider_account_id, webhook_id, settings, updated_at,
            (api_key IS NOT NULL) AS has_api_key, (webhook_secret IS NOT NULL) AS has_webhook_secret
       FROM call_providers WHERE location_id = $1 ORDER BY provider`,
    [locationId]
  );
  return rows;
}
