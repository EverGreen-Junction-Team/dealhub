# PipelinePulse — database schema

Every table and view in the PipelinePulse Postgres database (Supabase Cloud,
project `qxzpncjvnkmxhggeswpu`, EU-West-2), as of migration **071**.

Generated from `server/migrations/*.sql` — 71 migrations, applied in filename
order by `npm run migrate` and tracked in `schema_migrations`.

**39 tables · 7 views**

---

## Conventions

These hold almost everywhere, so they are stated once rather than repeated per
table.

| Convention | Meaning |
|---|---|
| `location_id` | The GHL sub-account. Present on every tenant table and always the **first** column of the primary key. RLS policies key on it via `set_config('app.location_id')`. |
| Composite PK | Most tables are keyed `(location_id, <ghl_id>)` rather than a surrogate id — GHL's own ids are unique only *within* a sub-account. |
| `deleted_at` | Soft delete. `NULL` = live. Rows are **never** hard-deleted: opportunities, messages and notes reference contacts, and a real delete would orphan them. Every read filters `deleted_at IS NULL`. |
| `from_backfill` | `true` when the row came from a one-time backfill script rather than a live webhook. Lets a bad backfill be identified and re-run without touching webhook data. |
| `raw_*` JSONB | The full GHL payload as received (`raw_contact`, `raw_message`, `raw_opportunity`). Future-proofing: fields we have not promoted to columns are still recoverable, and **attachments are read straight out of `raw_message`** rather than having a column of their own. |
| `imported_at` / `updated_at` | Our own row timestamps. Distinct from `created_at_ghl` / `updated_at_ghl`, which are GHL's. |

---

## Core records

The four tables migration 001 created, plus the objects that hang off them.

### `contacts` — 63 columns
PK `(location_id, contact_id)`

A person in the CRM. The widest table in the schema: migration 026 promoted 18
standard GHL fields and 16 client-specific custom fields out of JSONB into real
columns for cheap analytics, and they remain in `custom_fields` as well.

Holds identity (`first_name`, `email`, `phone`), address, marketing consent,
paid-search attribution (`gclid`, `gbraid`, `wbraid`, `utm_*`), `tags TEXT[]`,
DND state, `business_id`, and `assigned_to` / `assigned_to_name` (migration 071).

### `opportunities` — 60 columns
PK `(location_id, opportunity_id)`

A deal. Carries pipeline and stage, `monetary_value`, `status`
(`open`/`won`/`lost`/`abandoned`), owner, the MEDDIC qualification fields
`meddic_1`…`meddic_11`, and `postcode` (deal-level, deliberately not on the
contact).

`is_ghost` marks a deal GHL reported but never confirmed; every read excludes
`is_deleted`, `deleted_at` and `is_ghost`.

### `messages` — 31 columns
PK `id` (surrogate), unique on `(location_id, message_id)`

One message on any channel — email, SMS, WhatsApp, call, voicemail, webchat.

`raw_message` holds the full payload; **attachments live inside it**, under
`attachments` (email, with filenames) or `mediaUrls` (SMS/WhatsApp, bare URLs).
`server/src/utils/attachments.js` normalises both shapes. Email attachments are
fetched in a *second* GHL call at ingest, because the webhook always sends
`attachments: null`.

### `stage_history` — 31 columns
PK `id`

Every stage transition, append-only. The source for "days in stage" and the
funnel analytics. Written by `stageHistoryWriter.js` from the live webhook and
by `backfill.js` for history.

---

## Deal ↔ people ↔ work

### `opportunity_contacts` — 11 columns
PK `(location_id, relation_id)`

Which contacts are on which deal. **The PK is the relation id, not
`(opportunity, contact)`** — GHL issues its own relation id, and the primary
contact is also written as a synthetic `primary:<opp>:<contact>` row, so one
contact can legitimately hold two rows for the same deal.

### `tasks` — 20 columns
PK `(location_id, task_id)`

CRM tasks. `deal_set_manually` (migration 068) marks a deal link a human chose;
the attribution rule then fills gaps only and never overrides it.

### `notes` — 20 columns
PK `(location_id, note_id)`

Same shape and the same `deal_set_manually` rule as tasks. GHL never returns a
note→deal link, so the link is ours alone.

### `task_relations` / `note_links` — 9 / 7 columns
The GHL-side relation records for tasks and notes. Kept separately because the
OAuth channel refuses relation writes for tasks (`restrictOAuthChannel`).

### `pending_deal_links` — 7 columns
PK `(location_id, entity_type, entity_id)`

A one-hour handover table (migration 069). When a rep picks a deal while
*creating* a note or task, the link cannot be written yet — the row does not
exist until the webhook lands — so the choice is parked here and consumed on
arrival. `expires_at` sweeps abandoned picks.

### `message_opportunity_map` — 14 columns
PK `id`

Which deal a message is filed against, with `mapping_status`
(`unassigned` / `mapped` / `manually_resolved`) and `superseded_at` for history.
A message belongs to **one** deal at most.

---

## Reference data (synced from GHL)

