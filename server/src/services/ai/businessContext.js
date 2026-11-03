import { withTenant } from '../../db.js';
import { logger } from '../../utils/logger.js';

// Business context — the Control panel's single markdown file.
//
// Two layers of caching, for two different problems:
//
//   1. Postgres is the store. Survives restarts and redeploys, which a file on
//      the VM's filesystem would not — a rebuild would silently strip the
//      agent's grounding and nobody would notice until an answer went generic.
//
//   2. This module holds an in-process copy so a burst of questions doesn't
//      re-query the same 18 KB per call. Keyed on content_version, so a
//      replace invalidates it on the next read rather than after a TTL.
//
// Anthropic's prompt cache is the third layer, in prompts.js: the file sits
// above the cache_control breakpoint, so repeat questions on the same deal read
// those input tokens from cache instead of re-paying for them.

// locationId → { version, content, filename, sizeBytes, fetchedAt }
const cache = new Map();

// A short TTL on top of version-keyed invalidation. Version checking alone
// would need a query to learn the version, which defeats the point — so we
// trust the cached copy briefly, then re-check. 60s means a replace shows up
// in answers within a minute even if the invalidation call is missed.
const TTL_MS = 60_000;

/**
 * The context file for a location, or null if none uploaded.
 * @returns {{ content, filename, sizeBytes, version } | null}
 */
export async function getBusinessContext(locationId) {
  const hit = cache.get(locationId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return hit.version ? hit : null;
  }

  try {
    const row = await withTenant(locationId, async (client) => {
      const r = await client.query(
        `SELECT content, filename, size_bytes, content_version
           FROM business_context
          WHERE location_id = $1`,
        [locationId]
      );
      return r.rows[0] || null;
    });

    const entry = row
      ? {
          content: row.content,
          filename: row.filename,
          sizeBytes: row.size_bytes,
          version: row.content_version,
          fetchedAt: Date.now()
        }
      // Cache the absence too, with version 0 — otherwise a location with no
      // file re-queries on every single question.
      : { version: 0, fetchedAt: Date.now() };

    cache.set(locationId, entry);
    return entry.version ? entry : null;
  } catch (err) {
    // A stale copy beats no grounding at all: if the DB blips mid-conversation
    // the agent should keep answering from what it last read, not silently
    // lose its context.
    if (hit) {
      logger.warn({ err, locationId }, 'businessContext: read failed, serving stale cache');
      return hit.version ? hit : null;
    }
    logger.error({ err, locationId }, 'businessContext: read failed, no cache');
    return null;
  }
}

// Called after a replace so the next question sees the new text immediately
// rather than waiting out the TTL.
export function invalidateBusinessContext(locationId) {
  cache.delete(locationId);
}

// Part of every ai_runs cache key. Returns 0 when there's no file, so a
// location that uploads its first file invalidates any answers given before it.
export async function contextVersion(locationId) {
  const ctx = await getBusinessContext(locationId);
  return ctx?.version ?? 0;
}
