# misha-refresh

Keeps the `misha` schema current — `deal_extracts`, `requirements`, `replies`,
`question_theme_map`, `requirement_theme_map` — by extracting facts from
PipelinePulse messages that have arrived since the last run.

It reads `messages`, `opportunities`, `stage_history`, `opportunity_contacts`
and `installs`. It writes **only** into `misha.*`.

## Why the insights were frozen

The misha tables were loaded once by PipelinePulse migration 127 (a snapshot
taken 2 Oct) and never moved after that. The original refresh script could not
run against this database at all: every query read
`m.extraction_ready_body`, a column that does not exist here. PipelinePulse's
equivalent is `message_body` (documented "CLEANED" in migration 001).

So the views and insights were wired correctly and reading real data — it was
just data that could never change. Fixing the column is what makes this job
work; everything else below is about making it safe to leave running.

## Before it can run

Three files from misha's original project are **not** in this repo and the job
will not start without them:

| File | What it is |
|---|---|
| `extraction_prompt.js` | exports `EXTRACTION_SYSTEM_PROMPT` |
| `requirements_prompt.js` | exports `REQUIREMENTS_SYSTEM_PROMPT` |
| `scripts/question_theme_clusters.mjs` | exports `classify(label)` |

They are the prompts and the theme classifier. They are deliberately not
reconstructed here: the wording of those prompts is what the existing 7,366
rows were extracted with, and a reworded prompt would quietly produce
differently-shaped labels that no longer match the theme maps.

## Where this lives

It is a folder inside the PipelinePulse repo, a sibling of `server/`, with its
own `package.json` and its own `.env` — the same shape `server/` has. It is not
imported by the server and the server does not import it; the only thing they
share is the database.

So there is one repo to clone and one deploy. Every command below is run from
this folder.

## Setup

```bash
cd pipelinePulse/misha-refresh
npm install
cp .env.example .env     # then fill in DATABASE_URL and ANTHROPIC_API_KEY
npm run dry-run          # counts the work and the API calls, writes nothing
npm start
```

`DATABASE_URL` is the same database the server uses — copy it from
`server/.env`. `ANTHROPIC_API_KEY` can be the same key too. Keep them in *this*
folder's `.env`: nothing here reads `server/.env`.

`npm run dry-run` makes **no** Claude calls and **no** writes. Run it first on
a new box — it tells you how far behind the watermark is before you spend
anything.

## Scheduling

This is **not** a server. It processes what has arrived and exits. Run it on a
schedule:

```cron
# Hourly, a few minutes past, so it lands after the app's own syncs settle.
# Point the path at wherever PipelinePulse is checked out on the box.
7 * * * * cd /opt/pipelinePulse/misha-refresh && /usr/bin/node refresh.js >> /var/log/misha-refresh.log 2>&1
```

Hourly is cheap: a run with no new messages is one query and an exit. Nightly
is fine too — the only difference is how stale the insights get between runs.

**It must run after PipelinePulse's own daily sync**, not before. The facts are
extracted from `messages` and joined to `opportunities`; if those are stale,
the extraction is stale with them.

Two runs cannot overlap — the job takes a Postgres advisory lock and a second
instance exits immediately without doing anything. That matters because
`misha.replies` has a primary key but **no unique constraint**, and the reply
builder guards with `NOT EXISTS`: two concurrent runs would both see "no reply
yet" and both insert.

## Cost

One Claude call per message, plus a second for every customer message. That is
real money on a busy day, and the original script had no ceiling.

`MAX_MESSAGES_PER_RUN` (default 500) bounds a single run. Hitting the cap is
logged and costs only time — the watermark has not moved, so the next run
continues where this one stopped. Raise it to catch up after an outage.

## Locations

Read from `installs` at run time:

```sql
SELECT location_id FROM installs WHERE uninstalled_at IS NULL
```

A new sub-account is therefore picked up automatically. The original script
had three ids hardcoded, so a fourth client's messages were silently never
extracted — no error, just less work than it appeared to do.

`ONLY_LOCATION_IDS=a,b` pins a run to specific sub-accounts, for re-running one
client after a fix.

## The one thing that needs a human

New **question** labels are classified automatically by
`question_theme_clusters.mjs`.

New **requirement** labels are not — that mapping was built by hand, and there
is no classifier for it. They are inserted as
`'Other / uncategorized, needs review'` rather than guessed.

Every run prints the size of that backlog, not just the labels added today:

```
ACTION NEEDED: 14 requirement label(s) await a real theme.
```

Left unworked, that queue grows and the requirement-theme insights drift
toward "uncategorised" without anything appearing broken. Somebody has to
review `misha.requirement_theme_map` periodically and reclassify.

## What changed from misha's original

1. `extraction_ready_body` → `message_body`. The blocker.
2. Hardcoded `CLIENT_IDS` → `installs`, so locations are dynamic.
3. Added `MAX_MESSAGES_PER_RUN`, a dry run, and per-message error handling
   so one bad message cannot end a run.
4. Added an advisory lock so scheduled runs cannot overlap.
5. Non-zero exit on failure, so a scheduler reports a failed run instead of
   silently succeeding.
