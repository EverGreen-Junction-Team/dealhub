# Deploy — everything from this session

8 migrations (126–133), 13 new skills, and a full dashboard rebuild.
Both repos are **already committed and pushed** — nothing to commit.

Read §0 before starting. Two steps are easy to get wrong in a way that is
hard to see afterwards.

---

## 0. Before you start

**Postgres 15+ is required.** Migrations 129–132 create views with
`security_invoker`, which does not exist on 14. Fifty existing migrations
already use it, so production is fine — this only matters if you point at an
older copy.

```sql
SHOW server_version;
```

**Take a backup.** Everything here is additive, but 127 inserts 7,366 rows
and 133 rewrites two columns on `users`.

**Migration 127 is 3.7 MB.** It runs in one transaction, takes seconds not
minutes, and must not be interrupted.

---

## 1. Server

```bash
cd /path/to/pipelinePulse/server
git pull
npm ci --omit=dev
npm run migrate          # → ran 8, skipped 125
npm run verify:misha     # → ALL CHECKS PASSED
pm2 restart pipelinepulse-server
```

What the 8 migrations do:

| # | Does |
|---|---|
| 126–128 | Creates the `misha` schema, loads 7,366 rows, adds constraints |
| 129 | 9 voice-of-customer views |
| 130 | 6.4 + 5.5 — requirements by buyer/product, stated budget vs quote |
| 131 | Forecast KPI strip **by pipeline** (GHL's pipeline dropdown) |
| 132 | Deal **names** on the quote/reply/budget views |
| 133 | `users.user_type` + backfill + **repairs `users.role`** |

### 1a. Register the skills — `--update-existing` is required

```bash
node src/scripts/seedAiSkills.js --dry-run \
  IFcSg4YvuVlx56msjbdf kHcvavc8fEeqkEPTK2T8

node src/scripts/seedAiSkills.js --update-existing \
  IFcSg4YvuVlx56msjbdf kHcvavc8fEeqkEPTK2T8
```

Expect `created 13 … n/a 3` per location, ending at **56 skills**.

**Without `--update-existing` the run looks successful and is wrong.** The
script skips any skill a location already has, so the three descriptions
changed in 132 — the ones telling the model to say a deal's NAME rather than
`2lVBs41TxfmKK8U03fIn` — would not update. The ids would keep appearing.

`n/a 3` is normal: the paid-ads capability probe withholds three ad skills
from accounts with no Google click-id data. `failed` should be 0.

```sql
SELECT location_id, count(*) FROM ai_skills GROUP BY location_id;  -- 56 each
```

---

## 2. Dashboard

**This has not been deployed at all this session**, so every UI fix below is
still unreleased.

```bash
cd /path/to/pipelinePulse-dashboard
git pull
npm ci
npm run build
# deploy dist/ however this app is served
```

What is in it:

| Fix | Was |
|---|---|
| Grounding banner is **clay, not red** | Read as an error when it is a caution |
| Chat no longer clips sideways | 7 nesting levels needed `minWidth: 0` |
| Skill numbers formatted | `5161632.0900000000000000` → `5,161,632.09` |
| "Used this skill" line | New — names every skill that ran, with row counts |
| Chart labels by subject | Five bars all reading "homeowner" |
| Sent email stays sent | **Could send twice** — see below |
| 409 settles the card | Confirm AND Cancel were both stuck |
| Location switch clears state | **One account's chat under another's name** |
| Signature editor: colour + image | Toolbar had neither |
| Custom field folders closed on deals | 22 fields pushed People/Tasks off screen |
| Location name + divider removed | Duplicated GHL's own sidebar |

---

## 3. Check it worked

**Insights AI** — ask these, then read the "Used this skill" line:

- *"What do customers ask about on deals we lost?"* → `customer question themes`
- *"What's the expected revenue for the Paul Tween pipeline?"* →
  `forecast summary by pipeline`, **not** `forecast summary`. If it says the
  latter it is quoting the account-wide total as one pipeline's.
- *"Show me the quotes behind that"* → must name **deals, not ids**.

**Deal AI** — on any deal: *"what did this customer ask for?"* It now runs
tools scoped to that deal (29 of 50, plus 20 write tools) instead of a single
pre-built context.

**Owner dropdown** — agency users are gone:

```sql
SELECT name, user_type FROM users
 WHERE location_id = '<id>' AND active AND deleted_at IS NULL
 ORDER BY user_type NULLS LAST;
```

---

## 4. Two things that could bite

**Deal AI changed engine.** It was one `callClaude` against a fixed context;
it now runs the tool loop. Citation validation is kept — every factual
sentence still needs a verbatim quote — but it moved to a second pass after
the answer is written. **Test this on one sub-account before rolling out.**

**133 rewrites `users.role`.** It was NULL on every user whose payload used
GHL's current `roles` object shape, and the migration repairs it from
`raw_user`. That is a fix, but it is a write to existing data — check a few
rows before and after if anything reads `role`.

---

## 5. Rollback

Skills:

```sql
DELETE FROM ai_skills WHERE location_id = '<id>' AND name IN (
  'customer_question_themes','customer_objection_themes','requirement_lost_value',
  'requirement_quotes','requirement_vs_baseline','reply_stage_movement','reply_list',
  'close_reason_by_buyer_type','enquiry_text_coverage','requirement_by_buyer_product',
  'stated_budget_vs_quote','stated_budget_coverage','forecast_summary_by_pipeline');
```

Views only (data kept):

```sql
DROP VIEW IF EXISTS vw_customer_question_themes, vw_customer_objection_themes,
  vw_requirement_lost_value, vw_requirement_quotes, vw_requirement_vs_baseline,
  vw_reply_stage_movement, vw_reply_list, vw_close_reason_by_buyer_type,
  vw_enquiry_text_coverage, vw_requirement_by_buyer_product,
  vw_stated_budget_vs_quote, vw_stated_budget_coverage,
  vw_forecast_summary_by_pipeline;
DELETE FROM schema_migrations WHERE filename LIKE '129%' OR filename LIKE '13%';
```

Everything including the misha data:

```sql
DROP SCHEMA misha CASCADE;   -- takes the views with it, they read misha.*
DELETE FROM schema_migrations WHERE filename ~ '^(12[6-9]|13[0-3])_';
```

`users.user_type` is additive — leave it; nothing breaks if it stays.

---

## 6. Expected, not bugs

- **Omnia (`E0nGtwuWd1cmeoc6ilD1`)** has requirements but no theme vocabulary.
  Its 3 labels show `(no theme mapped)`.
- **`(no theme mapped)` vs `Other / uncategorized`** are different and must
  not be merged. The second is a bucket misha chose; the first means the
  lookup has never seen that label.
- **`offered` is 'not yet classified' on every row** — the classification
  table is genuinely empty.
- **Only 14 deals have a stated budget.** `stated_budget_vs_quote` is a list
  by design.
- **`user_type IS NULL` users still appear** in the dropdown. Unknown is not
  known-agency, and hiding a real rep is worse than one extra name.
- **Agency users still appear in `vw_rep_*` views** if a deal is actually
  assigned to them. That is real data, not a listing bug.
- **The misha data is frozen at 2 Oct 2026.** A refresh is a new migration
  that truncates `misha.*` first — never a re-run of 127.