| Table | Cols | PK | What it holds |
|---|---|---|---|
| `pipelines` | 13 | `(location_id, pipeline_id)` | Pipeline definitions |
| `pipeline_stages` | 14 | `(location_id, stage_id)` | Stages, with `position` for ordering |
| `users` | 14 | `(location_id, user_id)` | Sub-account users. `active` is a soft-delete flag — a departed user still resolves here, where `GET /users/{id}` would 404 |
| `businesses` | 23 | `(location_id, business_id)` | Business records; contacts point at them via `contacts.business_id` |
| `tags` | 7 | `(location_id, tag_id)` | Every tag defined in the location — powers autocomplete so reps don't create "hot-lead" beside "hot lead" |
| `products` | 8 | `id` | GHL products |
| `conversation_providers` | 12 | `(location_id, provider_id)` | Which integration sent a message |
| `lost_reason_labels` | 5 | `(location_id, reason_id)` | Lost-reason picklist |
| `ghl_custom_field_definitions` | 17 | `(location_id, object_type, field_id)` | Custom-field schema. **Resolved by `field_key`, never `field_id`** — each sub-account issues its own id for the same key |
| `ghl_custom_field_folders` | 10 | `(location_id, object_type, folder_id)` | Folders that group those fields in the UI |

---

## Call media

| Table | Cols | PK | What it holds |
|---|---|---|---|
| `call_recordings` | 9 | `(location_id, message_id)` | Recording URL and fetch state |
| `call_transcriptions` | 11 | `(location_id, message_id)` | Transcript text plus `fetch_status` — `'ok'` is the only value that means the text is usable |

---

## AI / Co-Pilot

| Table | Cols | PK | What it holds |
|---|---|---|---|
| `ai_runs` | 25 | `id` | One Co-Pilot question: prompt, answer, citations, token counts, cost |
| `ai_feedback` | 12 | `id` | Thumbs up/down on an answer |
| `ai_exclusions` | 7 | `(location_id, opportunity_id, subject_type, subject_id)` | What the agent must **not** read — the timeline's unticked rows |
| `location_ai_settings` | 6 | `location_id` | Per-sub-account AI configuration |
| `business_context` | 9 | `location_id` | The markdown file behind the Control panel. In Postgres, not on disk, so a redeploy cannot silently lose the agent's grounding |
| `tone_samples` | 8 | `id` | Writing samples for tone matching |

---

## History / audit

| Table | Cols | PK | What it holds |
|---|---|---|---|
| `opportunity_field_history` | 9 | `id` | Field-level changes on a deal |
| `tag_history` | 10 | `id` | Tag add/remove events, with `removed_at` |

---

## Sync machinery

| Table | Cols | PK | What it holds |
|---|---|---|---|
| `installs` | 13 | `location_id` | OAuth tokens per sub-account. The root of every tenant operation |
| `processed_events` | 6 | `event_id` | Webhook idempotency — GHL redelivers, this makes replay a no-op |
| `sync_runs` | 15 | `id` | One backfill or sync execution, with counts and outcome |
| `sweep_cursors` | 4 | `(location_id, object_type)` | Where the orphan sweep got to |
| `pending_opportunities` | 8 | `(location_id, opportunity_id)` | Deals seen in an event before their own record arrived |
| `ghl_raw` | 6 | `id` | Raw webhook archive, before parsing |
| `saved_views` | 10 | `id` | Saved filter sets for the Deals and Contacts tabs. `filters` JSONB, `scope` (`deals`/`contacts`), `is_shared`, case-insensitive unique name per user |
| `schema_migrations` | 2 | `filename` | Which migrations have run. The runner skips what is listed here |

---

## Views

### `vw_opportunity_flat` — 72 columns
The analyst-facing denormalised deal: opportunity joined to its contact,
pipeline, stage and owner, with the MEDDIC fields exposed under readable names
(`deal_won_reason`, `deal_lost_reason`, `deal_abandoned_reason`).

Recreated whenever a column is added — a view cannot gain a mid-list column in
place, so migration 067 drops and rebuilds it verbatim plus the new one.

### `vw_opportunity_messages_json` — 4 columns
`(location_id, opportunity_id)`, a `message_count`, and `messages_json` — the
deal's whole conversation as a single JSON array. Joins to `vw_opportunity_flat` to give one
row per deal carrying both the facts and the transcript.

### `vw_opportunity_effective_tags` — 19 columns
A deal's tags after `tag_history` is replayed — the *current* set, rather than
every tag ever applied.

### `vw_sync_run_health` — 11 columns
Sync-run summary for monitoring. Rows scoped `all` carry `location_id NULL`,
which is the cross-tenant health line rather than a missing value.

### `contact_tags` / `opportunity_tags` — 7 columns each
RLS-safe projections of tag state for anon reads. Service role bypasses RLS as
it does everywhere else, so admin analytics and the daily crons are unaffected.

### `message_ai_exclusions` — 6 columns
A compatibility view: the table was renamed to `ai_exclusions`, and this keeps
anything still selecting from the old name working until it is migrated.

---

## Notes for whoever reads this next

- **Row-level security** is on for every tenant table (migration 002), keyed on
  `set_config('app.location_id')`. Application code goes through `withTenant()`;
  a raw query that skips it sees nothing.
- **The connection must use the Supavisor transaction pooler** — the direct URL
  is IPv6-only and the VM cannot reach it. The username carries the project-ref
  suffix (`postgres.qxzpncjvnkmxhggeswpu`), not bare `postgres`.
- **`security_invoker` on views needs Postgres 15+.** Supabase is fine; a local
  Postgres 14 will apply every table but fail the `vw_*` views.
- **Adding a promoted column is three edits, not one**: the migration, the
  `INSERT` column list *and* its `ON CONFLICT DO UPDATE` branch in the writer.
  Migration 026 added nine attribution columns that no writer ever populated,
  and they sat empty until it was noticed.
