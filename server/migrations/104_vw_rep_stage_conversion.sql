-- 104_vw_rep_stage_conversion.sql
--
-- Per-rep conversion: how far each rep's deals get, and how often they win.
-- Built to be exposed to the AI as a skill (see 083).
--
-- The two rates that matter are separate skills and one win rate hides which
-- is weak:
--
--   pct_reach_quote            do their deals get far enough to be worth a quote
--   won_per_closed_quoted_pct  once quoted, do they close it
--
-- 70% reaching quote with 20% closing them is a rep losing deals they worked
-- hard to build. 20% reaching quote with 70% closing is a rep winning nearly
-- everything they quote and not creating enough to quote. Same overall win
-- rate, opposite problems, opposite coaching.
--
-- ── ASSIGNMENT BIAS — CARRIED INTO THE SKILL TEXT ────────────────────
-- From the source query's own header: deals are not distributed at random.
-- Where a manager routes larger or harder deals to one rep, that rep will show
-- a worse closing rate without being worse at closing, and a better average
-- won value without being better at selling. This view cannot correct for it —
-- nothing in the data records why a deal went to whom. The skill description
-- tells the AI to state it whenever it ranks people, because a ranking read
-- without that caveat is worse than no ranking.
--
-- ── NAMES FROM THE users TABLE, NOT A VALUES LIST ────────────────────
-- The source carried a 17-row hardcoded map. users (migration 014) is synced
-- from GHL and keyed (location_id, user_id), so a new starter or a rename
-- needs no SQL change, and a rep working in two sub-accounts is not merged
-- across them.
--
-- What the sync cannot reproduce is the source's deliberate MANY-TO-ONE
-- collapsing: three ids to 'Charlie Stoyle', two to 'Chris Higgs', three to
-- 'EGJ'. Those are one person holding several GHL accounts, and GHL has no
-- field saying so. So this view reports per ACCOUNT, and says per account in
-- its comments and column names — a person with three logins appears three
-- times, and that is visible rather than silently merged under a name that
-- suggests it is one figure.
--
-- The source's labels also encode facts the sync does not have —
-- '(left)' for a departed rep, '(marketing)' for someone not selling,
-- 'Enquiries inbox' for a shared mailbox that is not a person at all.
-- users.active and users.deleted_at cover the first; the rest is business
-- knowledge. is_shared_account flags the obvious shared-inbox case by name
-- so the AI does not rank a mailbox against people.
--
-- ── LEFT JOIN, NOT INNER ─────────────────────────────────────────────
-- Kept from the source, which had this right. An owner missing from the map
-- falls back to the raw id and an ownerless deal becomes '(unassigned)' — a
-- visible row instead of a silent subtraction from the totals.
--
-- ── NO HAVING THRESHOLD ──────────────────────────────────────────────
-- The source dropped accounts with fewer than five deals. Right instinct —
-- a percentage from three deals is noise — but inside a view it is a floor
-- nobody can see or change. deals is returned and the skill exposes min_deals
-- as a filter, so the threshold is set in the open.
--
-- ── STAGE ORDER IS A LITERAL MAP, DELIBERATELY ───────────────────────
-- Not pipeline_stages.position. "Reached a quote" is a business milestone, not
-- a structural position: it means the same thing across pipelines whose stage
-- counts differ. Same reasoning as skills 8, 10 and 11.
--
-- max_ord is the FURTHEST stage the deal ever reached, not where it sits now —
-- a deal that reached Negotiation and was then moved back still reached it.
--
-- Standard changes: no brand CASE, no cross-account grouping, location_id
-- selected for runSkill's tenant predicate, joins scoped on location_id.

CREATE OR REPLACE VIEW vw_rep_stage_conversion
  WITH (security_invoker = true) AS
