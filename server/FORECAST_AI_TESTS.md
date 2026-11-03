# Forecast questions to test Insights AI against

Every equation below is what the views actually compute — read out of
migrations 118–123, not assumed. Ask the question in Insights AI, then check
the answer against the equation and the trap.

The point of each test is the **trap**: a plausible wrong answer the model can
give that still looks right. An answer that avoids the trap is a pass even if
the wording differs.

---

## 1. Expected revenue — the core equation

**Ask:** "What's our expected revenue from open deals?"

```
expected_revenue = Σ (monetary_value × effective_probability / 100)
                   for every OPEN deal
```

`effective_probability` follows GHL's resolution order exactly:

| # | Condition | Probability used | `probability_source` |
|---|---|---|---|
| 1 | Pipeline has `use_opportunity_probability` AND deal has one | the deal's | `deal` |
| 2 | Stage has `win_probability` | the stage's | `stage` |
| 3 | Deal has one and sits in NO stage | the deal's | `deal (no stage)` |
| 4 | none of the above | **0** | `none` |

**Trap:** a deal at `probability_source = 'none'` contributes **£0** to
expected revenue. It is not forecast at 0% — it has no probability set at all.
A model that reports expected revenue without mentioning
`value_without_probability` is hiding money that is invisible in the total.

**Pass:** names expected revenue AND says how much open value carries no
probability. Ask "how much is missing a probability?" — it should match
`value_without_probability` from the same lookup.

---

## 2. Max potential vs expected vs open

**Ask:** "What's the most we could make from the current pipeline?"

```
max_potential_revenue = open_value + won_revenue     ← includes WON
expected_revenue      = Σ weighted open value        ← open only
open_value            = Σ open monetary_value        ← unweighted
```

**Trap:** these three are different and routinely conflated.
`max_potential_revenue` deliberately includes **already-won** revenue, so it is
not "what the live pipeline could become". If the question is about live
pipeline, `open_value` is the honest number.

**Pass:** distinguishes them, or asks which you meant. Quoting
`max_potential_revenue` as the pipeline ceiling without saying won deals are
inside it is a fail.

---

## 3. Weighted coverage

**Ask:** "What's our weighted coverage?"

```
weighted_coverage_pct = expected_revenue / open_value × 100
```

**Trap:** this is the average probability across the pipeline *weighted by
deal size* — not `avg_probability`, which is the plain mean. A pipeline with
one huge 10% deal and ten tiny 90% deals has a high `avg_probability` and a
low `weighted_coverage_pct`. They answer different questions.

---

## 4. A specific future month

**Ask:** "How much do we expect to close in December 2026?"

```
expected_value (per month) = Σ weighted_value
                             WHERE forecast_close_date falls in that month
```

**Trap 1 — the missing bucket.** This is the sharpest test in the set, because
the two forecast views behave differently:

- `vw_forecast_by_month` (skill `forecast_by_month`) has
  `WHERE forecast_close_date IS NOT NULL` — deals with no close date are
  **excluded entirely**. Sum its months and you get less than the pipeline.
- `vw_forecast_timeline` keeps them as a literal `(no close date)` row in its
  `period` column.

So a model answering from `forecast_by_month` alone can total the months,
present it as the forecast, and be silently short. Ask the follow-up: "how
much open value has no close date?" — `forecast_readiness` carries it as
`missing_close_date` with `value_affected`.

**Trap 2 — overdue.** `overdue_deals` counts open deals whose forecast close
date is already in the past. They are still in the pipeline and still weighted,
but the date is wrong, so their month is fiction.

**Pass:** gives the month's figure AND flags the no-close-date bucket.

---

## 5. Growth between periods

**Ask:** "Is our forecast growing month on month?"

```
expected_change     = this period's expected − previous period's
expected_change_pct = expected_change / previous × 100
```

**Trap:** `expected_cumulative` and `won_cumulative` are **running totals** —
they only ever rise. A chart of either shows growth during a quarter where
revenue fell. (This is a real bug we fixed in the charting layer: it picked
`won_cumulative` and drew growth across a quarter that was down 29%.) The
period-over-period columns are `expected_change` / `won_change`.

**Pass:** uses the change columns, not the cumulative ones, to answer
"growing?".

---

## 6. Slippage

**Ask:** "Which deals keep slipping?"

```
value_at_risk    = Σ monetary_value of slipped deals
avg_days_slipped = mean days the close date moved LATER
avg_times_pushed = mean number of close-date changes per deal
```

Derived from `opportunity_field_history`, not a stored counter — so it reflects
actual edits.

**Trap:** `worst_days_slipped` is one deal. A model quoting it as typical is
wrong; `avg_days_slipped` is the typical case. Also a deal pushed once by 200
days and one pushed ten times by 2 days each are different problems with
similar `value_at_risk`.

---

## 7. Readiness — the "fix your forecast" checks

**Ask:** "Is our forecast data any good?"

Three checks on open deals, each with `severity`, `value_affected`,
`open_deals`, `pct_of_open` and a `consequence`:

| Check | Meaning |
|---|---|
| `missing_close_date` | no forecast close date — lands in `(no close date)` |
| `missing_value` | value ≤ 0 — contributes nothing to any total |
| `overdue_close_date` | close date already past |
| `no_probability_anywhere` | neither deal nor stage has one — weighted at £0 |

**Pass:** reads `consequence`, which says what each gap does to the forecast,
rather than just listing counts.

---

## 8. The hardest one — a number that cannot be derived

**Ask:** "What's our forecast for next quarter, by rep, weighted?"

**Trap:** `forecast_breakdown` cuts by status, rep, pipeline or stage — but
`forecast_by_month` is where the time dimension lives. Combining "by rep" AND
"next quarter" AND "weighted" may need two lookups, and the model must not
multiply one by the other to fake it.

**Pass:** either runs both and reconciles, or says which cut it can give.
Inventing a per-rep quarterly figure from a single lookup is the failure mode
worth catching.

---

## 9. Cross-check (the one that catches arithmetic)

Ask these three in one conversation:

1. "What's our open pipeline value?"
2. "What's our expected revenue?"
3. "What's our weighted coverage?"

**Check:** `(2) ÷ (1) × 100` must equal `(3)`, within rounding. If it does not,
the model has pulled numbers from different filters or different turns and
presented them as one picture.

---

## 10. Grounding — should trigger the warning

**Ask:** "Which deal is most likely to close next month, and what's it worth?"

A single named deal with a figure is exactly what `groundingCheck.js` watches:
if the model names a deal and a number no lookup returned, the **"Check this
one"** banner should appear under the answer.

**Pass:** either the figure traces to a lookup, or the banner fires. A named
deal, a confident figure, and no banner means the check missed it — tell me
and I will look at the grounding rule.

---

## How to read the result

Under each answer, the **"Answered using"** line now names every skill that
ran and how many rows each returned. Two things to watch:

- **0 rows** — the skill ran and found nothing. If the answer still states a
  figure, it came from somewhere else. That is the strongest signal available.
- **One skill, one row, broad question** — thin ground. Not wrong by itself,
  but worth checking against the equation above.
