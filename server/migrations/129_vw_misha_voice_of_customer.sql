-- 129_vw_misha_voice_of_customer.sql
--
-- Nine "voice of the customer" views over misha's extraction (126-128),
-- joined to our own opportunities/messages. These answer what a customer
-- actually SAID — the questions they asked, what they required, what they
-- objected to — which no existing skill covers; the other 43 read structured
-- CRM fields only.
--
-- ── WHAT CHANGED FROM THE SUBMITTED SQL ──────────────────────────────
-- Each view is adapted from a query misha verified against her own copy.
-- Four changes applied to every one, none optional:
--
--   1. No brand CASE. runSkill appends `location_id = $n` unconditionally,
--      so a skill only ever sees one sub-account. The CASE was dead weight
--      that also returned NULL for any account not hardcoded — and several
--      of the submitted queries listed only 2 of the 4 known locations.
--
--   2. No HAVING floors. `HAVING count(*) >= 3` is someone's guess frozen
--      where the model cannot revisit it. Exposed as min_* parameters
--      instead, same as the existing 43.
--
--   3. count(DISTINCT opportunity_id), not count(*), wherever a column is
--      named "deals" or "replies". jsonb_array_elements_text multiplies
--      rows: a deal typed ["Contractor","Architect"] yields two. The
--      submitted 9.3B/6.4/5.4/6.5 all double-counted on multi-type deals.
--      (5.6 already had this right, which is how the pattern was spotted.)
--
--   4. security_invoker = true, location_id selected, joins scoped on
--      BOTH location_id and the id — opportunity_id is unique per location,
--      not globally.
--
-- ── THE ONE CLAIM NOT CARRIED OVER ───────────────────────────────────
-- 9.3's header said "a meaningful share of days_to_move values are under 15
-- minutes". Measured on this data: 2 of 791 rows (0.3%). Both are exactly
-- 0.001 days (~90s); the next value is ~17 minutes and the median is 4.1
-- days. The under_15min_suspect column is kept — it is a real if rare
-- artefact — but the claim is not repeated, because it would lead a reader
-- to discount a result that is 99.7% clean.
--
-- ── JOIN COVERAGE, MEASURED NOT ASSUMED ──────────────────────────────
--   deal_extracts.label -> question_theme_map:      596/596  (100%)
-- NOTE: misha's map contains a REAL theme literally named
-- 'Other / uncategorized'. The COALESCE fallback here is therefore
-- '(no theme mapped)' — had it been any spelling of "other/uncategorised",
-- her deliberate bucket and our join failure would read identically in the
-- output and nobody could tell a label she chose not to classify from one
-- the lookup has never seen.
--   requirements.label  -> requirement_theme_map:  1328/1331 (99.8%)
--   replies.customer_requirement_id -> requirements.id: 798/798, no orphans
--   replies.customer_question_id    -> questions.id: 353/371 ORPHANED (95%)
-- The last pair is never joined below. questions and phrases were truncated
-- upstream to 50-row legacy samples and carry no FK; an inner join to them
-- returns a biased sample and raises no error. deal_extracts replaces both.

-- ── 9.1/9.2 What customers asked about, by theme ─────────────────────
-- One view, not two. The submitted 9.1 (won) and 9.2 (lost) differ only in a
-- status filter, which is a parameter here — registering both would give the
-- model two near-identical tools to pick wrong between.
--
-- was_answered is DERIVED, not stored: an outbound message on the same
-- opportunity within 30 days after the question. misha verified 450/598
-- (75%) of customer questions have one, against a stored was_answered column
-- that was 100% NULL. It is evidence of a reply, not of a good reply.
CREATE OR REPLACE VIEW vw_customer_question_themes
  WITH (security_invoker = true) AS
