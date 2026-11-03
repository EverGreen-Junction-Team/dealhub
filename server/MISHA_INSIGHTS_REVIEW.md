# Review: 9 insights from misha — 3 Oct 2026

Verified against the loaded `misha` snapshot (2 Oct) and `migrations/*.sql`.
Not run against production — `DATABASE_URL` is empty in this working copy, so
every row count below is measured from the export, not a live result.

## Schema: everything resolves

All columns exist. Nothing needs creating.

- `opportunities`: meddic_9, meddic_10, inquiry, monetary_value, is_ghost,
  deleted_at, status, client_type, product_system, product_type — all present.
  The three jsonb columns are JSONB, so `jsonb_array_elements_text` is correct.
- `messages`: message_direction, message_timestamp, message_channel,
  opportunity_id — present. 'inbound'/'outbound' match the literals used
  elsewhere in the repo.
- `misha.*`: all 8 tables loaded by migrations 126–128.

## Join coverage: measured, not assumed

| Join | Result |
|---|---|
| `deal_extracts.label` → `question_theme_map` | **596/596 (100%)** — zero fall through to 'Other / uncategorized' |
| `requirements.requirement_label` → `requirement_theme_map` | **1328/1331 (99.8%)** — the 3 unmapped are all Omnia (`E0nGtwuWd1…`), which has requirements but no theme vocabulary. COALESCE handles them. |
| `replies.customer_requirement_id` → `requirements.id` | **798/798, zero orphans** — this column HAS a real FK |
| `replies.customer_question_id` → `questions.id` | **353/371 orphaned (95%)** — no FK, questions truncated to a 50-row sample |

`fact_type` distribution confirms her figures: customer_question 598,
customer_requirement 1124, rep_ask 1019, rep_product_words 650,
rep_question 294, customer_phrase 241.

## One claim that is wrong

9.3's header says "a meaningful share of days_to_move values are under 15
minutes". Measured: **2 of 791 rows (0.3%)**. Both are exactly 0.001 days
(~90 seconds — the example she cites); the next value is ~17 minutes, and the
median is 4.1 days (p10 0.11, p90 53.2).

The `under_15min_suspect` flag is still worth keeping as a column. The
*interpretation* in the comment is not — it would lead a reader to discount a
result that is 99.7% clean.

## Two real bugs

1. **`jsonb_array_elements_text` row multiplication.** A deal typed
   `["Contractor","Architect"]` produces two rows, so `count(*)` of joined
   replies/requirements double-counts. Affects 9.3 Part B, 6.4 Parts A/B/C,
   5.4 Parts B/C, 6.5. Correct for "per buyer-type"; wrong wherever the column
   is named `replies` or `deals`. Fix: `count(DISTINCT opportunity_id)`.
   5.6 already does this correctly.

2. **5.3's stall stages are hardcoded and will silently rot.** BGD 'Waiting on
   Details', Veritas 'Quote Sent' come from insight 5.1. Both strings do exist
   in the data (128 and 75 rows respectively), but when the stall stage moves,
   this query keeps returning rows for the old one with no error. Should read
   from a view, or the stage must become a parameter.

## Structural: none of these can be a skill as written

Three reasons, all unchanged from the handoff doc:

- **A skill is one view.** `skillStore.js:253` builds `SELECT … FROM <view>`
  itself; CTEs and multi-part queries have to become views first. These 9
  insights contain ~20 distinct result shapes.
- **The brand CASE must go.** `runSkill` appends `location_id = $n`
  unconditionally, so a skill only ever sees one account. The CASE is dead
  weight that also returns NULL for any account not hardcoded — and several of
  these list only 2 of the 4.
- **`HAVING count(*) >= 3` must become a `min_*` parameter.** Same call we made
  across the existing 43: a floor baked into the view is someone's guess the
  model cannot revisit.

Each view also needs `WITH (security_invoker = true)` and must select
`location_id`.

## Recommended order

1. **9.1 / 9.2** — one view each, cleanest. 100% theme coverage, no
   multiplication bug, genuinely useful ("what do customers ask about").
2. **5.4 Part A, 5.2 Part A** — one view each, objection/requirement themes.
3. **5.6** — best-designed of the set (baseline comparison, DISTINCT already
   correct), but 3 reads = 3 views.
4. **9.3** — needs the Part B fix and the header correction first.
5. **5.3** — blocked on the hardcoded-stage problem.
6. **9.4 Part B** — the phrase VALUES list is a starting set by her own
   admission; it belongs in a table, not a view.
