-- 033_sweep_cursors.sql
--
-- Sweep cursor table per James's CSV blueprint (Stage 1 · Table 5).
-- Remembers "last safely reconciled point" for each (location, object_type).
--
-- Used by:
--   • messagesSync       object_type='messages'
--   • contactsSync       object_type='contacts'
--   • opportunitiesSync  object_type='opportunities'
--
-- Cursor advances only after a successful sweep window. Next run starts
-- with a small backwards overlap to catch anything that fell between the
-- previous run's window_end and now (webhook races, clock skew).

CREATE TABLE IF NOT EXISTS sweep_cursors (
  location_id     TEXT NOT NULL,
  object_type     TEXT NOT NULL,           -- 'messages' | 'contacts' | 'opportunities' | ...
  success_through TIMESTAMPTZ,             -- NULL on first run → sweep starts at now - 30 days
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, object_type),
  FOREIGN KEY (location_id) REFERENCES installs(location_id)
);
