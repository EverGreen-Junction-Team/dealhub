// tagHistoryWriter.js — reconciles a record's current tag list against the
// tag_history table. Called from ContactTagUpdate + OpportunityUpdate
// webhook handlers, plus the initial-seed path if we ever backfill tags.
//
// Contract:
//   reconcileTags({ locationId, entityType, entityId, currentTags[], detectedVia })
//
// Where currentTags is the FULL new tag list as GHL sees it (names, and
// optionally IDs from the tags catalogue). This function:
//   1. Reads open rows (removed_at IS NULL) for (locationId, entityType,
//      entityId) from tag_history
//   2. Computes the set-difference:
//      - Tags in currentTags but no open row → open new row
//      - Open rows whose tag_name is NOT in currentTags → close (removed_at)
//      - Tags in both → no-op
//   3. Also refreshes the mirrored `tags` TEXT[] column on the parent
//      (contacts / opportunities) so day-to-day queries don't need to hit
//      tag_history at all.
//
// Idempotent: running with the same currentTags list twice does no work
// on the second run.

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

// Normalise webhook input into { name, tagId } pairs.
// GHL sends tags in various shapes depending on the event:
//   - ContactTagUpdate: contact.tags: ["hot-lead", "quote:email"]
//   - OpportunityUpdate: opportunity.tags: [{ id, name }] or ["name-only"]
// We accept both — a bare string becomes { name, tagId: null }.
function normaliseTagList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    let name = null;
    let tagId = null;
    if (typeof raw === 'string') {
      name = raw.trim();
    } else if (raw && typeof raw === 'object') {
      name = (raw.name || raw.tagName || '').trim();
      tagId = raw.id || raw.tagId || null;
    }
    if (!name) continue;
    if (seen.has(name)) continue; // dedupe — GHL sometimes sends duplicates
    seen.add(name);
    out.push({ name, tagId });
  }
  return out;
}

// Update the mirrored TEXT[] column on the parent table (contacts /
// opportunities). No-op if the array already matches — Postgres will still
// bump updated_at, so we filter with IS DISTINCT FROM to avoid churn.
async function refreshMirroredTagsColumn(locationId, entityType, entityId, tagNames) {
  const table = entityType === 'contact' ? 'contacts' : 'opportunities';
  const idColumn = entityType === 'contact' ? 'contact_id' : 'opportunity_id';
  await rawQuery(
    `UPDATE ${table}
        SET tags = $3::text[],
            updated_at = now()
      WHERE location_id = $1
        AND ${idColumn} = $2
        AND tags IS DISTINCT FROM $3::text[]`,
    [locationId, entityId, tagNames]
  );
}

export async function reconcileTags({
  locationId,
  entityType,
  entityId,
  currentTags,
  detectedVia
}) {
  if (!locationId || !entityType || !entityId) {
    logger.warn(
      { locationId, entityType, entityId },
      'tagHistoryWriter: missing required arg — skipping'
    );
    return { opened: 0, closed: 0 };
  }
  const normalised = normaliseTagList(currentTags);
  const currentNames = new Set(normalised.map((t) => t.name));

  // Fetch open rows for this entity. We identify by tag_name (rename-safe
  // via tag_id is a nice-to-have, but the diff key MUST be name because
  // GHL webhooks don't reliably send tag_ids — a rename would open+close
  // a session anyway, which is the correct behaviour semantically).
  const { rows: openRows } = await rawQuery(
    `SELECT id, tag_name
       FROM tag_history
      WHERE location_id = $1
        AND entity_type = $2
        AND entity_id = $3
        AND removed_at IS NULL`,
    [locationId, entityType, entityId]
  );

  const openByName = new Map(openRows.map((r) => [r.tag_name, r.id]));

  // Close rows whose tag no longer appears in currentTags.
  const toClose = [];
  for (const [name, id] of openByName) {
    if (!currentNames.has(name)) toClose.push(id);
  }
  if (toClose.length) {
    await rawQuery(
      `UPDATE tag_history
          SET removed_at = now()
        WHERE id = ANY($1::uuid[])
          AND removed_at IS NULL`,
      [toClose]
    );
  }

  // Open new rows for tags that don't have an open row yet.
  const toOpen = normalised.filter((t) => !openByName.has(t.name));
  if (toOpen.length) {
    // Enrich tag_id from the tags catalogue (populated by daily tagsSync).
    // GHL webhooks nearly always send tag names only — the id resolves via
    // (location_id, name). One batch lookup instead of one query per tag.
    // Tags not in the catalogue yet (webhook faster than daily sync) leave
    // tag_id NULL — the next enrichment pass (or next tagsSync + a repeat
    // reconcileTags) fills them in.
    const missingIdNames = toOpen.filter((t) => !t.tagId).map((t) => t.name);
    if (missingIdNames.length) {
      const { rows: catalogueRows } = await rawQuery(
        `SELECT tag_id, name
           FROM tags
          WHERE location_id = $1
            AND name = ANY($2::text[])`,
        [locationId, missingIdNames]
      );
      const nameToId = new Map(catalogueRows.map((r) => [r.name, r.tag_id]));
      for (const t of toOpen) {
        if (!t.tagId && nameToId.has(t.name)) t.tagId = nameToId.get(t.name);
      }
    }

    // Bulk insert. Postgres $N binding + one row per tag.
    const values = [];
    const params = [];
    let p = 1;
    for (const t of toOpen) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, now(), $${p++})`);
      params.push(locationId, entityType, entityId, t.tagId, t.name, detectedVia || null);
    }
    await rawQuery(
      `INSERT INTO tag_history
         (location_id, entity_type, entity_id, tag_id, tag_name, applied_at, detected_via)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  // Refresh the mirrored TEXT[] column so day-to-day queries don't need
  // to touch tag_history at all.
  const tagNamesArray = Array.from(currentNames);
  await refreshMirroredTagsColumn(locationId, entityType, entityId, tagNamesArray);

  if (toOpen.length || toClose.length) {
    logger.info(
      { locationId, entityType, entityId, opened: toOpen.length, closed: toClose.length, detectedVia },
      'tagHistoryWriter: reconciled tags'
    );
  }
  return { opened: toOpen.length, closed: toClose.length };
}
