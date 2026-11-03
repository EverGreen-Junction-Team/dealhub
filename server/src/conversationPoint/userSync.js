// userSync.js — provider users → call_user_map, automatically, by email.
//
// Every provider has a users list with emails. GHL users have emails. Where
// they agree we write an 'auto' row keyed on the provider's user id (and on
// the extension / number when the provider exposes them), so a call that
// names the answering user resolves to a GHL rep with no setup. Manual rows
// are never overwritten.

import { rawQuery } from '../db.js';
import { getProvider } from './providers/index.js';
import { getProviderConfig } from './providerConfig.js';
import { toE164 } from '../utils/phone.js';
import { logger } from '../utils/logger.js';

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}

export async function syncProviderUsers(locationId, providerName) {
  const provider = getProvider(providerName);
  const cfg = await getProviderConfig(locationId, providerName);
  const remote = await provider.api(cfg).listUsers();

  const { rows: ghlUsers } = await rawQuery(
    `SELECT user_id, name, lower(email) AS email FROM users
      WHERE location_id = $1 AND email IS NOT NULL AND active IS DISTINCT FROM false`,
    [locationId]
  );
  const byEmail = new Map(ghlUsers.map((u) => [u.email, u]));

  let matched = 0; let unmatched = []; let written = 0;
  for (const ru of remote) {
    const id = pick(ru, ['id', 'user_id', 'uuid']);
    const email = String(pick(ru, ['email', 'email_address']) || '').toLowerCase();
    const name = pick(ru, ['name', 'full_name', 'display_name'])
      || [pick(ru, ['first_name']), pick(ru, ['last_name'])].filter(Boolean).join(' ') || null;
    const ext = pick(ru, ['extension', 'ext', 'line', 'short_number']);
    const number = pick(ru, ['phone_number', 'number', 'direct_number', 'phone']);
    const ghl = email ? byEmail.get(email) : null;
    if (!ghl) { unmatched.push({ id, email: email || null, name }); continue; }
    matched++;
    const keys = [];
    if (id) keys.push(['user', String(id)]);
    if (email) keys.push(['email', email]);
    if (ext) keys.push(['extension', String(ext)]);
    const e164 = toE164(number, { defaultCountry: cfg.settings.defaultCountry });
    if (e164) keys.push(['number', e164]);
    for (const [keyType, key] of keys) {
      const { rowCount } = await rawQuery(
        `INSERT INTO call_user_map (location_id, provider, key_type, key, user_id, user_name, source)
         VALUES ($1,$2,$3,$4,$5,$6,'auto')
         ON CONFLICT (location_id, provider, key_type, key) DO UPDATE SET
           user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, updated_at = now()
         WHERE call_user_map.source = 'auto'`,
        [locationId, providerName, keyType, key, ghl.user_id, ghl.name || name]
      );
      written += rowCount;
    }
  }
  logger.info({ locationId, providerName, remote: remote.length, matched, unmatched: unmatched.length, written },
    'conversationPoint: provider users synced');
  return { remote: remote.length, matched, unmatched, written };
}
