// tokenVault.js — the GHL refresh token lives in Supabase Vault, not in a
// column.
//
// WHY ONLY THE REFRESH TOKEN. The access token is ~24h and is read on every
// GHL API call; the refresh token is indefinite (our own refresh keeps the old
// value when GHL does not return a new one) and is read about once a day per
// location. Vaulting the indefinite one removes the credential that matters
// without putting a decrypt on the hot path. See migration 063 for the full
// reasoning.
//
// EVERY FUNCTION HERE TAKES A CLIENT. The refresh path already runs inside a
// transaction holding an advisory lock per location (withLocationLock in
// ghlClient), and the read-modify-write of a token has to stay inside it —
// otherwise two workers refreshing at once can each write a secret and one
// ends up orphaned, holding a token GHL has already superseded.

import { logger } from '../utils/logger.js';

/**
 * Read the refresh token for an install.
 *
 * Returns null when there is no secret — an uninstalled row, or a row this
 * migration has not reached. The caller decides what that means; for a
 * refresh it is fatal, so it throws there rather than here.
 */
export async function readRefreshToken(client, install) {
  if (!install?.refresh_token_secret_id) return null;
  const { rows } = await client.query(
    // decrypted_secrets is a VIEW over vault.secrets. Reading it is a grant
    // like any other — migration 063 revokes it from PUBLIC and from the
    // analyst role, because Vault protects against a leak of the `installs`
    // table, not against a role that can read the view.
    `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = $1`,
    [install.refresh_token_secret_id]
  );
  const token = rows[0]?.decrypted_secret || null;
  if (!token) {
    // The reference exists but the secret does not. Worth a loud log: it means
    // someone deleted the secret out from under us, and the install is now
    // unrecoverable without a reinstall.
    logger.error(
      { locationId: install.location_id, secretId: install.refresh_token_secret_id },
      'tokenVault: install references a vault secret that does not exist'
    );
  }
  return token;
}

/**
 * Store a refresh token, creating the secret on first write and updating it
 * afterwards.
 *
 * Returns the secret id, which the caller writes to installs on a create.
 *
 * UPDATE IN PLACE rather than create-and-swap: a new secret per refresh would
 * leave one dead row in vault.secrets per location per day, and nothing would
 * ever clean them up.
 */
export async function writeRefreshToken(client, install, token) {
  if (!token) {
    throw new Error('tokenVault: refusing to store an empty refresh token');
  }

  if (install?.refresh_token_secret_id) {
    await client.query(
      `SELECT vault.update_secret($1, $2)`,
      [install.refresh_token_secret_id, token]
    );
    return install.refresh_token_secret_id;
  }

  // Named per location so it is identifiable in the Vault UI without exposing
  // the value — the same naming migration 063 uses, so a token moved by the
  // migration and one written by a fresh install look alike.
  const { rows } = await client.query(
    `SELECT vault.create_secret($1, $2, $3) AS id`,
    [
      token,
      `ghl_refresh_token_${install.location_id}`,
      `GoHighLevel OAuth refresh token for sub-account ${install.location_id}`
    ]
  );
  return rows[0].id;
}

/**
 * Delete the secret for an install. Called on uninstall.
 *
 * Deleting rather than blanking: an uninstalled location's refresh token is
 * dead credentials, and keeping them serves nothing. The `installs` row stays
 * for its analytics history — only the secret goes.
 */
export async function deleteRefreshToken(client, install) {
  if (!install?.refresh_token_secret_id) return false;
  await client.query(
    `DELETE FROM vault.secrets WHERE id = $1`,
    [install.refresh_token_secret_id]
  );
  // Agency secrets are named company_<id> and live on agency_installs, which
  // clears its own column; only a real location row is updated here.
  if (!String(install.location_id || '').startsWith('company_')) {
    await client.query(
      `UPDATE installs SET refresh_token_secret_id = NULL WHERE location_id = $1`,
      [install.location_id]
    );
  }
  logger.info(
    { locationId: install.location_id },
    'tokenVault: refresh token secret deleted on uninstall'
  );
  return true;
}
