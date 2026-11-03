import axios from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config.js';
import { rawQuery, pool } from '../db.js';
import { logger } from '../utils/logger.js';
import {
  readRefreshToken, writeRefreshToken, deleteRefreshToken
} from './tokenVault.js';

// GHL access tokens live ~24h. Refresh proactively when within this window
// of expiry, rather than waiting for the inevitable 401.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const ghlAxios = axios.create({
  baseURL: config.ghl.apiBaseUrl,
  timeout: 15_000
});

axiosRetry(ghlAxios, {
  retries: 3,
  retryDelay: (retryCount, err) => {
    // GHL sends Retry-After on 429 — honour it when present.
    const retryAfter = err.response?.headers?.['retry-after'];
    if (retryAfter) {
      const ms = parseInt(retryAfter, 10) * 1000;
      if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 10_000);
    }
    return axiosRetry.exponentialDelay(retryCount);
  },
  retryCondition: (err) => {
    if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
    const status = err.response?.status;
    return status === 429 || (status >= 500 && status < 600);
  }
});

// ------------------------------------------------------- install storage

export async function getActiveInstall(locationId, { allowDead = false } = {}) {
  const { rows } = await rawQuery(
    `SELECT location_id, company_id, user_type, access_token,
            refresh_token_secret_id, token_expires_at, scopes, installed_at,
            tracking_started_at, reinstalled_at, uninstalled_at,
            reauth_required_at, token_source
       FROM installs
      WHERE location_id = $1 AND uninstalled_at IS NULL`,
    [locationId]
  );
  const install = rows[0] || null;
  if (!install) return null;

  // A DEAD install is not an active one.
  //
  // reauth_required_at is set when the refresh_token itself is rejected — the
  // install needs a human to reinstall in the GHL marketplace, and no amount
  // of retrying fixes it. This filter was missing and the column was not even
  // selected, so every caller treated a dead install as usable.
  //
  // The cost was real work, not just a wasted call: ghlRequest does a
  // proactive refresh, gets a 401, forces ANOTHER refresh, then retries — so
  // one doomed request became three round trips. A daily cron across a dead
  // location did that for every page of every entity.
  //
  // Only two of the ten syncs filtered this themselves (callRecordingSync and
  // conversationProvidersSync, added after the tasksSync incident). Doing it
  // here covers all 27 call sites instead of asking each to remember.
  //
  // allowDead is for the paths that must see a dead install to act on it —
  // the OAuth callback clearing the flag, and the control panel reporting it.
  if (install.reauth_required_at && !allowDead) {
    // BEFORE refusing, let the install prove the flag wrong.
    //
    // The flag is set on any 401 from a call that did not pass
    // `scopeOptional`, so ONE endpoint the app lacks a scope for can flag a
    // location whose token is entirely healthy. That is what happened: a note
    // relations call needing `notes.write` 401'd, and every write for the
    // location started answering 409 while reads carried on.
    //
    // Recovery was a DEADLOCK. Clearing the flag needs a successful refresh
    // (see refreshAccessToken); a refresh only happens inside ghlRequest; and
    // ghlRequest is only reached through this function, which refused to hand
    // the install over. So the only exits were a full reinstall or someone
    // running UPDATE installs SET reauth_required_at = NULL by hand — for a
    // token that was never broken.
    //
    // One forced refresh breaks the cycle. If the refresh token really is
    // dead this throws and the flag stands, so a genuinely dead install is
    // still refused — it just costs one request to establish that, rather
    // than a support round trip.
    const healed = await tryHealReauth(install);
    if (healed) return healed;

    // WARN, not debug. At debug this was invisible in production, so a
    // location whose flag was set by ONE failing endpoint looked like a
    // broken write API: reads kept working (they hit our database, not GHL)
    // while every write 409'd "no longer connected" — which is not what had
    // happened. The flag is a single column and the reason for it is not
    // recorded, so this line is the only trace of why a write was refused.
    logger.warn(
      { locationId, reauthRequiredAt: install.reauth_required_at },
      'getActiveInstall: install is flagged reauth_required — refusing the write. '
      + 'Reads are unaffected, so this presents as one broken endpoint. '
      + 'If the token still works, clear installs.reauth_required_at for this location.'
    );
    return null;
  }
  return install;
}

