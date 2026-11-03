-- 124_email_signatures.sql
--
-- A rep's email sign-off, kept per sub-account.
--
-- ── WHY (location_id, user_id) AND NOT user_id ALONE ─────────────────
-- A rep working across two brands signs off differently in each: Crittall's
-- number under a Crittall email, BGD's under a BGD one. A single signature
-- per person would put one brand's details on the other's correspondence,
-- which is worse than having none — a customer reading it has no way to know
-- it is wrong, and it reaches them over the company's own domain.
--
-- It also matches how everything else here is keyed, so a rep removed from
-- one sub-account loses that signature and keeps the other.
--
-- ── HTML, NOT TEXT ───────────────────────────────────────────────────
-- The email body is HTML (GHL renders it), and a signature that could not
-- carry a link or a bolded name would be a worse version of what reps already
-- paste in by hand. Written through the same RichEditor the email composer
-- uses, and sanitised on the way in by the same sanitiseHtml — a signature is
-- pasted from Outlook as often as it is typed, and Outlook's markup is not
-- something to hand to a contentEditable unexamined.
--
-- ── NO is_default, NO MULTIPLE SIGNATURES ────────────────────────────
-- One per rep per account. Several with a picker is a feature nobody asked
-- for, and the first question it raises — which one does the AI use when it
-- drafts? — has no good answer that does not involve asking the rep mid-draft.

CREATE TABLE IF NOT EXISTS email_signatures (
  location_id   TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,                 -- GHL user id
  html          TEXT        NOT NULL,
  -- Who last saved it. Normally the same as user_id; different when an admin
  -- edits someone else's, which the UI does not offer today but the audit
  -- trail should still distinguish.
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (location_id, user_id)
);

COMMENT ON TABLE email_signatures IS
  'One email sign-off per rep per sub-account. HTML, sanitised on save. A rep working in two brands has a separate signature in each — the same block under both would put one company''s details on the other''s correspondence.';
COMMENT ON COLUMN email_signatures.html IS
  'Sanitised HTML. Written through the same editor and sanitiser as the email composer, because a signature is pasted from Outlook as often as it is typed.';

ALTER TABLE email_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON email_signatures;
CREATE POLICY tenant_iso ON email_signatures
  USING (location_id = current_setting('app.location_id', true))
  WITH CHECK (location_id = current_setting('app.location_id', true));
