// agencyInstall.js — the agency-level install and the sub-account tokens
// minted from it.
//
// WHY. The marketplace app was "sub-account only": every location installed
// it from inside, the OAuth callback got a Location token, one installs row
// per location. Switching distribution to "agency and sub-account" changes
// the handshake: the agency installs once, the callback receives a COMPANY
// token with no locationId, and the sub-accounts the agency ticked are
// announced by INSTALL webhooks. A sub-account token has to be MINTED from
// the agency token (POST /oauth/locationToken) before anything on that
// location can be read. This file does that, and keeps `installs` looking
// exactly as it always has — one row per location, same columns — so the
// 27 call sites of getActiveInstall never learn the difference.
//
// GHL's doc for these two endpoints has two generations: the long-standing
// /oauth/locationToken + /oauth/installedLocations (Version 2021-07-28,
// which this client sends) and a v3 pair at /oauth/location-token +
// /oauth/installed-locations with a different response shape. Both shapes
// are parsed; the v3 path is tried only when the older one answers 404.

import axios from 'axios';
import { config } from '../config.js';
import { pool, rawQuery } from '../db.js';
import { readRefreshToken, writeRefreshToken, deleteRefreshToken } from './tokenVault.js';
import { upsertInstall, getActiveInstall, markUninstalled } from './ghlClient.js';
import { logger } from '../utils/logger.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const AGENCY_SELECT = `SELECT company_id, access_token, refresh_token_secret_id,
         token_expires_at, scopes, installed_at, reinstalled_at,
         uninstalled_at, reauth_required_at, last_location_sync_at
    FROM agency_installs`;

// Serialise per company, same reasoning as ghlClient.withLocationLock: two
// workers refreshing the same agency token at once would burn each other's
// refresh token.
async function withCompanyLock(companyId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agency:${companyId}`]);
    const { rows } = await client.query(`${AGENCY_SELECT} WHERE company_id = $1 FOR UPDATE`, [companyId]);
    const out = await fn(client, rows[0] || null);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getAgencyInstall(companyId) {
  if (!companyId) return null;
  const { rows } = await rawQuery(
    `${AGENCY_SELECT} WHERE company_id = $1 AND uninstalled_at IS NULL AND reauth_required_at IS NULL`,
    [companyId]
  );
  return rows[0] || null;
}

/** Record the agency credential from an OAuth exchange (userType Company). */
export async function upsertAgencyInstall(tokens) {
  const companyId = tokens.companyId;
  if (!companyId) throw new Error('agencyInstall: token has no companyId');
  return withCompanyLock(companyId, async (client, existing) => {
    const secretId = tokens.refreshToken
      ? await writeRefreshToken(
        client,
        existing
          ? { refresh_token_secret_id: existing.refresh_token_secret_id, location_id: `company_${companyId}` }
          : { location_id: `company_${companyId}` },
        tokens.refreshToken
      )
      : existing?.refresh_token_secret_id || null;
    const { rows } = await client.query(
      `INSERT INTO agency_installs (company_id, access_token, refresh_token_secret_id,
                                    token_expires_at, scopes, uninstalled_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (company_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token_secret_id = EXCLUDED.refresh_token_secret_id,
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         uninstalled_at = NULL,
         reauth_required_at = NULL,
         reinstalled_at = now()
       RETURNING company_id, access_token, refresh_token_secret_id, token_expires_at, scopes`,
      [companyId, tokens.accessToken, secretId, tokens.expiresAt, tokens.scopes || []]
    );
    return rows[0];
  });
}

