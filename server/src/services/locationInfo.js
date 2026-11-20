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

// locationId -> { timezone, expiresAt }
//
// Separate from the name cache rather than one entry holding both, because
// the two are read on completely different rhythms: the name on every session
// mint, the timezone once per calendar render. Sharing an entry would mean a
// name lookup could evict a timezone and vice versa, for no gain.
const LOCATION_TZ_CACHE = new Map();
const LOCATION_TZ_TTL_MS = 6 * 60 * 60 * 1000;

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

// The sub-account's own IANA timezone — the FALLBACK the operations calendar
// renders in when an appointment's calendar timezone is not known.
//
// ── WHY THE CALENDAR NEEDS THIS AT ALL ───────────────────────────────
//
// An appointment's start is stored as an exact instant (TIMESTAMPTZ, from an
// ISO string that carried its own offset), so there is never any doubt about
// WHEN it happens. What an instant cannot tell you is what time of day to
// draw it at — and a diary is nothing but times of day.
//
// There are three candidate answers and only one of them is right:
//
//   the viewer's browser   WRONG, and wrong in the way that matters. An
//                          office manager in Manchester checking a rep's
//                          week does not want the day redrawn around their
//                          own clock, and a laptop left on holiday time
//                          would silently shift every booking.
//   the calendar's own     RIGHT where we have it (appointments.calendar_timezone)
//   the sub-account's      the fallback — this function
//
// So the rule is: calendar zone, else location zone, never the browser.
// Deciding it in these two functions rather than at each call site is the
// point; a calendar that is an hour out in one view and not another is a bug
// nobody can reproduce.
//
// Requires `locations.readonly`, the same scope fetchLocationName needs.
// Returns null on failure, and the caller falls back again — to UTC, loudly,
// because a guessed zone that is silently wrong is worse than an obvious one.
export async function fetchLocationTimezone(install) {
  const locationId = install.location_id;
  const cached = LOCATION_TZ_CACHE.get(locationId);
  if (cached && cached.expiresAt > Date.now()) return cached.timezone;

  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/locations/${encodeURIComponent(locationId)}`,
      // A missing scope must not flag the install reauth_required — that
      // halts every nightly sync for the tenant, and this is one optional
      // lookup with a working fallback.
      scopeOptional: true
    });
    const timezone = data?.location?.timezone || data?.timezone || null;
    LOCATION_TZ_CACHE.set(locationId, {
      timezone,
      // A miss is cached for a fifth of the time: a sub-account that has not
      // set its timezone is a thing somebody may be in the middle of fixing.
      expiresAt: Date.now() + (timezone ? LOCATION_TZ_TTL_MS : LOCATION_TZ_TTL_MS / 5)
    });
    return timezone;
  } catch (err) {
    logger.warn(
      { err, locationId, status: err.response?.status },
      'locationInfo: fetchLocationTimezone failed — the calendar will fall '
      + 'back to UTC and say so'
    );
    return null;
  }
}
