-- 069_pending_deal_links.sql
--
-- The deal a rep picked when CREATING a note or a task.
--
-- THE GAP. On create we cannot store the pick anywhere it would survive:
--
--   * GHL will not take it. Both note->deal and task->deal need the
--     Associations API, which is closed to us — notes need the notes.write
--     scope this app does not hold, and task relation writes are refused
--     outright on the OAuth channel (restrictOAuthChannel). Every create with
--     a deal therefore failed that call.
--   * Our own row does not exist yet. NoteCreate / TaskCreate own the INSERT
--     and arrive a moment AFTER the HTTP response, so the route has nothing
--     to UPDATE.
--
-- So the pick was simply dropped, and the webhook then INFERRED a deal from
-- the attribution rule — the contact's earliest open deal. On a contact with
-- one open deal that agrees with the rep and looks correct; with two it files
-- the record against the wrong deal, with no error shown.
--
-- THIS TABLE is the handover. The route writes the intent keyed by the id GHL
-- just returned; the webhook consumes it instead of inferring, and marks the
-- row deal_set_manually (migration 068) because a person chose it.
--
-- Rows are deleted on consumption. What is left is either a webhook that has
-- not arrived yet or one that never will (a create whose webhook was dropped),
-- which is why expires_at exists — see the sweep note below.
--
-- ONE TABLE FOR BOTH. Notes and tasks hit the same wall for the same reason
-- and the payload is identical; entity_type keeps them apart. A second table
-- would duplicate the sweep and the consumption logic.

CREATE TABLE IF NOT EXISTS pending_deal_links (
  location_id    TEXT        NOT NULL,
  -- 'note' | 'task'. Not an enum: adding a third entity should not need a
  -- type migration, and the set is validated in code.
  entity_type    TEXT        NOT NULL,
  -- The GHL id returned by the create call.
  entity_id      TEXT        NOT NULL,
  -- The deal the rep picked. NULL is meaningful: "created with no deal", which
  -- must also suppress the rule rather than invite it to guess.
  opportunity_id TEXT,
  -- Who picked it, for the audit trail. The session user, not a GHL user.
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A webhook that never arrives must not leave a row behind for ever. An
  -- hour is far longer than the usual sub-second delivery and short enough
  -- that a stale intent cannot attach itself to a much later record that
  -- happens to reuse the id.
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
  PRIMARY KEY (location_id, entity_type, entity_id)
);

COMMENT ON TABLE pending_deal_links IS
  'Deal chosen by a rep when creating a note or task, held until the matching
   GHL webhook inserts the row. Consumed and deleted by noteWriter/taskWriter.
   Exists because neither GHL nor our own row can hold the pick at create
   time — see the migration header.';

-- The only read is the consumption lookup, which is the primary key.
-- The only scan is the expiry sweep.
CREATE INDEX IF NOT EXISTS pdl_expires ON pending_deal_links (expires_at);

ALTER TABLE pending_deal_links ENABLE ROW LEVEL SECURITY;

-- Same tenant isolation as every other table: a location sees only its rows.
DROP POLICY IF EXISTS tenant_iso ON pending_deal_links;
CREATE POLICY tenant_iso ON pending_deal_links
  USING (location_id = current_setting('app.location_id', true));