/** The agency token, refreshed if it is within five minutes of expiry. */
export async function ensureFreshAgencyToken(companyId, { force = false } = {}) {
  return withCompanyLock(companyId, async (client, row) => {
    if (!row || row.uninstalled_at) {
      const err = new Error(`No agency install for company ${companyId}`);
      err.code = 'GHL_NO_AGENCY_INSTALL';
      throw err;
    }
    const left = new Date(row.token_expires_at).getTime() - Date.now();
    if (!force && left > REFRESH_BUFFER_MS) return row;

    const refresh = await readRefreshToken(client, row);
    if (!refresh) {
      await client.query(`UPDATE agency_installs SET reauth_required_at = now() WHERE company_id = $1`, [companyId]);
      const err = new Error(`No refresh token in Vault for agency ${companyId} — reinstall the app at agency level`);
      err.code = 'GHL_NO_REFRESH_TOKEN';
      throw err;
    }
    const params = new URLSearchParams({
      client_id: config.ghl.clientId,
      client_secret: config.ghl.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refresh,
      user_type: 'Company'
    });
    let data;
    try {
      ({ data } = await axios.post(config.ghl.oauthTokenUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }));
    } catch (err) {
      if (err.response?.data?.error === 'invalid_grant') {
        await client.query(`UPDATE agency_installs SET reauth_required_at = now() WHERE company_id = $1`, [companyId]);
        logger.error({ companyId }, 'agencyInstall: refresh token rejected — agency must reinstall');
      }
      throw err;
    }
    const accessToken = data.access_token;
    const expiresAt = new Date(Date.now() + (data.expires_in || 86_400) * 1000);
    if (data.refresh_token && data.refresh_token !== refresh) {
      await writeRefreshToken(client, { ...row, location_id: `company_${companyId}` }, data.refresh_token);
    }
    await client.query(
      `UPDATE agency_installs SET access_token = $1, token_expires_at = $2, reauth_required_at = NULL
        WHERE company_id = $3`,
      [accessToken, expiresAt, companyId]
    );
    logger.info({ companyId }, 'agencyInstall: agency token refreshed');
    return { ...row, access_token: accessToken, token_expires_at: expiresAt };
  });
}

async function agencyRequest(companyId, axiosConfig) {
  const agency = await ensureFreshAgencyToken(companyId);
  const headers = {
    Authorization: `Bearer ${agency.access_token}`,
    Version: config.ghl.apiVersion,
    ...(axiosConfig.headers || {})
  };
  try {
    return await axios.request({ baseURL: config.ghl.apiBaseUrl, ...axiosConfig, headers });
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const fresh = await ensureFreshAgencyToken(companyId, { force: true });
    return axios.request({ baseURL: config.ghl.apiBaseUrl, ...axiosConfig,
      headers: { ...headers, Authorization: `Bearer ${fresh.access_token}` } });
  }
}

/**
 * Mint a sub-account token from the agency's and record it as an ordinary
 * installs row (token_source 'agency'). Idempotent: minting again simply
 * refreshes the row.
 */
export async function mintLocationInstall(companyId, locationId) {
  const body = new URLSearchParams({ companyId, locationId });
  const opts = {
    method: 'POST',
    data: body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  };
  let resp;
  try {
    resp = await agencyRequest(companyId, { ...opts, url: '/oauth/locationToken' });
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    resp = await agencyRequest(companyId, { ...opts, url: '/oauth/location-token', headers: { ...opts.headers, Version: 'v3' } });
  }
  const d = resp.data || {};
  if (!d.access_token) throw new Error(`locationToken returned no access_token for ${locationId}`);
  const install = await upsertInstall({
    locationId: d.locationId || locationId,
    companyId,
    userType: 'Location',
    accessToken: d.access_token,
    refreshToken: d.refresh_token || null,
    expiresAt: new Date(Date.now() + (d.expires_in || 86_400) * 1000),
    scopes: String(d.scope || '').split(' ').filter(Boolean),
    tokenSource: 'agency'
  });
  logger.info({ companyId, locationId: install.location_id }, 'agencyInstall: sub-account token minted');
  return install;
}

/** Every sub-account the agency has the app installed on, by id. */
export async function listInstalledLocations(companyId) {
  const appId = config.ghl.appId;
  if (!appId) throw new Error('GHL_APP_ID is not set — needed to list the agency\'s installed locations');
  const ids = [];
  // Older shape: limit/skip and { locations, count }. v3: pageSize/pageToken
  // and { items, pagination }. Walk whichever answers.
  let skip = 0; let pageToken = null; let v3 = false;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ companyId, appId, isInstalled: 'true' });
    if (v3) { q.set('pageSize', '100'); if (pageToken) q.set('pageToken', pageToken); }
    else { q.set('limit', '100'); q.set('skip', String(skip)); }
    let resp;
    try {
      resp = await agencyRequest(companyId, {
        method: 'GET',
        url: `${v3 ? '/oauth/installed-locations' : '/oauth/installedLocations'}?${q.toString()}`,
        headers: v3 ? { Version: 'v3' } : {}
      });
    } catch (err) {
      if (!v3 && err.response?.status === 404) { v3 = true; continue; }
      throw err;
    }
    const d = resp.data || {};
    const rows = Array.isArray(d.locations) ? d.locations : Array.isArray(d.items) ? d.items : [];
    // The response shape is the thing most likely to be wrong on a new
    // account, so say what came back: its keys, the count, one sample row.
    logger.info({ companyId, v3, page, keys: Object.keys(d), rows: rows.length, sample: rows[0] || null,
      count: d.count ?? d.pagination?.totalRecords ?? null, installToFutureLocations: d.installToFutureLocations },
      'agencyInstall: installedLocations page');
    for (const r of rows) if (r && (r._id || r.id) && r.isInstalled !== false) ids.push(r._id || r.id);
    if (v3) {
      if (!d.pagination?.hasNextPage || !d.pagination?.nextPageToken) break;
      pageToken = d.pagination.nextPageToken;
    } else {
      if (rows.length < 100) break;
      skip += rows.length;
    }
  }
  return [...new Set(ids)];
}

