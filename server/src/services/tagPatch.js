// tagPatch.js — validate and normalise a contact tag change.
//
// Dependency-free, like contactPatch.js and taskPatch.js: no config, no
// database, no network, so it can be unit-tested directly. ghlTagWrite.js
// imports ghlClient (and therefore config), which is why this lives apart.
//
// NORMALISATION. GHL lowercases and trims on ADD, but only lowercases on
// REMOVE. That asymmetry is theirs: ' VIP ' adds as 'vip' and would then fail
// to remove. So both directions are normalised here and we stop relying on it.

export class TagWriteError extends Error {
  // `reason` is a machine-readable code for cases the message alone cannot
  // convey — 'reauth_required' vs 'not_installed' need different fixes and
  // used to share one message. Null for ordinary validation errors.
  constructor(message, { status = 400, field = null, reason = null } = {}) {
    super(message);
    this.name = 'TagWriteError';
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

// GHL's own rule, applied on our side of the wire so add and remove agree.
// Exported for tests.
export function normaliseTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return t || null;
}

/**
 * Validate a { tags: string[] } body into a clean, deduped list.
 *
 * Rejects rather than silently dropping: a request that names four tags and
 * applies two is worse than one that fails and says which was wrong.
 */
export function buildTagList(input, { verb = 'change' } = {}) {
  const raw = Array.isArray(input) ? input : input?.tags;

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TagWriteError(`Which tags do you want to ${verb}?`, { field: 'tags' });
  }
  // A cap so a runaway client can't post a thousand tags in one call. GHL
  // documents no limit; this is ours.
  if (raw.length > 50) {
    throw new TagWriteError('That is too many tags at once — 50 is the limit', {
      field: 'tags'
    });
  }

  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new TagWriteError('Each tag must be text', { field: 'tags' });
    }
    const tag = normaliseTag(item);
    if (!tag) {
      throw new TagWriteError('A tag cannot be blank', { field: 'tags' });
    }
    // GHL has no documented max; 100 is well past any real tag and stops a
    // pasted paragraph becoming a permanent entry in the location's catalogue.
    if (tag.length > 100) {
      throw new TagWriteError('A tag must be 100 characters or fewer', { field: 'tags' });
    }
    if (seen.has(tag)) continue;   // dedupe quietly — same tag twice is harmless
    seen.add(tag);
    tags.push(tag);
  }

  return tags;
}
