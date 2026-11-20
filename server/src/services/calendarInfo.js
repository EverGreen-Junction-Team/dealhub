// calendarInfo.js — the one place that answers "what timezone is this
// HighLevel calendar in".
//
// WHY THIS IS A MODULE AND NOT THREE `new Date()` CALLS.
//
// An appointment's startTime arrives as ISO 8601 with a UTC offset, so the
// INSTANT is never in doubt. What is in doubt is the time of DAY, and that
// is the only thing a calendar draws. "9am" is a fact about a place.
//
// Three different places could supply that place and they disagree:
//
//   the viewer's browser   wrong whenever anyone looks at the diary from
//                          somewhere else, which is the normal case for an
//                          office manager checking a field rep's week
//   the sub-account        right most of the time
//   the calendar itself    right, and what HighLevel actually booked against
//
// So the calendar's own zone wins where we can read it, the location's zone
// is the fallback, and the browser's is never used. Resolving it here means
// the rule lives in one file rather than being re-decided at each call site
// — which is how a calendar ends up an hour out in one view and not another.
//
// Requires the `calendars.readonly` scope. Without it this returns null and
// callers fall back, exactly as locationInfo.js does for the location name.

import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';

// locationId:calendarId -> { timezone, expiresAt }
//
// Keyed by both because a calendar id is only unique within a sub-account,
// and this process serves several.
const CALENDAR_TZ_CACHE = new Map();

// Six hours. A calendar's timezone is changed roughly never — the TTL exists
// so a correction made in HighLevel reaches us the same day, not so we track
// a moving value. Longer than locationInfo's hour because the webhook path
// calls this on every appointment, not once per session.
const CALENDAR_TZ_TTL_MS = 6 * 60 * 60 * 1000;

// A miss is cached too, for a much shorter time.
//
// Without this, a sub-account whose app lacks calendars.readonly would make
// one failing round trip PER APPOINTMENT, forever — on a busy morning that
// is a 401 storm against a scope that is not coming back within the hour.
const CALENDAR_TZ_MISS_TTL_MS = 15 * 60 * 1000;

/**
 * The IANA timezone of one calendar, or null.
 *
 * Never throws: a timezone is enrichment. An appointment with no zone is
 * still a correct appointment at a correct instant, and losing the write
 * over a failed lookup would be a far worse trade.
 */
export async function fetchCalendarTimezone(install, calendarId) {
  if (!install || !calendarId) return null;
  const locationId = install.location_id;
  const key = `${locationId}:${calendarId}`;

  const cached = CALENDAR_TZ_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.timezone;

  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/calendars/${encodeURIComponent(calendarId)}`,
      // A missing calendars.readonly scope must NOT mark the install
      // reauth_required — that flag halts every other sync on the location,
      // and this one optional lookup is not worth that blast radius. Same
      // reasoning as tasksSync on the task search endpoint.
      scopeOptional: true
    });
    const timezone = data?.calendar?.timezone || data?.timezone || null;
    CALENDAR_TZ_CACHE.set(key, {
      timezone,
      // A calendar that genuinely has no timezone set is a miss, not a hit:
      // re-ask sooner, because someone setting it in HighLevel is a change
      // we want within the quarter hour rather than the next six.
      expiresAt: Date.now() + (timezone ? CALENDAR_TZ_TTL_MS : CALENDAR_TZ_MISS_TTL_MS)
    });
    return timezone;
  } catch (err) {
    CALENDAR_TZ_CACHE.set(key, {
      timezone: null,
      expiresAt: Date.now() + CALENDAR_TZ_MISS_TTL_MS
    });
    logger.warn(
      { err, locationId, calendarId, status: err.response?.status },
      'calendarInfo: could not read calendar timezone — the appointment is '
      + 'still stored, and rendering falls back to the location timezone'
    );
    return null;
  }
}
