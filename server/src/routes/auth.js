import express from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { rawQuery } from '../db.js';
import { config } from '../config.js';
import { fetchLocationName } from '../services/locationInfo.js';
import { logger } from '../utils/logger.js';

// Auth handshake for the embedded dashboard.
//
// Flow:
//   1. Dashboard loads inside the GHL iframe → postMessage handshake gives it
//      { locationId, companyId, userId } from GHL.
//   2. Dashboard POSTs those to /auth/verify.
//   3. We check the location has an active install (proves the app is
//      installed on this sub-account) and mint a session JWT scoped to it.
//   4. Dashboard stores the JWT in localStorage; axios attaches it as Bearer.
//   5. /api/* routes verify via requireSession middleware.
//
// The signature check on step 3 is: "is there a non-uninstalled install row
// for this locationId?" Anyone who can fake a locationId can already read
// their own tenant data through the app; the JWT is a per-session credential,
// not a security boundary against locationId spoofing. The security boundary
// is RLS + the fact that the caller doesn't have the service-role key.

export const authRouter = express.Router();

function signSession(payload) {
  if (!config.session.jwtSecret) {
    const err = new Error('SESSION_JWT_SECRET not configured on the server');
    err.status = 500;
    throw err;
  }
  return jwt.sign(payload, config.session.jwtSecret, {
    expiresIn: config.session.ttlSeconds,
    issuer: 'pipelinepulse-server'
  });
}

// POST /auth/decrypt-user-data — first step of the GHL iframe SSO flow.
//
// GHL sends the dashboard an AES-encrypted payload via postMessage. Only the
// server holds the app-level shared secret, so we decrypt server-side and
// return the plain user context. The dashboard then calls /auth/verify with
// those IDs to mint a session JWT.
//
// GHL uses OpenSSL's "aes-256-cbc with EVP_BytesToKey (MD5, 1 iter)" scheme,
// which is what crypto-js's `CryptoJS.AES.decrypt(str, passphrase)` implements.
// The wire format is `Salted__` + 8-byte salt + ciphertext, base64-encoded.
// Reference: https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps
function decryptGhlUserContext(base64Payload, passphrase) {
  const raw = Buffer.from(base64Payload, 'base64');
  if (raw.slice(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('Payload not in OpenSSL Salted__ format');
  }
  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);

  // EVP_BytesToKey with MD5, 1 iteration — derives 32-byte key + 16-byte IV.
  // Loop until we have 48 bytes; each round hashes (previous || passphrase || salt).
  const pass = Buffer.from(passphrase, 'utf8');
  const derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  const parts = [];
  let total = 0;
  while (total < 48) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
    parts.push(prev);
    total += prev.length;
  }
  const keyIv = Buffer.concat(parts).slice(0, 48);
  const key = keyIv.slice(0, 32);
  const iv  = keyIv.slice(32, 48);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

authRouter.post('/decrypt-user-data', async (req, res) => {
  try {
    const { encryptedData } = req.body || {};
    if (!encryptedData) {
      return res.status(400).json({ success: false, error: 'No encrypted data provided' });
    }
    const secret = process.env.GHL_APP_SHARED_SECRET || process.env.GHL_SSO_KEY;
    if (!secret) {
      logger.error('GHL_APP_SHARED_SECRET not configured');
      return res.status(500).json({ success: false, error: 'Shared secret not configured' });
    }
    const userData = decryptGhlUserContext(encryptedData, secret);

    // Never log the plaintext user data in prod.
    if (config.nodeEnv !== 'production') {
      logger.info({ userId: userData.userId, locationId: userData.activeLocation }, 'auth: user context decrypted');
    }

    res.json({
      success: true,
      userId: userData.userId,
      companyId: userData.companyId,
      activeLocation: userData.activeLocation || null,
      locationId: userData.activeLocation || null,   // alias
      email: userData.email,
      userName: userData.userName,
      role: userData.role,
      type: userData.type,
      isAgencyOwner: !!userData.isAgencyOwner
    });
  } catch (err) {
    logger.error({ err }, 'auth.decrypt-user-data failed');
    res.status(400).json({ success: false, error: 'Failed to decrypt user data' });
  }
});

// POST /auth/verify — GHL iframe handshake → session JWT.
authRouter.post('/verify', async (req, res, next) => {
  try {
    const { locationId, companyId, userId } = req.body || {};
    if (!locationId) {
      return res.status(400).json({ error: 'locationId is required' });
    }

    const { rows } = await rawQuery(
      `SELECT location_id, company_id, uninstalled_at, reauth_required_at
         FROM installs
        WHERE location_id = $1`,
      [locationId]
    );
    if (!rows.length) {
      return res.status(404).json({
        error: 'This location has not installed PipelinePulse',
        code: 'INSTALL_NOT_FOUND'
      });
    }
    const install = rows[0];
    if (install.uninstalled_at) {
      return res.status(403).json({ error: 'Install is inactive', code: 'INSTALL_INACTIVE' });
    }

    // Location display name — fetched live from GHL's /locations/{id} API
    // and cached in-process for an hour. Any hardcoded map here rots the
    // moment a sub-account is renamed or reassigned (which is exactly what
    // happened with fJNuIdxGgchGpJ9OoBbk showing "Crittall" long after the
    // sub-account was repurposed as EverGreen Junction).
    const businessName = (await fetchLocationName(install)) || locationId;

    const sessionToken = signSession({ locationId, companyId, userId });

    logger.info({ locationId, userId }, 'auth: session minted');

    res.json({
      sessionToken,
      user: { id: userId || null },
      location: { id: locationId, name: businessName, currency: 'GBP' },
      // Surface reauth state so the dashboard can prompt if the OAuth
      // refresh_token is dead — reads keep working, writes should be gated.
      reauthRequired: !!install.reauth_required_at
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/session — validate the current Bearer and echo who it belongs to.
authRouter.get('/session', requireSession, (req, res) => {
  res.json({
    locationId: req.session.locationId,
    companyId: req.session.companyId,
    userId: req.session.userId,
    expiresAt: req.session.exp * 1000
  });
});

// POST /auth/refresh — extends the session without re-doing the iframe
// handshake. Same-secret re-sign of the current claims.
authRouter.post('/refresh', requireSession, (req, res) => {
  const { locationId, companyId, userId } = req.session;
  const sessionToken = signSession({ locationId, companyId, userId });
  res.json({ sessionToken });
});

// Middleware — verifies the Bearer JWT and attaches req.session for /api/*.
export function requireSession(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token', code: 'NO_TOKEN' });
  }
  try {
    const claims = jwt.verify(token, config.session.jwtSecret, { issuer: 'pipelinepulse-server' });
    req.session = claims;
    req.locationId = claims.locationId;
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    return res.status(401).json({ error: err.message, code });
  }
}
