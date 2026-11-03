# Deploy — misha data + 12 voice-of-customer skills

Five migrations (126–130) and 12 skills. Nothing here touches `public` tables
that already exist: 126–128 create the `misha` schema, 129–130 add views only.

## Before you start

- Postgres **15+** is required. `security_invoker` on the new views needs it,
  and the migration will fail on 14. (50 existing migrations already use it,
  so production is fine — this matters only if you point at an older copy.)
- Migration 127 is **3.7 MB / 7,366 rows**. It runs in one transaction and
  takes a few seconds, not minutes, but do not kill it halfway.
- Take a backup first. 126–130 are additive, but 127 has no `ON CONFLICT`:
  running it twice outside the migration runner would duplicate every row.
  Inside the runner that cannot happen — `schema_migrations` guards it.

## 1. Ship the code

```bash
git add server/migrations/12[6-9]_*.sql server/migrations/130_*.sql \
        server/data/skills/*.json \
        server/MISHA_HANDOFF.md server/MISHA_INSIGHTS_REVIEW.md
git commit -m "misha schema import + 12 voice-of-customer skills"
git push
```

On the server:

```bash
cd /path/to/pipelinePulse/server
git pull
npm ci --omit=dev
```

## 2. Migrate

```bash
npm run migrate
```

Expect `ran 5, skipped 125`. The runner wraps each file in its own
transaction and records it in `schema_migrations` only on COMMIT, so a
failure rolls that file back entirely and re-running retries just it.

Verify:

```sql
SELECT (SELECT count(*) FROM misha.deal_extracts)         AS deal_extracts,  -- 3926
       (SELECT count(*) FROM misha.requirements)          AS requirements,   -- 1347
       (SELECT count(*) FROM misha.replies)               AS replies,        -- 1169
       (SELECT count(*) FROM misha.requirement_theme_map) AS req_themes,     -- 1328
       (SELECT count(*) FROM misha.question_theme_map)    AS q_themes;       -- 596

-- all 12 views present and tenant-safe
SELECT c.relname,
       c.reloptions::text LIKE '%security_invoker=true%' AS sec_inv
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'v'
   AND c.relname IN ('vw_customer_question_themes','vw_customer_objection_themes',
     'vw_requirement_lost_value','vw_requirement_quotes','vw_requirement_vs_baseline',
     'vw_reply_stage_movement','vw_reply_list','vw_close_reason_by_buyer_type',
     'vw_enquiry_text_coverage','vw_requirement_by_buyer_product',
     'vw_stated_budget_vs_quote','vw_stated_budget_coverage')
 ORDER BY 1;
```

12 rows, `sec_inv` true on every one. If any row is missing or false, stop —
a skill pointing at a view without `security_invoker` is refused on
registration, and one that slipped through would read across sub-accounts.

## 3. Register the skills

Location ids are **positional arguments**, not a flag:

```bash
# dry run first — prints what it WOULD do, writes nothing
node src/scripts/seedAiSkills.js --dry-run IFcSg4YvuVlx56msjbdf kHcvavc8fEeqkEPTK2T8

# then for real
node src/scripts/seedAiSkills.js IFcSg4YvuVlx56msjbdf kHcvavc8fEeqkEPTK2T8
```

Expect `created 12  skipped 0  failed 0  n/a 3` per location.

`n/a 3` is normal: the script probes whether the account has any Google
click-id or UTM data and withholds the three paid-ads skills when it does
not. It is a capability check, not a failure.

`failed` should be 0 in production, where all 43 existing views are present.
A non-zero count names the skills and why — read it rather than assuming the
run worked.

Re-running is safe: the second run reports `created 0  skipped 12`, because
the script skips any skill the location already has by name.

`npm run seed:skills` is the same script with no arguments — it will do
nothing without location ids.

Verify:

```sql
SELECT location_id, count(*) FROM ai_skills GROUP BY location_id;
```

Each registered location should now be at **55**.

## 4. Restart

```bash
pm2 restart pipelinepulse-server
pm2 logs pipelinepulse-server --lines 50
```

Skills are read per question from `ai_skills`, so a restart is not strictly
required for them to appear — but do it so the process is running the code
that was just pulled.

## 5. Check it works

Ask Insights AI something only the new skills can answer:

- "What do customers ask about on deals we lost?"      → customer_question_themes
- "What do architects want that homeowners don't?"     → requirement_by_buyer_product
- "Show me the quotes behind that"                     → requirement_quotes

In Deal AI, on any deal: "what did this customer ask for?" →
requirement_quotes / reply_list / stated_budget_vs_quote are the three
registered on the deal surface.

## Rollback

Skills:

```sql
DELETE FROM ai_skills
 WHERE location_id = '<id>'
   AND name IN ('customer_question_themes','customer_objection_themes',
     'requirement_lost_value','requirement_quotes','requirement_vs_baseline',
     'reply_stage_movement','reply_list','close_reason_by_buyer_type',
     'enquiry_text_coverage','requirement_by_buyer_product',
     'stated_budget_vs_quote','stated_budget_coverage');
```

Views (data untouched):

```sql
DROP VIEW IF EXISTS vw_customer_question_themes, vw_customer_objection_themes,
  vw_requirement_lost_value, vw_requirement_quotes, vw_requirement_vs_baseline,
  vw_reply_stage_movement, vw_reply_list, vw_close_reason_by_buyer_type,
  vw_enquiry_text_coverage, vw_requirement_by_buyer_product,
  vw_stated_budget_vs_quote, vw_stated_budget_coverage;
DELETE FROM schema_migrations WHERE filename IN
  ('129_vw_misha_voice_of_customer.sql','130_vw_misha_requirements_and_price.sql');
```

Everything, including the data:

```sql
DROP SCHEMA misha CASCADE;   -- drops the 12 views too, they read misha.*
DELETE FROM schema_migrations WHERE filename LIKE '12[6-9]%' OR filename LIKE '130%';
```

## Known, expected, not bugs

- **Omnia (`E0nGtwuWd1cmeoc6ilD1`)** has requirements but no theme vocabulary.
  Its 3 labels show `(no theme mapped)`. Correct behaviour.
- **`(no theme mapped)` vs `Other / uncategorized`** are different things and
  must not be merged. The second is a real bucket misha chose; the first means
  the lookup has never seen that label. Today the first returns zero rows.
- **`offered` is 'not yet classified' on every row** of
  `requirement_lost_value`. The classification table is genuinely empty
  (0 rows). The skill description tells the model it cannot say what we do
  NOT offer — that is the honest state, not a defect.
- **Only 14 deals carry a stated budget.** `stated_budget_vs_quote` is a list
  by design; `stated_budget_coverage` exists to put that count in front of
  the model before it generalises.
- **The misha data is a snapshot frozen 2 Oct 2026.** It does not update when
  misha re-runs her extractor. A refresh is a new migration that truncates
  `misha.*` first — never a re-run of 127.