WITH q AS (
  SELECT DISTINCT
         de.location_id,
         de.opportunity_id,
         de.quoted_at,
         de.label AS question_label,
         COALESCE(tm.theme, '(no theme mapped)') AS theme
    FROM misha.deal_extracts de
    LEFT JOIN misha.question_theme_map tm
           ON tm.location_id   = de.location_id
          AND tm.question_label = de.label
   WHERE de.fact_type = 'customer_question'
),
a AS (
  SELECT q.location_id, q.opportunity_id, q.theme,
         EXISTS (
           SELECT 1 FROM messages m
            WHERE m.opportunity_id    = q.opportunity_id
              AND m.location_id       = q.location_id
              AND m.message_direction = 'outbound'
              AND m.message_timestamp >  q.quoted_at
              AND m.message_timestamp <  q.quoted_at + interval '30 days'
         ) AS was_answered
    FROM q
)
SELECT o.location_id,
       a.theme,
       o.status,
       count(DISTINCT a.opportunity_id)                                  AS deals_asking,
       count(*) FILTER (WHERE a.was_answered)                            AS answered,
       count(*) FILTER (WHERE NOT a.was_answered)                        AS unanswered,
       round(100.0 * count(*) FILTER (WHERE NOT a.was_answered)
             / NULLIF(count(*), 0), 1)                                   AS pct_unanswered
  FROM a
  JOIN opportunities o
    ON o.opportunity_id = a.opportunity_id
   AND o.location_id    = a.location_id
 WHERE o.deleted_at IS NULL
   AND o.is_ghost = false
 GROUP BY o.location_id, a.theme, o.status;

-- ── 5.4 Objections raised, by theme ──────────────────────────────────
-- Submitted as three parts (overall / by buyer type / by product). Folded
-- into one view with buyer_type and product_type as nullable dimensions, so
-- the model filters rather than choosing between three similar skills.
-- A row with both NULL is the "overall" cut.
CREATE OR REPLACE VIEW vw_customer_objection_themes
  WITH (security_invoker = true) AS
WITH obj AS (
  SELECT DISTINCT r.location_id, r.opportunity_id,
         COALESCE(tm.theme, r.requirement_label) AS objection_theme
    FROM misha.requirements r
    LEFT JOIN misha.requirement_theme_map tm
           ON tm.location_id      = r.location_id
          AND tm.requirement_label = r.requirement_label
   WHERE r.is_objection = true
),
d AS (
  SELECT o.location_id, o.opportunity_id, o.status,
         CASE WHEN jsonb_typeof(o.client_type) = 'array'
                   AND jsonb_array_length(o.client_type) > 0
              THEN lower(o.client_type ->> 0) END AS buyer_type,
         CASE WHEN jsonb_typeof(o.product_type) = 'array'
                   AND jsonb_array_length(o.product_type) > 0
              THEN lower(o.product_type ->> 0) END AS product_type
    FROM opportunities o
   WHERE o.deleted_at IS NULL AND o.is_ghost = false
)
SELECT d.location_id,
       obj.objection_theme,
       d.buyer_type,
       d.product_type,
       count(DISTINCT obj.opportunity_id)                                        AS deals,
       count(DISTINCT obj.opportunity_id) FILTER (WHERE d.status = 'won')        AS won,
       count(DISTINCT obj.opportunity_id)
         FILTER (WHERE d.status IN ('lost','abandoned'))                         AS lost_ab
  FROM obj
  JOIN d ON d.opportunity_id = obj.opportunity_id
        AND d.location_id    = obj.location_id
 GROUP BY d.location_id, obj.objection_theme, d.buyer_type, d.product_type;

