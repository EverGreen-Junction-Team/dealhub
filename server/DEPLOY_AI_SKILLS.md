# Deploying the analytics skills

Two sub-accounts:

| Name     | locationId             |
|----------|------------------------|
| Crittall | `fJNuIdxGgchGpJ9OoBbk` |
| BGD      | `IFcSg4YvuVlx56msjbdf` |

Order matters: **migrations create the views, the seed script registers skills
against them.** Running the seed first fails every skill with "No view named …",
which is a safe failure but a wasted run.

---

## Before you start

Confirm what the target database already has. This is the only thing that makes
step 2 behave differently than expected:

```sql
SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 5;
```

If `087_vw_close_without_win_partition.sql` is not there, everything below still
works — the runner applies what is missing, in order.

---

## 1. Commit the work

28 migrations, 32 skill definitions, the seed script and one validator change
are currently untracked:

```bash
cd pipelinePulse/server
git checkout -b ai-skills-analytics
git add migrations/ data/skills/ src/scripts/seedAiSkills.js \
        src/services/ai/skillValidator.js package.json DEPLOY_AI_SKILLS.md
git commit
```

The validator change affects more than this feature: it widens the `order_by`
grammar to accept `NULLS FIRST|LAST`, which the Control panel form now also
accepts. It is still a fixed grammar — expressions and function calls are
refused exactly as before.

## 2. Run the migrations

```bash
npm run migrate
```

Each file runs in its own transaction and is recorded in `schema_migrations`;
a failure rolls that file back and stops. Re-running is safe and skips what is
already applied.

Expected: 34 applied (088–121), the rest skipped. Then confirm the views exist
and carry `security_invoker`:

```sql
SELECT count(*) FILTER (WHERE reloptions::text LIKE '%security_invoker=true%') AS ok,
       count(*) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname LIKE 'vw_%';
```

`security_invoker` needs **Postgres 15+**. Supabase is well past that; a local
Postgres 14 rejects every view with `unrecognized parameter`.

## 3. Register the skills

Dry run first — it writes nothing:

```bash
npm run seed:skills -- fJNuIdxGgchGpJ9OoBbk IFcSg4YvuVlx56msjbdf --dry-run
```

Expect `created 40  skipped 0  failed 0` per location on a fresh account. Then:

```bash
npm run seed:skills -- fJNuIdxGgchGpJ9OoBbk IFcSg4YvuVlx56msjbdf
```

## 3a. Take the first snapshot

Do this the same day, not tomorrow. `pipeline_snapshots` records state that
cannot be reconstructed — every day without it is a day of history lost:

```bash
node src/scripts/captureSnapshot.js
```

After this the nightly cron (03:30, after the daily syncs) keeps it running.
`pipeline_trend` has one row per account until then and becomes useful for
month-over-month comparison a month later. See TIME_AND_TRENDS.md.

The script skips any skill an account already has, by name, so it is safe to
re-run after adding one — it registers only what is new. It exits non-zero if
any skill fails.

Skills are created **enabled**, on the **portfolio** surface (Insights AI) only.
That is deliberate: all 32 answer across deals rather than about one.

## 3b. Forecast (migrations 118–121)

Five of the 40 skills are the Forecast set, mirroring GHL's Opportunities →
Forecast tab. They need no extra steps — the migrations create the views and
the seed registers the skills — but check the coverage before trusting the
numbers:

```sql
SELECT location_id, open_opportunities,
       pct_with_close_date, pct_without_probability
  FROM vw_forecast_summary;
```

Measured here, **5–15% of open deals carry an expected close date**. Every
period forecast describes only those deals, so `forecast_by_month` returns a
`(no close date)` row carrying the rest — frequently the largest row in the
result. That is deliberate: GHL shows the same deals in a visible column
beside the dated ones, and a chat answer drops a caveat far more easily than
a UI hides a column.

Deal AI gets the same forecast facts per deal through its context (resolved
probability, where it came from, weighted value, slip history) — no extra
registration, since Deal AI has no tool loop and reads a prepared context.

**Known gap:** [backfillOpportunityCustomFields.js:55](src/scripts/backfillOpportunityCustomFields.js#L55)
writes `forecast_expected_close_date`; the column is `forecast_close_date`.
That backfill's date column has never landed. The live webhook path writes the
right column, so this is not why coverage is low — reps are mostly not setting
close dates — but it should be fixed.

## 4. Check it from the product

Open Insights AI on Crittall and ask something each kind of skill answers:

- "where do deals go quiet" → `open_deals_no_task_by_stage`
- "which buyer type makes us the most money" → `buyer_type_revenue_share`
- "do we use notes" → `note_adoption`

Then the same on BGD, and confirm the numbers differ. Two accounts returning
identical figures means the tenant filter is not being applied — the one
failure worth stopping for.

---

## What to expect in the answers

Real properties of the data, not faults. Worth knowing before someone reports
them as bugs.

**Several skills may return nothing at first.** `product_type_conversion`,
`buyer_type_revenue_share` and the paid-campaign skills depend on fields that
may be empty in an account — no product ticked, no `client_type`, no Google
click ids. An empty result is a real answer and the skills say so rather than
reading as an error.

**Run the coverage skills first for each account.** `location_data_coverage`
and `note_adoption` exist to say whether the other answers mean anything. At
40% postcode coverage, an area map describes 40% of the business.

**The numbers have never been checked against production data.** Every view was
executed against a seeded test database — 0 runtime errors, 0 cross-tenant
leaks — but `DATABASE_URL` is empty in this working copy, so no figure here has
been compared to a real pipeline. Sanity-check a few totals against the
dashboard before anyone acts on them.

---

## Rolling back

Skills, per account:

```sql
DELETE FROM ai_skills WHERE location_id = 'fJNuIdxGgchGpJ9OoBbk';
```

The views are read-only and additive — nothing else reads them, so leaving them
costs nothing. To remove one anyway: `DROP VIEW vw_…;` once its skill rows are
gone.

---

## Still outstanding

- **`rep_field_completeness` measures four stand-in fields, not the mandatory
  list.** Charlie has not supplied the real one. The skill says so in its
  description, but the caveat should be removed by fixing the view rather than
  carried indefinitely.
- **Stale provider rows** on Crittall:
  `DELETE FROM conversation_providers WHERE location_id = 'fJNuIdxGgchGpJ9OoBbk' AND last_seen_via = 'daily_sync';`
- **The dashboard has not been deployed this session.** The date picker, input
  focus, "All pipelines" default, @-mentions, the skills UI and the markdown
  fixes are all still local.
- **The app connects as `postgres`, which has `rolbypassrls = true`.** Every
  RLS policy is skipped. The skills carry an explicit `location_id` predicate
  in the query, so they are scoped regardless — but RLS is not the backstop it
  reads as. A non-superuser application role would make it one.