/**
 * Why getActiveInstall returned null, in words a rep can act on.
 *
 * The two cases are NOT the same and were reported identically:
 *
 *   uninstalled_at set    — the app really was removed. "No longer connected"
 *                           is accurate; reinstalling is the fix.
 *   reauth_required_at set — the install is still there and its token may well
 *                           still work. The flag is set when a refresh token
 *                           is rejected OR when any single endpoint 401s
 *                           without `scopeOptional`, so ONE unauthorised
 *                           endpoint can flag a location whose other calls are
 *                           all fine.
 *
 * That second case is what happened: a note-relations call needing `notes.write`
 * 401'd, flagged the location, and every write then answered "no longer
 * connected" while reads carried on working — because reads come from our
 * database and never touch GHL. It reads like one broken write API, which is
 * exactly the wrong thing to go looking for.
 *
 * allowDead so this can see the flag the active lookup hides.
 */
export async function explainInactiveInstall(locationId) {
  const install = await getActiveInstall(locationId, { allowDead: true });
  if (!install) {
    return {
      message: 'This sub-account is no longer connected',
      reason: 'not_installed'
    };
  }
  if (install.reauth_required_at) {
    return {
      message: 'This sub-account needs reconnecting before changes can be saved '
        + '— your CRM rejected the app\'s access.',
      reason: 'reauth_required'
    };
  }
  // Reachable if the install became usable between the two lookups.
  return {
    message: 'This sub-account is no longer connected',
    reason: 'unknown'
  };
}

export async function upsertInstall(install) {
  // Column semantics on this upsert:
  //   - installed_at / tracking_started_at are set ON FIRST INSERT only
  //     (immutable — preserves the original T₀ so reinstall doesn't wipe
  //     historical analytics).
  //   - reinstalled_at = now() ONLY when we're updating an existing row
  //     (so it stays NULL on first install, then ticks on every reinstall).
  //   - uninstalled_at always clears to NULL — we're active again.
  //   - tokens always overwrite — fresh from this OAuth exchange.
  // The refresh token goes to VAULT; the row stores only its id.
  //
  // In one transaction with the upsert: a secret written without the row that
  // references it is orphaned and unfindable, and a row referencing a secret
  // that was never written cannot authenticate. Either half alone is worse
  // than neither.
  const secretId = await withLocationLock(install.locationId, async (client, existing) => {
    // A token minted from the AGENCY may come without a refresh token; the
    // row then carries no secret and performRefresh re-mints instead.
    if (!install.refreshToken) return existing?.refresh_token_secret_id || null;
    return writeRefreshToken(
      client,
      // On a FIRST install there is no row yet, so pass the location id the
      // helper needs for the secret name.
      existing || { location_id: install.locationId },
      install.refreshToken
    );
  });

  const { rows } = await rawQuery(
    `INSERT INTO installs (location_id, company_id, user_type, access_token,
                           refresh_token_secret_id, token_expires_at, scopes, uninstalled_at,
                           token_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
     ON CONFLICT (location_id) DO UPDATE SET
       company_id       = EXCLUDED.company_id,
       token_source     = EXCLUDED.token_source,
       user_type        = EXCLUDED.user_type,
       access_token     = EXCLUDED.access_token,
       refresh_token_secret_id = EXCLUDED.refresh_token_secret_id,
       token_expires_at = EXCLUDED.token_expires_at,
       scopes           = EXCLUDED.scopes,
       uninstalled_at   = NULL,
       reinstalled_at   = now(),
       -- CLEARS THE DEAD FLAG. A fresh OAuth exchange is exactly the human
       -- action reauth_required_at was asking for, so leaving it set would
       -- keep the install invisible to getActiveInstall forever — a permanent
       -- lockout that a reinstall could not fix.
       --
       -- The 401 recovery path already clears it on a successful refresh
       -- (line ~222); this covers the reinstall route, which is the one a rep
       -- actually takes when told to reconnect.
       reauth_required_at = NULL
     RETURNING location_id, company_id, user_type, access_token,
               refresh_token_secret_id, token_expires_at, scopes, installed_at,
               tracking_started_at, reinstalled_at, uninstalled_at,
               reauth_required_at`,
    [
      install.locationId,
      install.companyId,
      install.userType,
      install.accessToken,
      // The Vault secret id from above — the token itself never reaches this
      // statement.
      secretId,
      install.expiresAt,
      install.scopes,
      install.tokenSource || 'oauth'
    ]
  );
  return rows[0];
}

