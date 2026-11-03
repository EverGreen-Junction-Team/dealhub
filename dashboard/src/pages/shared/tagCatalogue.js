// Shared tag state: the location's catalogue cache and the normalising rule.
//
// Extracted from TagPicker so the inline TagSelect can use both without
// importing a dialog. Two copies of either would be worse than a shared
// module: a second cache would double the requests it exists to avoid, and a
// second normaliser would let one control write "Hot Lead" where the other
// writes "hot lead".

// The location's tag catalogue, cached for the session.
//
// The list is location-wide and refreshed by a DAILY cron, so re-fetching it
// per mount was pure latency for data that had not changed. `promise` dedupes
// concurrent first mounts; `tags` serves every mount after.
//
// Deliberately NOT persisted (no localStorage): a tag created in GHL should
// appear after a reload, and a session-lifetime cache gets that for free with
// no staleness policy to reason about.
//
// Mutable on purpose — a tag a rep invents is pushed in so the next picker
// offers it rather than inviting a near-duplicate.
export const TAG_CACHE = { tags: null, promise: null }

// GHL lowercases and trims tags on write. Applying the same rule locally means
// the pill a rep sees matches the one that comes back, and that "Hot Lead"
// typed beside an existing "hot lead" is recognised as the same tag rather
// than created as a second one.
export function normaliseTag(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
}