-- ── 5.2 Requirements on lost deals, with lost value ──────────────────
-- misha.requirement_offer (Charlie's "do we offer this?" classification) is
-- genuinely empty — 0 rows, confirmed against the export, matching its
-- setval(1,false). So `offered` is 'not yet classified' on every row today.
-- That is the honest state, not a bug: this view cannot say what we do NOT
-- offer until that table is filled. What it CAN show is recurring themes
-- with real lost value behind them.
CREATE OR REPLACE VIEW vw_requirement_lost_value
  WITH (security_invoker = true) AS
WITH req AS (
  SELECT DISTINCT r.location_id, r.opportunity_id, r.requirement_label,
         COALESCE(tm.theme, r.requirement_label) AS requirement_theme
    FROM misha.requirements r
    LEFT JOIN misha.requirement_theme_map tm
           ON tm.location_id      = r.location_id
          AND tm.requirement_label = r.requirement_label
)
SELECT req.location_id,
       req.requirement_theme,
       COALESCE(off.offered, 'not yet classified')                              AS offered,
       count(DISTINCT req.opportunity_id)                                        AS deals,
       count(DISTINCT req.opportunity_id) FILTER (WHERE o.status = 'won')        AS won,
       count(DISTINCT req.opportunity_id) FILTER (WHERE o.status = 'lost')       AS lost,
       count(DISTINCT req.opportunity_id) FILTER (WHERE o.status = 'abandoned')  AS abandoned,
       count(DISTINCT req.opportunity_id)
         FILTER (WHERE o.status IN ('lost','abandoned'))                         AS lost_ab,
       COALESCE(sum(o.monetary_value)
         FILTER (WHERE o.status IN ('lost','abandoned')), 0)                     AS lost_value
  FROM req
  JOIN opportunities o
    ON o.opportunity_id = req.opportunity_id
   AND o.location_id    = req.location_id
  LEFT JOIN misha.requirement_offer off
         ON off.location_id      = req.location_id
        AND off.requirement_label = req.requirement_label
 WHERE o.deleted_at IS NULL AND o.is_ghost = false
 GROUP BY req.location_id, req.requirement_theme, COALESCE(off.offered, 'not yet classified');

-- ── 5.2 Part B: the quotes behind a theme ────────────────────────────
-- A list, not an aggregate. The rule across the existing 43 is that a number
-- is only usable if the rows behind it can be read, and a theme name is a
-- summary of free text — it has to be checkable against what was said.
CREATE OR REPLACE VIEW vw_requirement_quotes
  WITH (security_invoker = true) AS
SELECT r.location_id,
       r.opportunity_id,
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

-- ── 5.6 Requirement themes vs the brand's own baseline ───────────────
-- The best-designed of the submitted set, and the only one that already used
-- count(DISTINCT …). Its rule, kept: "a mention is not a roadblock — it only
-- counts as one where the deal did not move after it was said AND its lost
-- rate is above the brand's baseline." baseline_lost_rate_pct is on every
-- row so the comparison is possible without a second query.
--
-- moved_stage_after comes from misha.replies.deal_moved_stage_after joined
-- on customer_requirement_id, which HAS a real FK — 798/798, zero orphans.
CREATE OR REPLACE VIEW vw_requirement_vs_baseline
  WITH (security_invoker = true) AS
WITH baseline AS (
  SELECT location_id,
         round(100.0 * count(*) FILTER (WHERE status = 'lost')
               / NULLIF(count(*), 0), 1) AS baseline_lost_rate_pct
    FROM opportunities
   WHERE deleted_at IS NULL AND is_ghost = false
     AND status IN ('won','lost','abandoned')
   GROUP BY location_id
),
req AS (
  SELECT r.id, r.location_id, r.opportunity_id, r.stage_at_time, r.deal_status,
         COALESCE(tm.theme, r.requirement_label) AS requirement_theme
    FROM misha.requirements r
    LEFT JOIN misha.requirement_theme_map tm
           ON tm.location_id      = r.location_id
          AND tm.requirement_label = r.requirement_label
)
SELECT req.location_id,
       req.requirement_theme,
       req.stage_at_time,
       count(DISTINCT req.opportunity_id)                                           AS times_asked,
       count(DISTINCT req.opportunity_id) FILTER (WHERE req.deal_status = 'won')     AS on_won,
       count(DISTINCT req.opportunity_id)
         FILTER (WHERE req.deal_status IN ('lost','abandoned'))                      AS on_lost_ab,
       round(100.0 * count(DISTINCT req.opportunity_id)
               FILTER (WHERE req.deal_status = 'lost')
             / NULLIF(count(DISTINCT req.opportunity_id), 0), 1)                     AS lost_rate_pct,
       b.baseline_lost_rate_pct,
       count(*) FILTER (WHERE rep.deal_moved_stage_after)                            AS moved_stage_after,
       count(*) FILTER (WHERE NOT rep.deal_moved_stage_after)                        AS no_move_after
  FROM req
  JOIN baseline b ON b.location_id = req.location_id
  LEFT JOIN misha.replies rep
         ON rep.customer_requirement_id = req.id
        AND rep.location_id             = req.location_id
 GROUP BY req.location_id, req.requirement_theme, req.stage_at_time, b.baseline_lost_rate_pct;

-- ── 9.3 Replies that preceded a stage move ───────────────────────────
-- "Worked" is the submitted framing and is not adopted as a column name: a
-- stage move after a reply is correlation. stage_moved_to and
-- median_days_to_move are what the data supports.
CREATE OR REPLACE VIEW vw_reply_stage_movement
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id, o.opportunity_id, o.status,
         CASE WHEN jsonb_typeof(o.client_type) = 'array'
                   AND jsonb_array_length(o.client_type) > 0
              THEN lower(o.client_type ->> 0) END AS buyer_type
    FROM opportunities o
   WHERE o.deleted_at IS NULL AND o.is_ghost = false
)
SELECT r.location_id,
       initcap(lower(COALESCE(r.stage_moved_to, 'none')))                  AS stage_moved_to,
       d.buyer_type,
       count(*)                                                            AS replies,
       count(DISTINCT r.opportunity_id)                                    AS deals,
       round(percentile_cont(0.5) WITHIN GROUP
             (ORDER BY r.days_to_move)::numeric, 1)                        AS median_days_to_move,
       count(*) FILTER (WHERE r.days_to_move < 0.0104)                     AS under_15min_suspect,
       count(DISTINCT r.opportunity_id) FILTER (WHERE d.status = 'won')    AS on_deals_later_won
  FROM misha.replies r
  JOIN d ON d.opportunity_id = r.opportunity_id
        AND d.location_id    = r.location_id
 GROUP BY r.location_id, initcap(lower(COALESCE(r.stage_moved_to, 'none'))), d.buyer_type;