WITH live AS (
  SELECT o.opportunity_id, o.location_id, o.status, o.assigned_to, o.monetary_value
    FROM opportunities o
   WHERE o.deleted_at IS NULL
     AND o.is_ghost = false
),
so(stage_name, ord) AS (VALUES
  ('marketing qualified', 1), ('initial contact made', 2), ('sales qualified', 3),
  ('waiting on details', 4), ('quote sent', 5), ('negotiation', 6),
  ('deposit & sales contract', 7)
),
dm AS (
  SELECT l.opportunity_id, l.location_id, l.status, l.assigned_to, l.monetary_value,
         max(so.ord) AS max_ord
    FROM live l
    LEFT JOIN stage_history s
      ON s.opportunity_id = l.opportunity_id
     -- Scoped on location: opportunity_id is unique per sub-account, not
     -- globally (001_schema).
     AND s.location_id = l.location_id
     AND NOT s.deleted
     AND NOT s.ghost_opportunity
     AND COALESCE(s.closed_reason, '') <> 'correction'
    LEFT JOIN so ON so.stage_name = lower(s.stage_name)
   GROUP BY 1, 2, 3, 4, 5
),
named AS (
  SELECT dm.*,
         COALESCE(u.name, dm.assigned_to, '(unassigned)') AS rep_account,
         u.active,
         u.deleted_at AS user_deleted_at
    FROM dm
    LEFT JOIN users u
      ON u.user_id = dm.assigned_to
     AND u.location_id = dm.location_id
)
SELECT location_id,
       rep_account,
       count(*)                                                AS deals,
       count(*) FILTER (WHERE status = 'won')                  AS won,
       count(*) FILTER (WHERE status = 'lost')                 AS lost,
       count(*) FILTER (WHERE status = 'abandoned')            AS abandoned,
       count(*) FILTER (WHERE status = 'open')                 AS open_deals,
       count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5)       AS reached_quote,
       count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 6)       AS reached_negotiation,

       -- Of everything closed, the share won.
       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*) FILTER (WHERE status IN ('won','lost','abandoned')), 0))
                                                               AS won_per_closed_pct,
       -- Of every deal they hold, the share that ever got as far as a quote.
       -- Denominator includes open deals on purpose: a rep sitting on a pile
       -- of untouched open deals should not look good here.
       round(100.0 * count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5)
             / NULLIF(count(*), 0))                            AS pct_reach_quote,
       -- Of the CLOSED deals that reached a quote, the share won. Open deals
       -- excluded — they have not had their chance yet.
       round(100.0 * count(*) FILTER (WHERE status = 'won')
             / NULLIF(count(*) FILTER (WHERE COALESCE(max_ord, 0) >= 5
                                         AND status <> 'open'), 0))
                                                               AS won_per_closed_quoted_pct,

       round(avg(monetary_value) FILTER (WHERE status = 'won')) AS avg_won_value,
       sum(monetary_value)       FILTER (WHERE status = 'won')  AS total_won_value,

       -- Shared mailboxes and marketing accounts are not reps. Flagged rather
       -- than filtered, so the deals stay in the totals but a ranking can
       -- leave them out.
       bool_or(rep_account ILIKE '%inbox%' OR rep_account ILIKE '%enquiries%'
               OR rep_account = '(unassigned)')                AS is_shared_account,
       -- From users.active / deleted_at: a departed rep's history is real but
       -- is not a current performance measure.
       bool_or(COALESCE(active, true) = false
               OR user_deleted_at IS NOT NULL)                 AS is_inactive_user
  FROM named
 GROUP BY location_id, rep_account;

COMMENT ON VIEW vw_rep_stage_conversion IS
  'Per-rep conversion across the pipeline: deal counts by outcome, how many reached quote and negotiation, win rates overall and among quoted deals, and won value. One row per GHL USER ACCOUNT within one sub-account — a person holding several accounts appears several times, because GHL records no link between them. Deals are not assigned at random, so these rates measure the rep and the deals they were given together.';

COMMENT ON COLUMN vw_rep_stage_conversion.pct_reach_quote IS
  'Share of ALL this account''s deals, open ones included, that ever reached Quote Sent. Low means deals die before they are worth quoting — a working or qualifying problem. Open deals are in the denominator deliberately: a rep sitting on untouched open deals should not score well here.';
COMMENT ON COLUMN vw_rep_stage_conversion.won_per_closed_quoted_pct IS
  'Share of this account''s CLOSED quoted deals that were won. Low means deals reach a quote and then fail — a pricing, follow-up or closing problem. Open deals are excluded; they have not had their chance yet.';
COMMENT ON COLUMN vw_rep_stage_conversion.reached_quote IS
  'Deals that ever reached Quote Sent, whether or not they are there now — a deal moved back a stage still reached it.';
COMMENT ON COLUMN vw_rep_stage_conversion.deals IS
  'Deals assigned to this account. A percentage drawn from a handful of deals is noise — say the count alongside any rate.';
COMMENT ON COLUMN vw_rep_stage_conversion.rep_account IS
  'The GHL user account, named from the users table. One person may hold several accounts and will appear once per account. "(unassigned)" means no owner; a raw id means a user missing from the user sync.';
COMMENT ON COLUMN vw_rep_stage_conversion.is_shared_account IS
  'True for shared mailboxes and unassigned deals. Their deals belong in the totals but they should not be ranked against people.';
COMMENT ON COLUMN vw_rep_stage_conversion.is_inactive_user IS
  'True where the GHL user is deactivated or deleted — a departed rep. Their history is real but is not a current performance measure.';
