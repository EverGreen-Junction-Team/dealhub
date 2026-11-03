# How data reaches the PipelinePulse database

Every path by which a row gets written: what arrives in real time, what is
reconciled nightly, what only runs when a human invokes it, and what is
deliberately switched off.

Written against the code as of 2026-10-09. The authority is always
`server/src/services/orphanSweep.js` (which registers the nightly job) and
`server/src/routes/webhooks.js` (which dispatches the real-time one).

---

## The three paths, at a glance

| Path | Trigger | Covers |
|---|---|---|
| **Webhooks** | GHL pushes, instantly | Opportunities, contacts, messages, tasks, notes, users, relations |
| **Nightly reconciliation** | `0 3 * * *`, in-process | Everything above *plus* the things GHL never pushes |
| **Manual scripts** | A person runs them | Backfills, one-off repairs, forced re-syncs |

A fourth, separate job — **misha-refresh** — runs from system cron and writes
only into the `misha.*` schema. It is covered at the end.

---

## 1. Webhooks — real time

GHL posts to `/webhooks/ghl`; `routes/webhooks.js` dispatches on event type.
Idempotency is enforced through the `processed_events` table.

| Event | Writes to |
|---|---|
| `OpportunityCreate` · `OpportunityUpdate` · `OpportunityDelete` | `opportunities`, `stage_history`, `opportunity_field_history` |
| `OpportunityStageUpdate` · `OpportunityStatusUpdate` | `opportunities`, `stage_history` |
| `OpportunityMonetaryValueUpdate` · `OpportunityAssignedToUpdate` | `opportunities`, `opportunity_field_history` |
| `ContactCreate` · `ContactUpdate` · `ContactDelete` | `contacts`, `tags`, `tag_history` |
| `ContactDndUpdate` | `contacts` |
| `InboundMessage` · `OutboundMessage` | `messages`, `message_opportunity_map` |
| `TaskCreate` · `TaskComplete` · `TaskDelete` | `tasks`, `task_relations` |
| `NoteCreate` · `NoteUpdate` · `NoteDelete` | `notes`, `note_links` |
| `UserCreate` · `UserUpdate` · `UserDelete` | `users` |
| `RelationCreate` · `RelationDelete` | `opportunity_contacts`, contact↔business links |
| `INSTALL` · `UNINSTALL` | `installs` |

### What webhooks do NOT cover

GHL sends **nothing at all** for these. They exist only because the nightly
sync fetches them:

- **Businesses / companies** — no create, update or delete event
- **Tags** (the catalogue, as opposed to a contact's tags)
- **Custom field definitions**
- **Pipelines and stages**
- **Conversation providers**

And two things GHL has no concept of, so we derive them ourselves:

- **Opportunity → business**: there is no link. A deal reaches a business
  only through `contacts.business_id` (migration 056).
- **Deal tags**: tags are contact-scoped. Deal tags are fanned out from the
  union of their contacts' tags (migration 134).

---

## 2. The nightly job — `0 3 * * *`

Registered in `services/orphanSweep.js`, started with the server process.
Despite the filename it is the **full daily reconciliation**, not just
housekeeping. Each step is wrapped in its own `try` — one failing logs loudly
and does not stop the rest.

**The order is deliberate.** Each step depends on an earlier one having
resolved *on the same run* rather than the next:

```
 1. orphan sweep            stage events that arrived before their create
 2. purge processed_events  older than 14 days
 3. purge ghl_raw           older than 30 days
 4. tags
 5. custom field definitions
 6. pipelines and stages
 7. users          ← FIRST of the object syncs: deals, tasks and notes all
                     resolve an owner name against `users`, and user_type
                     decides who counts as a rep. A rep added today is named
                     on this run rather than tomorrow's.
 8. businesses     ← BEFORE contacts: contacts carry business_id, so the
                     join resolves on this run.
 9. contacts
10. opportunities
11. tasks          ← AFTER opportunities: a task is attributed to a deal, so
                     the deals must be current or attribution falls back to
                     "no open deal".
12. expired deal-link sweep   create-time deal picks whose webhook never
                              arrived (migration 069)
13. purge sync_runs        older than 30 days
```

### Why reconcile at all when webhooks exist

A webhook can be dropped. The nightly pass is the net that catches it. When
the `taskWriter` crashed on 9 Oct, the task existed in GHL and not here — and
because `tasksSync` *is* in this job, the next run would have recovered it.

> **Note:** `tasksSync` was missing from this job entirely until recently. Task
> webhooks kept the data current, so nothing looked broken; what was absent was
> the reconciliation sweep.

---

## 3. The snapshot job — `30 3 * * *`

`services/pipelineSnapshot.js` writes **one row per sub-account per day** into
`pipeline_snapshots`.

`opportunities` holds *current* state only. A rep books a task and the row
changes — the fact that the deal had nothing booked yesterday is gone. So
"is our no-task rate better than last month?" cannot be answered from the
data at all, not with a cleverer view or a different join. The history was
never written down.

This job writes it down. **Nothing is retroactive**: the first row lands the
day it first runs, and the first month-over-month comparison is possible a
month after that.

Captured per day: open deals and value, won/lost/abandoned totals, deals with
no task / no notes / no reply, stagnant 30d, missing value / source / buyer /
product, deals with a postcode, note totals and distinct note authors.

---

## 4. Deliberately disabled

Two syncs were removed from the nightly job **at the client's request
(2026-09-11)**. Neither is a bug; both are a standing risk worth knowing.

### `messagesSync`

This was Layer 3 of the message-capture strategy: the reconciliation pass that
caught messages GHL's webhooks never delivered.

That is not hypothetical. `docs/MESSAGE-SYNC-REDESIGN.md` records two
confirmed cases (Danilo Bardella, 16 Jul; Yusuf Lala, 10 Jul) where real
customer emails existed in GHL and never reached us.

**With this off, a dropped message webhook is a permanently missing message.**

### `callRecordingSync`

Same decision, same date.

---

## 5. Manual scripts

Run from `server/`. None of these are scheduled.

### Forced re-syncs

```bash
npm run sync:businesses      # GET /businesses/ per install
npm run sync:custom-fields
npm run sync:providers
npm run sync:tasks           # the recovery path when a task webhook is lost
```

### Backfills

```bash
npm run backfill:users
npm run backfill:contacts
npm run backfill:opportunities
npm run backfill:messages
npm run backfill:attribution
npm run backfill:opp-custom-fields
npm run backfill:tasks-notes-attribution
npm run backfill:primary-contacts
npm run backfill:task-note-deals
npm run backfill:message-attribution
npm run backfill:task-relations
npm run backfill:cf-folders
```

---

## 6. misha-refresh — separate job, separate schema

Lives at `pipelinePulse/misha-refresh/`. Its own `package.json` and `.env`;
shares only the database. Runs from **system cron**, not the server process:

```cron
7 * * * * cd /root/pipelinePluse/misha-refresh && /usr/bin/node refresh.js >> /var/log/misha-refresh.log 2>&1
```

It reads `messages`, `opportunities`, `stage_history`, `opportunity_contacts`
and `installs`. It writes **only** into `misha.*` — `deal_extracts`,
`requirements`, `replies`, `question_theme_map`, `requirement_theme_map`.

Three operational facts:

- **Locations are dynamic** — `SELECT location_id FROM installs WHERE
  uninstalled_at IS NULL`. The original had three ids hardcoded, so a fourth
  client's messages were silently never extracted.
- **`MAX_MESSAGES_PER_RUN` defaults to 500.** One Claude call per message,
  two for customer messages. Hitting the cap is logged; the watermark has not
  moved, so the next run continues where this one stopped.
- **Runs cannot overlap** — a Postgres advisory lock. Behind Supabase's
  pooler a killed run can orphan that lock; `npm run unlock` clears it.

### The one thing needing a human

Question labels are classified automatically. **Requirement labels are not** —
that mapping was built by hand and there is no classifier, so new ones are
parked as `'Other / uncategorized, needs review'` rather than guessed.

Every run prints the backlog size. Left unworked it grows and the
requirement-theme insights drift toward "uncategorised" with nothing
appearing broken:

```sql
SELECT requirement_label FROM misha.requirement_theme_map
 WHERE theme = 'Other / uncategorized, needs review';
```

---

## 7. Custom fields — definitions AND values

Two distinct things, synced by different paths. Easy to conflate.

### The definitions (catalogue)

`ghl_custom_field_definitions`, nightly, for **contact** and **opportunity**
object types: `field_id`, `field_key`, `display_name`, `field_type`,
`options` (picklist choices), `is_active`, timestamps, `raw_definition`.

`ghl_custom_field_folders` holds the folder each field sits in, with name and
position, so the UI can group fields the way GHL does.

### The values (per record)

Arrive by **webhook with the record itself**, reconciled nightly.

| Table | Column |
|---|---|
| `contacts` | `custom_fields` JSONB — GIN indexed |
| `opportunities` | `custom_fields` JSONB — GIN indexed |
| `businesses` | `custom_fields` JSONB |

GIN indexes on the first two so a query can reach inside the JSON without a
full scan.

### Promoted to real columns

Fields read constantly are lifted out of JSONB into their own columns, so they
are indexable and joinable rather than needing a key lookup:

```
client_type · product_system · product_type · postcode
first_contact_method · lead_source_opportunity · inquiry
master_initial_enquiry · all_initial_enquiry · meddic_1..11
```

Promotion is a migration each time (026 for contacts, later ones for these),
which is why it is selective rather than automatic. Everything unpromoted
stays in `custom_fields` and is still queryable.

### Two things that surprise people

**Business "custom fields" are not custom fields.** GHL returns the ten
"Company Info" fields as *native properties* on the Business object, so they
map straight onto real columns (`website`, `domain_name`, `company_logo`, …)
rather than into JSONB.

**MEDDIC fields are hidden from the AI on purpose.** `meddic_1..11` sync
normally and reps can edit them, but they are removed from
`get_deal_detail`'s SELECT so the model reads conversation data instead of a
rep's own notes. `get_qualification_gaps` still counts them to report what is
missing.

---

## 8. Retention

| Table | Kept | Purged by |
|---|---|---|
| `processed_events` | 14 days | nightly job |
| `ghl_raw` | 30 days | nightly job |
| `sync_runs` | 30 days | nightly job |
| `pending_deal_links` | 1 hour (expiry) | nightly sweep |

Everything else is kept indefinitely. **Deletes are soft** wherever a row
might still be referenced — a business that vanishes from GHL is marked
`is_active = false` rather than removed, because contacts still carry its
`business_id` and a hard delete would strip the link with no way to explain a
suddenly-empty page.

---

## 9. Reading this when something is missing

Work down the list:

1. **Does GHL send a webhook for it at all?** Businesses, tags, custom
   fields, pipelines and providers have none — they appear only after the
   3am run. A business created at 9am will not be here until the next
   morning. Force it: `npm run sync:businesses`.

2. **Is it a message or a call recording?** Those syncs are off (§4). A
   dropped webhook means it is gone; there is no recovery path.

3. **Did the webhook handler throw?** Check the logs for
   `webhook: … writer failed`. The route still returns 200 so GHL does not
   retry, which means the event will not come again. The nightly sync is the
   recovery path for anything it covers.

4. **Has the nightly job run since?** It is one job: if an early step throws,
   the later ones still run, but check the logs for the specific step.

5. **Is it derived rather than synced?** Deal tags (migration 134) and the
   opportunity→business link (via `contacts.business_id`) are computed by us.
   If a contact's tags are right and the deal's are not, the fanout is the
   place to look, not the sync.