-- ── 9.3 Part C: the replies themselves ───────────────────────────────
CREATE OR REPLACE VIEW vw_reply_list
  WITH (security_invoker = true) AS
SELECT r.location_id,
       r.opportunity_id,
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

-- ── 6.5 Written close reasons by buyer type ──────────────────────────
-- Part A only (coverage). The submitted Part B bucketed free text with eight
-- regexes into themes — not reproduced, for the same reason 106 gives: the
-- source header says a person confirms them by hand, so frozen in a view
-- they become unreviewed truth and 'Other / unclear' silently absorbs the
-- reasons nobody wrote a pattern for. The text is exposed; the model reads it.
CREATE OR REPLACE VIEW vw_close_reason_by_buyer_type
  WITH (security_invoker = true) AS
WITH d AS (
  SELECT o.location_id, o.opportunity_id, o.status,
         CASE WHEN jsonb_typeof(o.client_type) = 'array'
                   AND jsonb_array_length(o.client_type) > 0
              THEN lower(o.client_type ->> 0) END AS buyer_type,
         NULLIF(o.meddic_9, '')  AS lost_reason,
         NULLIF(o.meddic_10, '') AS won_reason
    FROM opportunities o
   WHERE o.deleted_at IS NULL AND o.is_ghost = false
     AND o.status IN ('won','lost','abandoned')
)
SELECT location_id,
       COALESCE(buyer_type, 'unknown')                                        AS buyer_type,
       count(*)                                                               AS closed,
       count(*) FILTER (WHERE status = 'won')                                 AS won,
       count(*) FILTER (WHERE status IN ('lost','abandoned'))                 AS lost_ab,
       count(lost_reason) FILTER (WHERE status IN ('lost','abandoned'))       AS lost_reason_written,
       count(won_reason)  FILTER (WHERE status = 'won')                       AS won_reason_written,
       round(100.0 * count(lost_reason) FILTER (WHERE status IN ('lost','abandoned'))
             / NULLIF(count(*) FILTER (WHERE status IN ('lost','abandoned')), 0), 1)
                                                                              AS pct_lost_reason_written
  FROM d
 GROUP BY location_id, COALESCE(buyer_type, 'unknown');

-- ── 9.4 Enquiry-text coverage ────────────────────────────────────────
-- Part A only. The submitted Part B matched a hand-written VALUES list of 24
-- phrases ('crittall', 'bifold', …) — by its own header "a starting set
-- Misha replaces with what she finds". A list like that belongs in a table
-- somebody maintains, not frozen into a view where nobody can see it is
-- stale. This view says how much enquiry text exists and how long it is;
-- reading it is the model's job.
CREATE OR REPLACE VIEW vw_enquiry_text_coverage
  WITH (security_invoker = true) AS
SELECT location_id,
       status,
       count(*)                                                               AS closed,
       count(*) FILTER (WHERE NULLIF(trim(inquiry), '') IS NOT NULL)          AS with_inquiry,
       count(*) FILTER (WHERE length(COALESCE(inquiry, '')) >= 60)            AS usable_60plus,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY length(COALESCE(inquiry, '')))
             FILTER (WHERE NULLIF(trim(inquiry), '') IS NOT NULL)::numeric, 0) AS median_length,
       round(100.0 * count(*) FILTER (WHERE NULLIF(trim(inquiry), '') IS NOT NULL)
             / NULLIF(count(*), 0), 1)                                        AS pct_with_inquiry
  FROM opportunities
 WHERE deleted_at IS NULL AND is_ghost = false
   AND status IN ('won','lost','abandoned')
 GROUP BY location_id, status;
