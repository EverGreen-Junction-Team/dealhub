-- 132_vw_misha_deal_names.sql
--
-- Deal NAMES on the row-level voice-of-customer views.
--
-- WHAT WENT WRONG.
-- vw_requirement_quotes exposed opportunity_id and no name, so an answer
-- quoting four customers read:
--
--   2lVBs41TxfmKK8U03fIn — "We have decided to go with another glaze…"
--   MPPhGrMMy03uZT1v7JBE — "we've decided to go with a different company"
--
-- The model was not being obtuse; the id was the only identifier it had. A
-- rep cannot act on that — they cannot tell which customer said it without
-- pasting the id into a search. Every other list view in this app shows a
-- name, and these were the exception.
--
-- Adding the column is not enough on its own: the skill description has to
-- tell the model to use it, which is done in the matching JSON. A view that
-- offers both an id and a name will still get the id quoted if nothing says
-- otherwise.
--
-- deal_name can be NULL — GHL does not require one — so it is COALESCEd to
-- the contact's name, then to '(unnamed deal)'. An empty label in a quote
-- list is worse than an honest placeholder: it reads as a rendering fault.

-- ── WHY DROP AND NOT JUST REPLACE ───────────────────────────────────
-- CREATE OR REPLACE VIEW can only APPEND a column, never insert one into the
-- middle of the list. deal_name belongs beside opportunity_id — an identifier
-- is useless at the end, after the quote — so replacing in place fails with:
--
--   42P16  cannot change name of view column "requirement_theme" to "deal_name"
--
-- Postgres is matching position 3 against position 3 and seeing a rename.
-- DROP first, exactly as 099 had to. Safe here: nothing else reads these
-- three views (checked), and a skill resolves its view by NAME at query time,
-- so a view recreated under the same name needs no re-registration.
--
-- IF NOT EXISTS on the drops so a partially-applied run can be retried.

DROP VIEW IF EXISTS vw_requirement_quotes;
DROP VIEW IF EXISTS vw_reply_list;
DROP VIEW IF EXISTS vw_stated_budget_vs_quote;

-- ── 5.2 Part B: the quotes behind a theme ────────────────────────────
CREATE OR REPLACE VIEW vw_requirement_quotes
  WITH (security_invoker = true) AS
SELECT r.location_id,
       r.opportunity_id,
       COALESCE(NULLIF(btrim(o.name), ''), '(unnamed deal)')  AS deal_name,
       o.assigned_to_name                                     AS owner,
       COALESCE(tm.theme, r.requirement_label) AS requirement_theme,
       r.requirement_label,
       r.quote,
       r.quoted_at,
       r.is_objection,
       r.stage_at_time,
       o.status,
       o.monetary_value
  FROM misha.requirements r
  LEFT JOIN misha.requirement_theme_map tm
         ON tm.location_id      = r.location_id
        AND tm.requirement_label = r.requirement_label
  JOIN opportunities o
    ON o.opportunity_id = r.opportunity_id
   AND o.location_id    = r.location_id
 WHERE o.deleted_at IS NULL AND o.is_ghost = false;

-- ── 9.3 Part C: the replies themselves ───────────────────────────────
CREATE OR REPLACE VIEW vw_reply_list
  WITH (security_invoker = true) AS
SELECT r.location_id,
       r.opportunity_id,
       COALESCE(NULLIF(btrim(o.name), ''), '(unnamed deal)')  AS deal_name,
       o.assigned_to_name                                     AS owner,
       o.status,
       r.rep_reply,
       r.rep_reply_at,
       COALESCE(r.stage_moved_to, 'none')      AS then_moved_to,
       r.deal_moved_stage_after,
       r.days_to_move,
       (r.days_to_move < 0.0104)               AS under_15min_suspect,
       o.monetary_value
  FROM misha.replies r
  JOIN opportunities o
    ON o.opportunity_id = r.opportunity_id
   AND o.location_id    = r.location_id
 WHERE o.deleted_at IS NULL AND o.is_ghost = false;

-- ── 5.5: stated budget against what we quoted ────────────────────────
CREATE OR REPLACE VIEW vw_stated_budget_vs_quote
  WITH (security_invoker = true) AS
SELECT r.location_id,
       r.opportunity_id,
       COALESCE(NULLIF(btrim(o.name), ''), '(unnamed deal)')  AS deal_name,
       o.assigned_to_name                                     AS owner,
       o.status,
       r.price_limit_amount                              AS stated_budget,
       o.monetary_value                                  AS quoted_value,
       CASE WHEN r.price_limit_amount > 0 AND o.monetary_value > 0
            THEN round(o.monetary_value - r.price_limit_amount, 0) END
                                                         AS gap_to_quote,
       CASE WHEN r.price_limit_amount > 0 AND o.monetary_value > 0
            THEN round(100.0 * (o.monetary_value - r.price_limit_amount)
                       / r.price_limit_amount, 1) END    AS gap_pct,
       r.quote,
       r.requirement_label,
       r.quoted_at,
       r.stage_at_time,
       r.is_objection
  FROM misha.requirements r
  JOIN opportunities o
    ON o.opportunity_id = r.opportunity_id
   AND o.location_id    = r.location_id
 WHERE r.is_price_limit = true
   AND o.deleted_at IS NULL
   AND o.is_ghost = false;
