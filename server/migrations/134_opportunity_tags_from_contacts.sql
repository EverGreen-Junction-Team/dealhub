-- 134_opportunity_tags_from_contacts.sql
--
-- Make the deals tag filter work, by materialising each deal's contacts'
-- tags onto the deal itself.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────
--
-- The deals list filters on tag_history WHERE entity_type = 'opportunity'.
-- That set has never had a single row, so the filter returned 0 for every
-- tag ever picked — the picker offered the account's tags and none of them
-- ever matched anything.
--
-- It is empty because GHL has no opportunity tags. Migration 048 states it:
-- "There is no opportunity-level tag API — no tags[] field on the
-- opportunity object, no webhook for opportunity tags." A tag belongs to a
-- CONTACT. stageHistoryWriter.js still calls reconcileTags with
-- entityType 'opportunity' on every opportunity event, passing a field GHL
-- does not send — always an empty array, so always a no-op.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────
--
-- Projects contact tags onto deals, through EVERY linked contact — the
-- primary (opportunities.contact_id) and every additional one
-- (opportunity_contacts). That is the same set contactIsOnDeal() treats as
-- "on this deal", and the same projection vw_opportunity_effective_tags
-- (048) already describes. It is also what GHL's own opportunity modal
-- shows, so the filter now agrees with the product.
--
-- ── WHY MATERIALISE RATHER THAN JOIN THROUGH THE VIEW ────────────────
--
-- vw_opportunity_effective_tags already computes this, and the deal DETAIL
-- route joins contact tags live. Either could have answered the LIST
-- filter too. Materialising instead because:
--
--   * The filter is an EXISTS inside the deals list query, which already
--     carries status, stage, pipeline, owner, search and a keyset cursor.
--     Adding a two-hop join (opportunity -> contacts -> tag_history) to
--     that predicate makes the common, unfiltered case pay for it.
--   * tag_history is already the one place a tag session lives, with
--     applied_at / removed_at semantics the rest of the app understands.
--     Writing opportunity rows there keeps "currently tagged" meaning the
--     same thing for both entity types.
--   * It makes opportunity_tags — a view that has existed and been empty
--     since migration 021 — finally mean something.
--
-- The cost is that it must be KEPT in step: tagFanout.js does that on
-- every contact tag change and on every relation change, and this
-- migration seeds the history.
--
-- ── DERIVED ROWS ARE MARKED ──────────────────────────────────────────
--
-- detected_via = 'contact_fanout' on every row written here. A tag applied
-- directly to an opportunity (if GHL ever gains the concept) would carry
-- its own event name, so the two never get confused — and the fanout only
-- ever closes rows it owns.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Seed: one open session per (opportunity, tag) the deal's contacts
--    currently carry.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO tag_history
  (location_id, entity_type, entity_id, tag_id, tag_name, applied_at, detected_via)
SELECT
  src.location_id,
  'opportunity',
  src.opportunity_id,
  -- A tag can reach a deal through two contacts with different tag_ids
  -- recorded; the name is the identity (see tagHistoryWriter's own note on
  -- why the diff key is the name), so any one id is as good as another.
  MIN(src.tag_id)         AS tag_id,
  src.tag_name,
  -- The EARLIEST moment any of the deal's contacts carried this tag. The
  -- deal has effectively been tagged since then, and taking the latest
  -- would make "tagged before this deal was created" unanswerable.
  MIN(src.applied_at)     AS applied_at,
  'contact_fanout'
FROM (
  -- Primary contact.
  SELECT o.location_id, o.opportunity_id, th.tag_id, th.tag_name, th.applied_at
    FROM opportunities o
    JOIN tag_history th
      ON th.location_id = o.location_id
     AND th.entity_type = 'contact'
     AND th.entity_id   = o.contact_id
     AND th.removed_at IS NULL
   WHERE o.contact_id IS NOT NULL

  UNION ALL

  -- Every additional linked contact.
  SELECT oc.location_id, oc.opportunity_id, th.tag_id, th.tag_name, th.applied_at
    FROM opportunity_contacts oc
    JOIN tag_history th
      ON th.location_id = oc.location_id
     AND th.entity_type = 'contact'
     AND th.entity_id   = oc.contact_id
     AND th.removed_at IS NULL
) src
WHERE src.tag_name IS NOT NULL
  AND btrim(src.tag_name) <> ''
GROUP BY src.location_id, src.opportunity_id, src.tag_name
-- IDEMPOTENT BY ANTI-JOIN, NOT ON CONFLICT.
--
-- tag_history's primary key is a generated UUID and it has no unique
-- constraint on (location_id, entity_type, entity_id, tag_name) — a tag
-- can legitimately be applied, removed and re-applied, which is several
-- rows for the same four values. So ON CONFLICT DO NOTHING has nothing to
-- conflict ON: it would never fire, and a second run of this migration
-- would open a duplicate session for every deal.
--
-- Skipping deals that already have an OPEN session for that tag is the
-- correct test anyway: a closed session is history and must not stop a tag
-- being re-applied.
HAVING NOT EXISTS (
  SELECT 1 FROM tag_history ex
   WHERE ex.location_id = src.location_id
     AND ex.entity_type = 'opportunity'
     AND ex.entity_id   = src.opportunity_id
     AND ex.tag_name    = src.tag_name
     AND ex.removed_at IS NULL
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Index for the filter's EXISTS.
-- ─────────────────────────────────────────────────────────────────────
--
-- The deals list asks "does this opportunity currently carry tag X", which
-- is (location_id, entity_type, entity_id, tag_name) with removed_at NULL.
-- 019 indexes (location_id, entity_type, entity_id) — enough to find the
-- deal's rows, but it then filters by name across every tag the deal has.
-- Partial on removed_at IS NULL because that is the only half this query
-- ever reads, and it keeps the index to the live sessions.

CREATE INDEX IF NOT EXISTS tag_history_entity_tag_open
  ON tag_history (location_id, entity_type, entity_id, tag_name)
  WHERE removed_at IS NULL;

COMMENT ON INDEX tag_history_entity_tag_open IS
  'Serves "does this entity currently carry tag X" — the deals list tag filter, and the fanout own diff.';
