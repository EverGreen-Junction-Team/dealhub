# Message-to-Deal Linking Rule

**Status:** agreed with James Stevens, 8 Sep 2026 (call transcript + written spec).
**Applies to:** every message that arrives by webhook or sync, and retrospectively
to all existing messages.

---

## The rule

When a message arrives, look at the contact's opportunities with **status = Open**:

| Situation | Outcome |
|---|---|
| Exactly one Open opportunity | Link the message to it |
| More than one Open opportunity | Link to the **earliest-created** Open opportunity |
| No Open opportunities (none at all, or only Won / Lost / Abandoned) | Leave the message **unlinked** — it stays on the contact record |

A link can always be **changed manually** by a sales manager, from the dropdown
in Deal Hub or on the contact record. A manual link may point at a Won, Lost or
Abandoned deal if that is what they choose — the Open-only restriction governs
the *automatic* rule, not human judgement.

Every link records **whether it was automatic or manual**.

---

## Worked example

Contact A has 20 messages, contact B has 10.
Both are linked to **Deal 1**. Contact B is *also* linked to **Deal 2**.

- All 30 messages link to **Deal 1** — it is the earliest-created Open deal for
  both contacts.
- Contact B's messages do **not** also appear on Deal 2. A message belongs to one
  deal.
- To put a specific message of B's on Deal 2, a sales manager moves it manually.

This was the point James corrected on the call: a contact on two deals does not
mean their messages appear on both.

> *"100% of his messages can't go to Deal 1 and also to Deal 2. There needs to be
> a filtering mechanism."* — James, 8 Sep

---

## Two definitions that matter

**"Closed" is not a GHL status.** GHL uses `open`, `won`, `lost`, `abandoned`.
James's phrase "every stage except closed" means **`status = 'open'` only** —
Won, Lost and Abandoned are all treated as closed for the automatic rule.
Getting this wrong would misroute every message on a won deal.

**"Earliest-created" means GHL's `date_added`**, not when our sync first saw the
deal. The two differ for backfilled deals, and GHL's own timestamp is the one a
sales manager would recognise.

---

## Why the automatic rule stops at "Open"

Left to itself, an unlinked message is recoverable — it sits on the contact and a
human can file it. A *wrongly* linked message is not: it appears in the wrong
deal's history, and in the AI context for that deal, with nothing to signal the
error. So where the rule cannot be certain, it declines rather than guesses.

---

## What this replaces

The previous engine (`src/services/attributionEngine.js`) tried four rules in
order and gave up when a contact had two open deals:

| # | Rule | Confidence |
|---|---|---|
| 1 | `single_open_opp` — exactly one open deal | 0.95 |
| 2 | `stage_containment` — timestamp inside exactly one stage window | 0.90 |
| 3 | `only_active_at_time` — several deals, one active then | 0.75 |
| 4 | `single_lifetime_opp` — only ever one deal | 0.60 |

Rule 1 required *exactly* one open deal (`rows.length !== 1` returned null), so
two open deals fell through to the weaker rules and frequently terminated as
`ambiguous` — the message appeared on no deal at all. That is the behaviour
this rule replaces: with two open deals we now pick the earliest rather than
declining.

Rules 2–4 remain as fallbacks for the zero-open-deals case.

---

## The backfill uses a different rule — deliberately

The live rule asks *"which of the contact's deals is Open?"*. Applied to old
messages that answers almost nothing: most deals from months ago are now Won or
Lost, so nearly every historic message would end up unlinked.

So the retrospective pass asks the same question **as at the message date**. A
deal was open on that date when:

1. it was created on or before the message date, **and**
2. it had not yet been Won / Lost / Abandoned — i.e. it is still open now, **or**
   its status changed *after* the message date

Then, exactly as the live rule: one match links, several link to the
earliest-created, none leaves the message unlinked.

**Worked example** — Karen's deal created 1 March, marked Won 20 March:

| Message date | Deal state then | Outcome |
|---|---|---|
| 10 March | open | linked |
| 25 March | already won | unlinked |
| 20 February | did not exist | unlinked |

Implemented in `src/scripts/backfillMessageAttribution.js`
(`npm run backfill:message-attribution`). Supports `--dry-run`, `--location=`
and `--limit=`.

One subtlety worth keeping: the cut-off is the **earliest** of
`won_at` / `lost_at` / `abandoned_at`, not the latest. A deal won in February
and later marked lost in April stopped being open in February.

---

## Manual links are never overwritten

This is the constraint the implementation must not lose. Re-running attribution
— on a backfill, a re-sync, or the retrospective pass — must **skip any mapping
marked manual**. A sales manager's decision outranks the engine permanently.

`message_opportunity_map` already carries `superseded_at`, so a re-map is
recorded as history rather than an overwrite; the manual flag is what tells the
engine to leave a row alone.

---

## Where the linking happens

- **Webhook path** — `messageWriter.js` (`upsertMessage`), as each message
  arrives
- **Sync path** — `messagesSync.js`, which already calls the same
  `upsertMessage`, so it inherits the rule automatically. Verified, not assumed:
  `messagesSync.js:23` imports it and `:177` calls it. Nothing extra to change
  there.
- **Retrospective** — a one-off migration re-mapping existing messages,
  preserving anything already set manually

Because both live paths share `upsertMessage`, the rule needs implementing in
**one** place. Keep it that way — a second copy of a rule this consequential
will drift from the first.

### It also governs tasks and notes

`ruleSingleOpenOpp` is not only used for messages. `noteWriter.js` and
`taskWriter.js` both import `resolveOppForContact`, which runs the same four
rules in the same order (`attributionEngine.js:170`). So a task or note created
against a contact with two open deals is currently left unattributed for exactly
the reason messages were.

Fixing rule 1 therefore fixes all three at once — one change, three benefits.
Worth knowing before testing: a change here that looks message-only will move
task and note attribution too, and that is intended.

---

## Related constraint: tasks and notes

GHL blocks task relation writes over OAuth entirely
(`Relations cannot be modified via OAuth channel` — their `tasks.service.ts`
rejects any task write carrying `relations` on the OAuth channel). Note
relations need a `notes.write` scope the app does not hold.

So deal and company links for tasks and notes are held **in our database only**,
and edited in our UI. `tasks` and `notes` already carry `opportunity_id` and
`business_id` columns (migrations 015 and 061). See
`src/services/ghlAssociations.js` for the full endpoint findings.
