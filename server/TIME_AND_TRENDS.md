# Answering "how has this changed?"

There are two kinds of "over time" question and they have completely different
answers. Getting them confused is the main way this goes wrong, so the split
comes first.

| | **Event questions** | **State questions** |
|---|---|---|
| Example | "How much did we win in August?" | "Was our no-task rate better in August?" |
| Anchored to | A timestamp on the row — `won_at`, `created_at_ghl`, `message_timestamp` | Nothing. The row just *is* a certain way today |
| History | **Complete, going back years** | **Only from the day capture started** |
| Needs | Grouping by period | A nightly snapshot |
| Built in | Migration 117 | Migration 116 |
| Backfillable | N/A — nothing to backfill | **No. Never.** |

## Why state questions are hard

`opportunities` holds current state. When a rep books a task on a deal, the row
changes — the fact that the deal had nothing booked yesterday is not archived,
it is **gone**.

So "has our no-task rate improved since last month?" is not a hard query. It is
an **impossible** one, and no view can fix it. The history was never written
down.

That is what `pipeline_snapshots` fixes, going forward only. The first row lands
the day the job first runs; the first month-over-month comparison is possible a
month later. Nothing is retroactive.

`stage_history` is the exception among the source tables — it keeps a row per
stage entry with `entered_at`, so stage movement genuinely is a timeline.

---

## Event-based: `vw_won_value_by_month`, `vw_enquiries_by_month`

No capture needed, full history, available immediately.

**The two group by different things, deliberately.** `won_value_by_month` groups
by the month a deal was *won*. `enquiries_by_month` groups by the month it was
*created*, then follows that cohort to its outcome. The same deal falls in
different months in each. "What did we close in August" and "what became of
August's leads" are different questions; mixing them gives nonsense, and both
skills say so.

**Recent cohorts are unfinished.** August's enquiries have had two months to
close; this month's have had days. So a recent month's win rate is drawn from
very few closed deals and is not comparable with an older one. Enquiry *counts*
are comparable immediately; win *rates* are not. The skill instructs the model
to say this rather than reporting a misleading improvement.

**Empty months produce no row, not a zero.** "We won nothing in July" and "July
is missing from this account" are different findings, and a generated zero makes
them identical. `months_since_previous` flags any comparison that skips months.

---

## State-based: `pipeline_snapshots` → `vw_pipeline_trend`

One row per sub-account per day. What it records:

- Pipeline shape — open deals, open value, lifetime won/lost/abandoned
- Hygiene — no task, no task anywhere, no notes, no reply, stagnant 30d
- Field completeness — the same four stand-in fields as `rep_field_completeness`
- Coverage — deals with a postcode, notes written, distinct note authors

**Definitions are copied from the live views** (`vw_open_deals_no_task_by_stage`,
`vw_open_deals_note_quality_by_stage`, `vw_rep_field_completeness`) so a trend
and a current reading never disagree. If you change one, change the other.

**Rates, not counts.** A pipeline that grew shows more untouched deals while
being better kept — the raw counts say the opposite of the truth. The view
carries `pct_no_task`, `pct_no_notes`, `pct_stagnant` for this reason, and the
skill tells the model to lead with them.

**Negative change is an improvement** in any `pct_` column. "Improved by 4
points", never "fell by 4", which reads as getting worse.

**Gaps are visible.** `days_since_previous` is normally 1. If the job misses
days, the comparison is against the last reading that exists and the gap is
stated, rather than a four-day change being labelled daily.

### Running it

Nightly at 03:30 via `startPipelineSnapshotCron`, wired in `src/index.js`.
That is 30 minutes after the daily sync sweep — a snapshot taken before the
syncs finish records yesterday's pipeline under today's date, and nothing on the
row would say so. Override with `PIPELINE_SNAPSHOT_CRON`.

By hand:

```bash
node src/scripts/captureSnapshot.js                    # every install
node src/scripts/captureSnapshot.js <location_id>      # one
```

**Take the first reading manually rather than waiting for tonight.** Every day
without it is a day of history that cannot be recovered.

The write is `ON CONFLICT DO UPDATE`, so re-running replaces that day's row
rather than adding a second — safe to re-run after fixing a bug. `--date` writes
*today's* numbers under an earlier date, which is only ever right when the job
failed and the pipeline has not moved since. It cannot reconstruct the past.

---

## Adding a metric to the snapshot

1. Add the column to `pipeline_snapshots` in a **new migration** (never edit an
   applied one).
2. Add the count to `SNAPSHOT_SQL` in `src/services/pipelineSnapshot.js`, and to
   both the `INSERT` column list and the `ON CONFLICT DO UPDATE` clause. Missing
   the second means the value is written once and never refreshed on a re-run.
3. Expose it in `vw_pipeline_trend`, with a `lag()` change column if it is worth
   trending.
4. Update `data/skills/pipeline-trend.json` if the model needs to know about it.

**Every CTE in `SNAPSHOT_SQL` must carry `location_id = $1`.** The app connects
as `postgres`, which has `rolbypassrls = true`, so the RLS policies on these
tables never apply. This was not hypothetical during development: the first test
run wrote 4 open deals for an account that had 3, the fourth belonging to the
other sub-account. Relying on RLS here silently merges every account's data.

Old rows are kept indefinitely. One row per account per day is a few hundred
rows a year — not worth a retention policy until it is.

---

## What is still not answerable

**Per-rep or per-stage trends.** The snapshot is account-level only.
"Was Liam's no-task rate worse in August?" needs a per-rep snapshot, which
multiplies rows by the number of reps. Worth adding if someone asks; not worth
collecting a dimension nobody reads.

**Anything about a period before capture started.** If asked, the skill says
plainly that it was not being recorded then, rather than presenting the earliest
row as if it were that period.

**Most of the other 30 views are still all-time.** `vw_source_won_value`,
`vw_conversion_by_area`, `vw_rep_stage_conversion` and the rest aggregate over
everything and throw the period away. They are all event-based, so adding period
grouping is real work but needs no capture and loses nothing while waiting.
Migration 117 does the two highest-value ones; the pattern is there to follow.