export async function markUninstalled(locationId) {
  // On uninstall we:
  //   1. Stamp uninstalled_at = now() (audit trail — when they left)
  //   2. Blank access_token and DELETE the Vault secret (dead credentials)
  //   3. Set token_expires_at to epoch so any race condition surfaces as an obvious error
  //
  // We deliberately keep the row (not DELETE) so that:
  //   - If the same locationId re-installs, we can detect "reinstall" vs "fresh install"
  //   - tracking_started_at + installed_at survive — historical analytics stay coherent
  //   - Stage history / opportunities / messages tables are NOT touched here:
  //     the client may want their analytics history preserved even post-uninstall.
  //
  // To actually purge everything for a tenant (right-to-erasure / GDPR), call
  // a separate admin endpoint (TBD) — not the uninstall webhook.
  // The Vault secret is DELETED, not blanked — an uninstalled location's
  // refresh token is dead credentials and keeping them serves nothing. The row
  // survives for its analytics history; only the secret goes.
  //
  // In the same transaction as the stamp, so a failure cannot leave the row
  // marked uninstalled while the secret lives on.
  const rowCount = await withLocationLock(locationId, async (client, install) => {
    if (!install || install.uninstalled_at) return 0;

    await deleteRefreshToken(client, install);

    const { rowCount: n } = await client.query(
      `UPDATE installs
          SET uninstalled_at  = now(),
              access_token    = '',
              token_expires_at = 'epoch'
        WHERE location_id = $1 AND uninstalled_at IS NULL`,
      [locationId]
    );
    return n;
  });
  return rowCount > 0;
}

// ------------------------------------------------------- OAuth + refresh

export async function exchangeCodeForToken(code) {
  if (!config.ghl.clientId || !config.ghl.clientSecret || !config.ghl.redirectUri) {
    throw new Error(
      'GHL OAuth credentials not configured. Set GHL_CLIENT_ID, GHL_CLIENT_SECRET, ' +
      'and GHL_REDIRECT_URI in your .env (values come from the GHL Marketplace developer dashboard).'
    );
  }
  // The callback does not say whether this was a sub-account or an AGENCY
  // install, and GHL requires user_type to match. Location is tried first
  // (the common case); a code that belongs to an agency install either
  // fails that exchange or comes back without a locationId, and is then
  // exchanged as Company.
  const exchange = async (userType) => {
    const params = new URLSearchParams({
      client_id: config.ghl.clientId,
      client_secret: config.ghl.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.ghl.redirectUri,
      user_type: userType
    });
    const { data } = await axios.post(config.ghl.oauthTokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return data;
  };
  let data;
  try {
    data = await exchange('Location');
  } catch (err) {
    if (![400, 401, 422].includes(err.response?.status)) throw err;
    data = await exchange('Company');
  }
  if (!data.locationId && String(data.userType || '').toLowerCase() !== 'company') {
    try { data = await exchange('Company'); } catch { /* keep the first answer */ }
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 86_400) * 1000),
    locationId: data.locationId,
    companyId: data.companyId,
    userType: data.userType || 'Location',
    scopes: (data.scope || '').split(' ').filter(Boolean)
  };
}

