import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

// Extracted from routes/auth.js so the Ask AI tool registry can reuse the
// same cached lookup instead of hardcoding a second copy — the account name
// tool (registry.js) and the auth handshake both need "what is this
// sub-account called", and a location rename should invalidate for both at
// once, not whichever copy happens to refresh first.
//
// In-process cache for location display names. The iframe handshake fires
// on every session mint (page reload, new tab), so a light cache keeps us
// from hitting GHL /locations/{id} on every one. 1-hour TTL is fine —
// sub-account renames are extremely rare, and a stale name for up to an
// hour is acceptable.
const LOCATION_NAME_CACHE = new Map();       // locationId -> { name, expiresAt }
const LOCATION_NAME_TTL_MS = 60 * 60 * 1000;

// Requires the `locations.readonly` scope on the GHL marketplace app.
// If it's missing the call 403s, we log a warning, and the caller falls
// back to the raw locationId. Add the scope in the app config to enable
// the nice display name.
export async function fetchLocationName(install) {
  const locationId = install.location_id;
  const cached = LOCATION_NAME_CACHE.get(locationId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/locations/${encodeURIComponent(locationId)}`
    });
    const name = data?.location?.name || data?.name || null;
    if (name) {
      LOCATION_NAME_CACHE.set(locationId, {
        name, expiresAt: Date.now() + LOCATION_NAME_TTL_MS
      });
      return name;
    }
  } catch (err) {
    logger.warn(
      { err, locationId, status: err.response?.status },
      'locationInfo: fetchLocationName failed — falling back to locationId'
    );
  }
  return null;
}
