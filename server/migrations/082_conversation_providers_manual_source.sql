-- 082_conversation_providers_manual_source.sql
--
-- Adds 'manual' to conversation_providers.last_seen_via.
--
-- WHY. The providers a location actually has live behind
-- GET /conversations/providers/search, which a marketplace app cannot call —
-- every request answers 401 "The token is not authorized for this scope", and
-- the route is absent from GHL's public scope map, so there is no scope to
-- request. The endpoint we CAN call returns a narrower list: for one live
-- location it omitted a custom SMS provider and all three Call-type senders.
--
-- scripts/seedConversationProviders.js therefore seeds the catalogue from a
-- payload copied out of the GHL UI, and stamps those rows 'manual'. The daily
-- sync skips pruning them (softDeleteMissing) and preserves the flag on
-- upsert — otherwise the sync would delete precisely the rows that exist
-- BECAUSE its endpoint cannot see them.
--
-- Without this migration every seeded INSERT fails the 044 CHECK, which is the
-- same failure mode as the ai_actions action_type constraint in 081: code and
-- constraint drift apart, and the feature fails on first use with an opaque
-- Postgres error.

ALTER TABLE conversation_providers
  DROP CONSTRAINT IF EXISTS conversation_providers_last_seen_via_check;

ALTER TABLE conversation_providers
  ADD CONSTRAINT conversation_providers_last_seen_via_check
  CHECK (last_seen_via IN ('daily_sync', 'on_demand', 'manual'));

COMMENT ON COLUMN conversation_providers.last_seen_via IS
  'How this row was last written. daily_sync = catalogue sync; on_demand = filled when a message arrived carrying an unknown provider id; manual = hand-seeded from the GHL UI because the API cannot reach it (see scripts/seedConversationProviders.js). Manual rows are never pruned by the sync and keep the flag across upserts.';