/**
 * Bring `installs` in line with what the agency has enabled: mint a token
 * for every installed sub-account we do not hold an active row for, and
 * mark uninstalled any agency-minted row whose location is no longer in
 * the list. Direct (oauth) rows are never touched by the second half.
 */
export async function syncAgencyLocations(companyId) {
  const wanted = await listInstalledLocations(companyId);
  let minted = 0; let kept = 0; let removed = 0; const failed = [];
  for (const locationId of wanted) {
    const existing = await getActiveInstall(locationId);
    if (existing) { kept++; continue; }
    try { await mintLocationInstall(companyId, locationId); minted++; }
    catch (err) {
      failed.push(locationId);
      logger.warn({ err, companyId, locationId }, 'agencyInstall: could not mint sub-account token');
    }
  }
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs
      WHERE company_id = $1 AND token_source = 'agency' AND uninstalled_at IS NULL
        AND NOT (location_id = ANY($2::text[]))`,
    [companyId, wanted]
  );
  for (const r of rows) { if (await markUninstalled(r.location_id)) removed++; }
  await rawQuery(`UPDATE agency_installs SET last_location_sync_at = now() WHERE company_id = $1`, [companyId]);
  logger.info({ companyId, wanted: wanted.length, minted, kept, removed, failed },
    'agencyInstall: locations synced');
  return { wanted: wanted.length, minted, kept, removed, failed };
}

/**
 * A company-level INSTALL webhook after the OAuth callback already ran:
 * nothing to mint, but it moves the install's clock forward so an UNINSTALL
 * redelivered from BEFORE it is recognised as stale (see below).
 */
export async function noteAgencyInstallEvent(companyId, eventTs) {
  const ts = eventTs ? new Date(eventTs) : new Date();
  await rawQuery(
    `UPDATE agency_installs
        SET reinstalled_at = GREATEST(COALESCE(reinstalled_at, installed_at), $2::timestamptz),
            uninstalled_at = NULL
      WHERE company_id = $1`,
    [companyId, Number.isNaN(ts.getTime()) ? new Date() : ts]
  );
}

/**
 * The agency removed the app: its token and every sub-account minted from it.
 *
 * `eventTs` is the webhook's own timestamp. GHL redelivers a lifecycle event
 * for minutes when it was not acknowledged, so an UNINSTALL from 10:58 can
 * land after the agency reinstalled at 10:59 — and would wipe the fresh
 * install. An event older than the latest (re)install is stale and ignored.
 */
export async function markAgencyUninstalled(companyId, { eventTs = null } = {}) {
  if (eventTs) {
    const { rows: cur } = await rawQuery(
      `SELECT COALESCE(reinstalled_at, installed_at) AS since FROM agency_installs WHERE company_id = $1`,
      [companyId]
    );
    const since = cur[0]?.since ? new Date(cur[0].since) : null;
    const at = new Date(eventTs);
    if (since && !Number.isNaN(at.getTime()) && at < since) {
      logger.warn({ companyId, eventTs, installedSince: since }, 'agencyInstall: stale UNINSTALL ignored — the agency reinstalled after it');
      return -1;
    }
  }
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE company_id = $1 AND token_source = 'agency' AND uninstalled_at IS NULL`,
    [companyId]
  );
  for (const r of rows) await markUninstalled(r.location_id);
  await withCompanyLock(companyId, async (client, row) => {
    if (!row) return;
    await deleteRefreshToken(client, { refresh_token_secret_id: row.refresh_token_secret_id, location_id: `company_${companyId}` }).catch(() => {});
    await client.query(
      `UPDATE agency_installs SET uninstalled_at = now(), access_token = '', token_expires_at = 'epoch'
        WHERE company_id = $1`,
      [companyId]
    );
  });
  logger.info({ companyId, locations: rows.length }, 'agencyInstall: agency uninstalled');
  return rows.length;
}