// Serialise concurrent refreshes per location. Two workers hitting expiry at
// the same moment would otherwise both POST to /oauth/token, one of them ends
// up with a token GHL already superseded, and its next call 401s.
//
// Advisory lock key is a stable hash of the location_id. Held for the length
// of the transaction; released automatically on COMMIT/ROLLBACK.
// Serialise concurrent refreshes per location on a single pg client so the
// advisory lock, the re-read, and the UPDATE all share one session. Held for
// the length of the transaction; released automatically on COMMIT/ROLLBACK.
async function withLocationLock(locationId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [locationId]);
    // Re-read the install AFTER acquiring the lock — another worker may have
    // just refreshed it, in which case we shouldn't hit /oauth/token again.
    const { rows } = await client.query(
      // Named columns, not SELECT *. Two reasons beyond tidiness: a future
      // column is not silently pulled into every caller, and the token columns
      // are listed explicitly so it is obvious which code paths hold a
      // credential. (James's point 5.)
      `SELECT location_id, company_id, user_type, access_token,
              refresh_token_secret_id, token_expires_at, scopes,
              uninstalled_at, reauth_required_at
         FROM installs WHERE location_id = $1`,
      [locationId]
    );
    const result = await fn(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function performRefresh(client, install) {
  // From Vault, not from the row — the column holds no token any more.
  //
  // Inside the caller's transaction and advisory lock (withLocationLock), so
  // the read, the GHL exchange and the write-back are serialised per location.
  const currentRefresh = await readRefreshToken(client, install);
  if (!currentRefresh && install.token_source === 'agency' && install.company_id) {
    // Minted from the agency and never given a refresh token: mint again.
    // Dynamic import — agencyInstall imports this file.
    const { mintLocationInstall } = await import('./agencyInstall.js');
    const fresh = await mintLocationInstall(install.company_id, install.location_id);
    return { ...install, access_token: fresh.access_token, token_expires_at: fresh.token_expires_at };
  }
  if (!currentRefresh) {
    // No secret means we cannot authenticate and never will without a
    // reinstall. Distinct from a rejected token: this is a missing credential,
    // not an invalid one, and the message says which.
    const err = new Error(
      `No refresh token in Vault for ${install.location_id} — the install needs to be reconnected in GoHighLevel`
    );
    err.code = 'GHL_NO_REFRESH_TOKEN';
    throw err;
  }

  const params = new URLSearchParams({
    client_id: config.ghl.clientId,
    client_secret: config.ghl.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: currentRefresh
  });
  const { data } = await axios.post(config.ghl.oauthTokenUrl, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const accessToken = data.access_token;
  const expiresAt = new Date(Date.now() + (data.expires_in || 86_400) * 1000);

  // Only write the secret when GHL actually returned a NEW refresh token.
  //
  // The old code did `data.refresh_token || install.refresh_token` and wrote
  // the result unconditionally, which meant re-writing the same value on every
  // refresh. Against Vault that would be a pointless update per location per
  // day; skipping it also makes the log line below meaningful — a rotation is
  // now a real event.
  if (data.refresh_token && data.refresh_token !== currentRefresh) {
    await writeRefreshToken(client, install, data.refresh_token);
    logger.info(
      { locationId: install.location_id },
      'GHL rotated the refresh token — new value stored in Vault'
    );
  }

  await client.query(
    `UPDATE installs
        SET access_token=$1, token_expires_at=$2,
            reauth_required_at = NULL
      WHERE location_id=$3`,
    [accessToken, expiresAt, install.location_id]
  );
  logger.info({ locationId: install.location_id }, 'GHL token refreshed');
  // No refresh_token on the returned object: it is not a column any more, and
  // returning a stale copy would let a caller authenticate with it and mask a
  // rotation. Callers only need the access token and its expiry.
  return { ...install, access_token: accessToken, token_expires_at: expiresAt };
}

async function refreshAccessToken(install, { force = false } = {}) {
  return withLocationLock(install.location_id, async (client, current) => {
    // If another worker already refreshed while we waited for the lock, use
    // theirs — unless the caller explicitly asked for a forced refresh
    // (401 handler: we know the current token is dead regardless of expiry).
    if (current) {
      const msUntilExpiry = new Date(current.token_expires_at).getTime() - Date.now();
      if (!force && msUntilExpiry > REFRESH_BUFFER_MS) return current;
      // Even on a forced refresh, if the access_token in the DB differs from
      // the one we came in with, another worker just refreshed — use theirs.
      if (force && current.access_token && current.access_token !== install.access_token) {
        logger.info({ locationId: install.location_id }, 'Token refreshed by another worker while we waited — using theirs');
        return current;
      }
    }
    try {
      return await performRefresh(client, current || install);
    } catch (err) {
      // invalid_grant = another process already burned this refresh_token.
      // Re-read; if their new token is present, use it. Belt-and-braces
      // (the lock should prevent this within one process — this covers
      // cross-process races on restart / multi-pod deploys).
      if (err.response?.data?.error === 'invalid_grant') {
        const { rows } = await client.query(
          // Named columns, not SELECT *: a future column is not silently
          // pulled into every caller, and it is visible which paths touch a
          // credential. refresh_token is gone — the token lives in Vault and
          // this query only needs to know whether ANOTHER worker has already
          // written a newer access token.
          `SELECT location_id, company_id, user_type, access_token,
                  refresh_token_secret_id, token_expires_at, scopes,
                  uninstalled_at, reauth_required_at, token_source
             FROM installs WHERE location_id = $1`,
          [install.location_id]
        );
        if (rows[0] && rows[0].access_token && rows[0].access_token !== install.access_token) {
          logger.info({ locationId: install.location_id }, 'invalid_grant on refresh — another process refreshed, using their token');
          return rows[0];
        }
      }
      throw err;
    }
  });
}

async function ensureFreshToken(install) {
  const msUntilExpiry = new Date(install.token_expires_at).getTime() - Date.now();
  if (msUntilExpiry > REFRESH_BUFFER_MS) return install;
  return refreshAccessToken(install);
}

/**
 * Give a flagged install one chance to prove its token still works.
 *
 * Returns the refreshed install when the refresh succeeds (refreshAccessToken
 * clears reauth_required_at as part of the same UPDATE), or null when it does
 * not — in which case the caller refuses the write as before.
 *
 * RATE LIMITED to one attempt per location per REHEAL_COOLDOWN_MS. Without
 * that, a genuinely dead install would attempt a refresh on every request:
 * a dashboard polling four endpoints would hammer GHL's token endpoint and
 * could get the app rate-limited across every location.
 */
const REHEAL_COOLDOWN_MS = 5 * 60 * 1000;
const lastHealAttempt = new Map();

async function tryHealReauth(install) {
  const locationId = install.location_id;
  const last = lastHealAttempt.get(locationId) || 0;
  if (Date.now() - last < REHEAL_COOLDOWN_MS) return null;
  lastHealAttempt.set(locationId, Date.now());

  try {
    const fresh = await refreshAccessToken(install, { force: true });
    logger.warn(
      { locationId, wasFlaggedAt: install.reauth_required_at },
      'getActiveInstall: install was flagged reauth_required but its token still '
      + 'refreshes — clearing the flag and continuing. The flag was probably set '
      + 'by a single endpoint 401ing without scopeOptional.'
    );
    return fresh;
  } catch (err) {
    // GHL's own words, not a summary: this is the difference between "the
    // refresh token is dead, reinstall" and "something else went wrong".
    logger.error(
      { err, locationId },
      'getActiveInstall: flagged install could not refresh — it genuinely needs reauthorising'
    );
    return null;
  }
}

async function markReauthRequired(locationId, reason) {
  await rawQuery(
    `UPDATE installs SET reauth_required_at = now() WHERE location_id = $1`,
    [locationId]
  );
  logger.error({ locationId, reason }, 'GHL install marked reauth_required — sync will halt for this location');
}

// ------------------------------------------------------- API requests

export async function ghlRequest(install, axiosConfig) {
  // Ours, not axios'. Pulled out so it never reaches the wire as a stray
  // request option. See the 401 handler below for what it does.
  const { scopeOptional, ...requestConfig } = axiosConfig;
  const fresh = await ensureFreshToken(install);
  const buildHeaders = (accessToken) => ({
    Authorization: `Bearer ${accessToken}`,
    Version: config.ghl.apiVersion,
    ...(axiosConfig.headers || {})
  });

  try {
    return await ghlAxios.request({ ...requestConfig, headers: buildHeaders(fresh.access_token) });
  } catch (err) {
    if (err.response?.status !== 401) throw err;

    // GHL returns 401 for HIPAA-enabled locations when accessing message data
    // even though the token is valid. Not an auth failure — refreshing won't
    // help. Surface as a distinct error the callers can decide about.
    const errBody = err.response?.data;
    const errMessage = errBody?.message || errBody?.msg || '';
    if (/hipaa/i.test(errMessage)) {
      const hipaaErr = new Error('GHL location has HIPAA compliance enabled — message data cannot be accessed via API.');
      hipaaErr.code = 'GHL_HIPAA_BLOCKED';
      hipaaErr.locationId = install.location_id;
      hipaaErr.originalStatus = 401;
      throw hipaaErr;
    }

    // Reactive path — proactive refresh believed the token was fine but GHL
    // disagreed. Causes: clock skew, server-side revocation, refresh race.
    // `err` included, so GHL's own reason is in the log. Without it this line
    // said only that a 401 happened at a URL — which is what made the halted
    // sub-account impossible to diagnose from the logs alone. The serialiser
    // now carries the response body and any scopes GHL reports.
    logger.warn(
      { err, locationId: install.location_id, url: requestConfig.url },
      'GHL 401 despite proactive refresh — forcing refresh and retrying once'
    );

    let refreshed;
    try {
      refreshed = await refreshAccessToken(fresh, { force: true });
    } catch (refreshErr) {
      // refresh_token itself is rejected — install is dead.
      await markReauthRequired(install.location_id, 'refresh_token rejected on 401 recovery');
      throw refreshErr;
    }

    try {
      return await ghlAxios.request({ ...requestConfig, headers: buildHeaders(refreshed.access_token) });
    } catch (retryErr) {
      if (retryErr.response?.status === 401) {
        // Fresh token still gets 401. Two very different causes, and this used
        // to conflate them:
        //
        //   1. The install is genuinely revoked — every endpoint will 401, and
        //      flagging it is right.
        //   2. THIS ENDPOINT needs a scope we were never granted — every other
        //      endpoint still works, and flagging the install is wrong.
        //
        // Case 2 happened: one unscoped call to /locations/{id}/tasks/search
        // marked all four installs reauth_required, which halted
        // callRecordingSync and conversationProvidersSync for every location —
        // two syncs with nothing to do with tasks.
        //
        // A caller that knows its endpoint is scope-optional passes
        // `scopeOptional: true` and gets the error without condemning the
        // install. Everything else behaves as before.
        if (scopeOptional) {
          // TWO messages, deliberately.
          //
          // `message` is what a sales rep may end up reading — several
          // callers surface err.message directly — so it says what happened
          // in their terms and nothing else. The endpoint path, the location
          // id and the word "scope" are diagnostics: true, and useless to
          // someone trying to save a note.
          //
          // `detail` keeps the technical version for logs and for any caller
          // that wants it. The logger.warn below already records the full
          // axios error, the location and the URL.
          const err = new Error(
            'Your CRM would not accept this change'
          );
          err.code = 'GHL_SCOPE_MISSING';
          err.detail = `GHL rejected ${requestConfig.url} with 401 — the app is missing the scope for this endpoint`;
          err.url = requestConfig.url;
          err.originalStatus = 401;
          logger.warn(
            { err: retryErr, locationId: install.location_id, url: requestConfig.url },
            'GHL 401 on a scope-optional endpoint — NOT marking the install; check the app scopes'
          );
          throw err;
        }
        // Log GHL's reason BEFORE halting the location, at error level.
        //
        // This is the most consequential decision in the client — it stops
        // every sync for a sub-account — and it was made with nothing in the
        // log but a URL. When it fired on /notes/:id we could not tell a dead
        // token from a missing scope from a per-endpoint restriction, and
        // guessed wrong.
        logger.error(
          {
            err: retryErr,
            locationId: install.location_id,
            url: requestConfig.url,
            method: requestConfig.method || 'GET'
          },
          'GHL 401 after a forced refresh — this is what GHL said before the install was halted'
        );
        await markReauthRequired(install.location_id, 'freshly-refreshed token still 401');
      }
      throw retryErr;
    }
  }
}
