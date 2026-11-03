# James's Database Blueprint — Full Context

Source: `James database built 15.05.csv` (received 21 Jul 2026, EGJ)

The blueprint is organised into **6 build stages**. Each stage has a set of tables; each table has a specific column list, keys, source, and behaviour. Below is the complete map — nothing is invented, all field types and behaviours come from the CSV verbatim.

Legend for statuses:
- **Existing** = already in our current pipelinePulse Supabase
- **Existing — change required** = column exists but shape/behaviour changes
- **Proposed** = new column we don't have yet
- **DROPPED** = originally in blueprint but explicitly cut by James (raw payload archive + tag_history + opportunity_field_history + baseline_captures)
- **FUTURE** = Stage 2+ (built after Stage 1 lands)

---

## Stage 1 — Foundation and complete capture

**Objective:** Capture every authorised GHL payload reliably, preserve raw truth and maintain clean current-state core records.

Tables in Stage 1: **installs, raw_ghl_events, processed_events, sync_runs, sweep_cursors, ghl_custom_field_definitions, users, pipelines, pipeline_stages, contacts, opportunities, stage_history, messages, tasks, notes, tags, tag_history, pending_opportunities**

### 1.1 `installs` — Internal ingestion (Existing, 11 cols)
One row per GHL sub-account connected to Evergreen Junction. OAuth lifecycle.

| Column | Type | Key | Source | Notes |
|---|---|---|---|---|
| location_id | TEXT NOT NULL | PK | GHL install callback | GHL sub-account |
| company_id | TEXT | | GHL install/token response | Agency ID above the location |
| user_type | TEXT | | GHL install/token response | Location-scoped install type |
| access_token | SECRET/encrypted TEXT | | OAuth response | **Security change required** — encrypted, isolated from analytics roles |
| refresh_token | SECRET/encrypted TEXT | | OAuth response | Same encryption path |
| token_expires_at | TIMESTAMPTZ | | OAuth `expires_in` | Calculated from provider expires_in |
| scopes | TEXT[]/JSONB | | OAuth response | |
| installed_at | TIMESTAMPTZ | | EGJ internal | First-install time |
| tracking_started_at | TIMESTAMPTZ | | EGJ internal | First-install tracking activation |
| reinstalled_at | TIMESTAMPTZ | | EGJ internal | Latest reinstall time |
| uninstalled_at | TIMESTAMPTZ | | Webhook + internal | App uninstall time |

### 1.2 `raw_ghl_events` — Raw capture (Proposed — required foundation, 14 cols)
Immutable object-level landing record for every webhook, backfill and reconciliation payload.

**⚠ IMPORTANT:** Every column here is marked **DROPPED** in the CSV — James decided against keeping a raw payload archive. GHL remains the re-fetch source. Replay-after-transform-bug is sacrificed by agreement.

**So `raw_ghl_events` is NOT built.**

Columns that were spec'd: id (UUID PK), location_id (FK), source_event_id (UQ), source, event_type, object_type, object_id, payload (JSONB), received_at, processed_at, processing_error, source_occurred_at, processing_status, payload_hash.

### 1.3 `processed_events` — Internal (Existing, 5 cols)
Short-retention webhook dedup register.

| Column | Type | Key | Notes |
|---|---|---|---|
| event_id | TEXT NOT NULL | PK | GHL event ID or deterministic payload hash |
| location_id | TEXT NOT NULL | | RLS scope |
| event_type | TEXT | | GHL webhook category |
| processed_at | TIMESTAMPTZ | | Successful processing timestamp |
| expires_at | TIMESTAMPTZ | | 14-day retention |

### 1.4 `sync_runs` — Internal (Existing + 4 Proposed cols, 13 total)
Audit history and health of reconciliation, backfill and field-diff jobs.

| Column | Type | Key | Status | Source |
|---|---|---|---|---|
| id | UUID NOT NULL | PK | **Proposed** | Database UUID |
| location_id | TEXT NOT NULL | FK → installs | **Proposed** | Job config |
| run_type | TEXT NOT NULL | | Existing | EGJ internal |
| window_start | TIMESTAMPTZ | | Existing | EGJ internal |
| window_end | TIMESTAMPTZ | | Existing | EGJ internal |
| status | TEXT NOT NULL | | Existing | EGJ internal |
| counts | JSONB | | Existing | EGJ internal |
| error | TEXT | | Existing | EGJ internal |
| last_success_at | TIMESTAMPTZ | | Existing | Derived |
| last_failure_at | TIMESTAMPTZ | | Existing | Derived |
| overdue_by | INTERVAL | | Existing | Derived |
| started_at | TIMESTAMPTZ | | **Proposed** | Job start |
| finished_at | TIMESTAMPTZ | | **Proposed** | Job completion |

### 1.5 `sweep_cursors` — Internal (Existing, 3 cols)
Last safely reconciled point per (location, object_type).

| Column | Type | Key | Notes |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite + FK → installs | Tenant scope |
| object_type | TEXT NOT NULL | PK composite | e.g. opportunity, message, contact |
| success_through | TIMESTAMPTZ | | Cursor advances only after successful sweep |

### 1.6 `ghl_custom_field_definitions` — Reference metadata (Proposed — required foundation, 12 cols)
Tenant-scoped catalogue resolving GHL custom-field IDs to stable keys, names, types, options.

| Column | Type | Key | Notes |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite + FK | Tenant scope |
| object_type | TEXT NOT NULL | PK composite | `contact` or `opportunity` |
| field_id | TEXT NOT NULL | PK composite | Native GHL field ID |
| field_key | TEXT | UQ within (loc, obj) | e.g. `opportunity.inquiry` |
| display_name | TEXT | | GHL current human-readable name |
| field_type | TEXT | | Provider type |
| options | JSONB | | Checkbox/dropdown/radio options in provider order |
| is_active | BOOLEAN | | Soft-deactivate when missing/deleted in GHL |
| created_at_ghl | TIMESTAMPTZ | | NULL when GHL doesn't expose |
| updated_at_ghl | TIMESTAMPTZ | | NULL when unavailable |
| last_synced_at | TIMESTAMPTZ | | Stamp after successful reconciliation |
| raw_definition | JSONB | | Complete GHL cf definition payload for future-proofing |

### 1.7 `users` — Reference (Existing, 5 cols)
GHL salespeople/account users. Rep/manager/director lookup.

| Column | Type | Key | Source |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite | GHL Users API |
| user_id | TEXT NOT NULL | PK composite | GHL Users API |
| name | TEXT | | GHL Users API |
| role | TEXT | | GHL Users API |
| active | BOOLEAN | | Presence/deactivation state |

### 1.8 `pipelines` — Reference (Existing, 3 cols)
Tenant-scoped GHL pipeline catalogue.

| Column | Type | Key | Source |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite | GHL Pipelines API |
| pipeline_id | TEXT NOT NULL | PK composite | GHL Pipelines API |
| name | TEXT | | GHL Pipelines API |

### 1.9 `pipeline_stages` — Reference (Existing 4 cols + 1 Proposed, 5 total)
Canonical GHL stage catalogue and funnel order.

| Column | Type | Key | Status |
|---|---|---|---|
| stage_id | TEXT NOT NULL | PK | Existing |
| pipeline_id | TEXT | FK → pipelines | Existing |
| name | TEXT | | Existing |
| position | INTEGER | | Existing |
| location_id | TEXT NOT NULL | PK composite + FK → installs | **Proposed** |

### 1.10 `contacts` — Core parent (50 cols total; mix Existing / Existing–change / Proposed)

Base identity, contact details, attribution, and enquiry-source fields. Custom fields kept as JSONB.

**Identity + tenant (Existing):**
- location_id (PK composite, TEXT NOT NULL)
- contact_id (PK composite, TEXT NOT NULL) — GHL's native `contact.id` (NOT the workflow mirror `contact.contact_id_custom_field_contact`)

**Core identity (Proposed):**
- first_name, last_name, email, phone, company_name (all TEXT nullable)

**Attribution (Existing custom fields):**
- gclid (canonical `contact.google_click_id`, fallback `contact.gclid`)
- gbraid, wbraid, gad_source
- utm_source, utm_medium, utm_campaign, utm_content, utm_term
- marketing_consent (BOOLEAN; Crittall handovers also read `contact.marketing_consent_crittall`)

**Contact source + classification (Proposed):**
- contact_source (`contact.source` standard GHL)
- client_type, channel, product_type (all promoted custom fields — kept distinct from opp-level)

**Full dictionary (Existing):**
- custom_fields (JSONB, resolved to stable keys via `ghl_custom_field_definitions`)

**Provenance flags (Existing):**
- from_backfill (BOOLEAN)

**Timestamps (Proposed):**
- created_at_ghl (contact.dateAdded/createdAt)
- updated_at_ghl (contact.dateUpdated/updatedAt)
- deleted_at (from deletion webhook/reconciliation)

**Existing DB timestamps:**
- imported_at, updated_at

**Enquiry-source fields — Proposed, new in reviewed plan (all Proposed):**
- leadform_enquiry_text ← `contact.please_explain_your_enquiry_leadform`
- leadform_files (JSONB) ← `contact.file_upload_leadform`
- webchat_inquiry_text ← `contact.please_explain_your_inquiry_webchat`
- webchat_files (JSONB) ← `contact.please_upload_your_files_chatwidget`
- enquiries_email_inquiry_text ← `contact.please_explain_your_inquiry_enquiries_at_gmail`
- enquiries_email_attachments (JSONB) ← `contact.enquiries_at_email_attachments`
- crittall_leadform_files (JSONB) ← `contact.file_upload__crittall_lead_form` (⚠ double underscore intentional)
- crittall_email_inquiry_text ← `contact.ienquiry_crittall_email` (⚠ leading `i` intentional)
- first_contact_method (TEXT[]/JSONB) ← `contact.first_contact_method`
- crittall_assignment_checkbox (TEXT[]/JSONB) ← `contact.checkbox_2wpw`
- crittall_email_files (JSONB) ← `contact.file_upload_crittall_email`
- contact_value_raw ← `contact.value` (kept raw until business meaning agreed)
- nonleadform_files (JSONB) ← `contact.file_upload_nonleadform`

**Address + demographics — Proposed:**
- date_of_birth (DATE) — `contact.date_of_birth`
- contact_type — `contact.type`
- address1, city, country, state, postal_code (all TEXT), website, timezone

### 1.11 `opportunities` — Core parent (53 cols in Stage 1)

The deal itself.

**Identity (Existing):**
- location_id (PK composite), opportunity_id (PK composite), contact_id (FK → contacts), name

**Pipeline (Existing):**
- pipeline_id, pipeline_name (resolved from Pipelines API), current_stage_id, current_stage_name (resolved from Stages API)

**Derived first-stage (Existing):**
- first_stage_id, first_stage_name (earliest non-ghost stage_history)

**Status + value (Existing):**
- status (NOT NULL)
- monetary_value (NUMERIC 12,2)
- currency (Proposed — TEXT, GBP default from location config)

**Assignment (Existing):**
- assigned_to (GHL user id)
- assigned_to_name (resolved from Users API)

**MEDDIC — rep-authored (Existing, 10 columns):**
- meddic_1 … meddic_10 (all TEXT). Rep-authored; never overwritten by AI.

**Categorical custom fields (Existing — change required):**
- client_type (TEXT[]/JSONB — faithful checkbox array)
- product_system (TEXT[]/JSONB)
- product_type (TEXT[]/JSONB)
- first_contact_method (TEXT[]/JSONB) ← `opportunity.first_contact__method` (⚠ double underscore)

**Attribution + inquiry:**
- postcode (Existing)
- lead_source_opportunity (Existing)
- gclid (Proposed) ← `opportunity.gclid`, copied from `contact.google_click_id` by workflow
- inquiry (Existing) — Use `opportunity.inquiry` when populated. Otherwise apply documented source-priority rule across the four contact enquiry keys (leadform → webchat → crittall email → enquiries@)

**Three Whys — rep-authored (Proposed):**
- why_want, why_buy, why_blocker (all TEXT)

**Forecast (Proposed):**
- forecast_close_date (DATE)
- forecast_probability (NUMERIC)

**Full dictionary (Existing):**
- custom_fields (JSONB)

**Junk flags (Existing):**
- is_ghost (from orphan-sweep rules)
- is_deleted (from deletion webhook/reconciliation)

**Provenance:**
- from_backfill (Existing)

**Lifecycle timestamps (mix Existing + Proposed):**
- created_at_ghl (Existing) — GHL opportunity creation
- updated_at_ghl (Proposed)
- won_at (Proposed — from Won status-change event)
- lost_at (Proposed)
- abandoned_at (Proposed)
- deleted_at (Proposed)
- imported_at, updated_at (Existing — EGJ)

**New in reviewed plan (Proposed):**
- upload_from_enquiry (TEXT) ← `opportunity.upload_from_enquiry`
- opportunity_source (TEXT) ← `opportunity.source` (kept independent from contact source + UTM)
- lost_reason (TEXT) ← `opportunity.lost_reason` (retained at loss point; changes preserved in Stage 2 `opportunity_field_history`)

**Stage 3 additions (Proposed):**
- quote_sent_at (TIMESTAMPTZ — first canonical Quote Sent/Quotation Made stage entry)
- quote_delivery_method_current (TEXT — current active `quote:*` namespaced tag)

**Stage 4 AI additions (Proposed):**
- meddic_1_ai … meddic_10_ai (all TEXT)
- meddic_1_evidence … meddic_10_evidence (all TEXT)
- ai_extraction_meta (TEXT — projection of canonical extraction metadata)

### 1.12 `stage_history` — Core parent (29 cols)

Temporal record of every opportunity stage session and its point-in-time sales context.

**Existing:**
- id (UUID PK)
- location_id, opportunity_id (FK → opportunities), contact_id (denormalised)
- stage_id, stage_name, pipeline_id, pipeline_name
- entered_at (immutable), left_at, in_stage_duration_seconds, current_stage
- deleted, ghost_opportunity
- product_system, product_type (snapshots at stage change)
- custom_fields_snapshot (JSONB)
- triggered_by (opportunity_created / opportunity_stage_updated / daily_sweep / backfill)
- from_backfill, imported_at

**Proposed:**
- assigned_to, assigned_to_name (owner snapshot at stage entry)
- monetary_value_snapshot (NUMERIC 12,2)
- currency
- status_snapshot
- lead_source_snapshot (from `opportunity.lead_source_opportunity`)
- client_type_snapshot (TEXT[]/JSONB from `opportunity.client_type`)
- ingest_event_id (UUID FK → raw_ghl_events.id — **DROPPED because raw_ghl_events dropped**)
- closed_reason (stage transition / Won / Lost / Abandoned / deletion / correction)

**Invariant:** Exactly one current stage session per open opportunity; out-of-order and duplicate events do not create overlapping sessions.

### 1.13 `messages` — Core parent (27 cols in Stage 1, +2 in Stage 2)

Canonical contact-level communications across email, SMS, WhatsApp, webchat, calls.

**Existing:**
- id (UUID PK)
- location_id, contact_id (FK → contacts) — both NOT NULL
- message_id (TEXT NOT NULL, UQ composite with location_id)
- conversation_id (GHL Conversations API `conversationId`)
- thread_id (Provider metadata — email thread; NULL for other channels)
- message_timestamp (TIMESTAMPTZ NOT NULL — GHL provider time, never sync time)
- message_body (cleaned via cleaning_version)
- message_body_raw (raw from GHL payload)
- message_direction (inbound/outbound)
- message_channel (Email, SMS, WhatsApp, Call, Webchat, etc.)
- message_status
- is_call (derived: message_channel = 'call')
- from_backfill, imported_at

**Proposed (new in reviewed plan):**
- subject (email subject where supplied)
- reply_to_message_id (email reply/reference identifier)
- cleaning_version (TEXT — app config/version stamped when cleaning runs)
- sender_user_id (FK-ish → users; NULL when not exposed)
- sender_name (from GHL users lookup)
- sender_type (contact / user / automation / system / unknown — **never inferred from direction alone**; use explicit metadata or store 'unknown')
- call_duration_seconds
- recording_url
- sync_run_id (UUID FK → sync_runs)
- last_synced_at
- deleted_at
- ingest_event_id (**DROPPED with raw_ghl_events**)

**Stage 2 additions (Existing — change required):**
- opportunity_id (nullable FK, derived from cached approved `message_opportunity_map`) — NULL when ambiguous
- stage_history_id (nullable FK → stage_history.id, derived)

**Rules:** Stage 1 retains contact truth. Stage 2 projects only approved `message_opportunity_map` results. Never infer opportunity from a future stage movement alone.

### 1.14 `tasks` — Related business data (Existing, 17 cols)
GHL tasks for next-action and discipline analysis.

| Column | Type | Key | Source |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite | GHL Tasks API |
| task_id | TEXT NOT NULL | PK composite | task.id |
| contact_id | TEXT NULL | FK nullable | task.contactId |
| opportunity_id | TEXT NULL | FK nullable | Only if unambiguous |
| assigned_to | TEXT | | task.assignedTo |
| assigned_to_name | TEXT | | Users lookup |
| title | TEXT | | task.title |
| body | TEXT | | task.body |
| status | TEXT NOT NULL | | task.completed (boolean) |
| due_at | TIMESTAMPTZ | | task.dueDate (ISO 8601) |
| completed_at | TIMESTAMPTZ | | First observation of completed=true |
| created_at_ghl | TIMESTAMPTZ NOT NULL | | GHL task creation |
| updated_at_ghl | TIMESTAMPTZ | | GHL task update |
| deleted_at | TIMESTAMPTZ | | Deletion webhook/reconciliation |
| from_backfill | BOOLEAN | | EGJ internal |
| imported_at, updated_at | TIMESTAMPTZ | | EGJ internal |

### 1.15 `notes` — Related business data (Existing, 13 cols)
Manual notes written by salespeople. **Never treated as customer evidence.**

Same shape as tasks minus title/status/due_at/completed_at, plus:
- author_user_id, author_name
- body (unmodified GHL note body)
- created_at_ghl, updated_at_ghl, deleted_at
- from_backfill, imported_at, updated_at

### 1.16 `tags` — Related business data (Existing, 4 cols)
Tenant-scoped GHL tag catalogue.

| Column | Type | Key | Notes |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite | |
| tag_id | TEXT NOT NULL | PK composite | |
| name | TEXT | UQ within location | Native GHL value |
| namespace | TEXT | | Text before first `:` — e.g. `quote` from `quote:*` |

### 1.17 `tag_history` — History/provenance (Proposed, 9 cols)
**⚠ ALL COLUMNS DROPPED** — folded into `opportunity_tags` / `contact_tags` views. Removal history is sacrificed by agreement. `location_id + applied_at` added directly to those views. So `tag_history` is NOT built.

### 1.18 `pending_opportunities` — Internal (Existing, 6 cols)
Short-lived queue for newly observed opportunities awaiting a trustworthy initial stage session.

| Column | Type | Key | Notes |
|---|---|---|---|
| location_id | TEXT NOT NULL | PK composite | GHL locationId |
| opportunity_id | TEXT NOT NULL | PK composite | opportunity.id |
| contact_id | TEXT NOT NULL | | Native opp→contact relation |
| observed_stage_id | TEXT | | opportunity.pipeline_stage_id |
| created_event_at | TIMESTAMPTZ | | Webhook timestamp |
| sweep_after | TIMESTAMPTZ | | Webhook time + orphan-wait interval |

---

## Stage 2 — Attribution and change history

**Objective:** Create safe opportunity attribution and materialise change history without rewriting captured source data.

### 2.1 `messages` — Adds 2 nullable derived FK cols (see §1.13 above)

### 2.2 `message_opportunity_map` — Attribution (Existing, 14 cols)
Versioned, reviewable attribution between contact-level messages and opportunities/stage sessions.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Versioned mapping decision |
| location_id | TEXT NOT NULL | FK composite | |
| message_id | TEXT NOT NULL | FK composite → messages | |
| opportunity_id | TEXT | FK nullable | NULL when unsafe |
| stage_history_id | UUID | FK nullable → stage_history | Safely resolved stage session |
| mapping_status | TEXT | | `mapped` / `ambiguous` / `unassigned` / `excluded_multi_open` / `manually_resolved` |
| rule | TEXT | | Attribution engine config identifier |
| rule_version | TEXT | | |
| confidence | NUMERIC | | |
| mapped_at | TIMESTAMPTZ | | |
| superseded_at | TIMESTAMPTZ | | When replaced by a new version |
| reviewed_by | TEXT | | EGJ/operator, never AI |
| reviewed_at | TIMESTAMPTZ | | |
| review_note | TEXT | | |

**Rules:** Versioned; earlier mappings superseded, never silently overwritten. Multi-open-opportunity contacts remain explicitly ambiguous or excluded.

### 2.3 `opportunity_field_history` — History (Proposed, 9 cols)
**⚠ ALL COLUMNS DROPPED** — Whys freshness computed by comparing current why fields to `stage_history.custom_fields_snapshot` at last stage change. When/intermediate edits sacrificed by agreement. Not built.

---

## Stage 3 — Non-AI insight views

**Objective:** Generate the agreed funnel, leak, discipline, response-time, quote and baseline insights without AI.

### 3.1 `opportunities` — 2 new Proposed cols (§1.11 already lists them)
- quote_sent_at, quote_delivery_method_current

### 3.2 `opportunity_tags` — SQL view (Proposed — replaces tag_history for opps, 6 cols)
Convenience view over what tag_history would have held.

Columns projected from source: opportunity_id, tag_id, location_id, applied_at (NOT NULL), removed_at (NULL = active), detected_via.

Rule: `removed_at IS NULL` identifies currently active tags. **Replaces `tag_history` entirely** — proves the tag predates the outcome for delivery-method conversion analysis.

### 3.3 `contact_tags` — SQL view (Proposed, 6 cols)
Same shape as `opportunity_tags` but for contacts. Same "removed_at IS NULL = active" convention.

### 3.4 `vw_opportunity_flat` — Analytics view (Existing + additions, 44 cols)
One-row-per-opportunity metrics for non-AI insights.

**Identity + tenant (Existing 3):** location_id, opportunity_id, contact_id

**Labels + routing (Existing):**
- business_name (from location_id config)
- opportunity_name, pipeline_id, pipeline_name, assigned_to, owner_name (joined to users/pipelines)

**Source attribution (Existing):**
- lead_source_opportunity, first_contact_method
- utm_source, utm_medium, utm_campaign, gad_source, has_gclid (BOOL)

**Deal shape (Existing):**
- product_system, product_type, client_type, postcode, inquiry

**Funnel state (Existing):**
- first_stage_name, current_stage_name, status
- current_stage_entered_at, days_in_current_stage
- total_pipeline_age_days

**Value (Existing):**
- monetary_value

**Timing (Existing):**
- created_at_ghl, updated_at, last_activity_at (MAX(messages.message_timestamp) via approved mappings)

**Mapped activity aggregates (Existing — change required):**
- message_count, inbound_count, outbound_count, has_call
(all use `message_opportunity_map` — no more raw joins)

**Attribution coverage (Proposed):**
- mapping_coverage_pct (approved map counts ÷ eligible contact-message counts)
- unmapped_message_count

**Discipline audit (Proposed):**
- whys_present (BOOL), whys_fresh (BOOL) — computed from Three Whys custom fields + `stage_history.custom_fields_snapshot`
- has_live_task (BOOL), overdue_task_count

**Response-time metrics (Proposed):**
- first_response_minutes (RETAINED) — minutes from opp creation to earliest approved outbound message. **Always publish alongside first_response_sender_type; do not label as "human response time" unless sender_type = user.**
- first_response_sender_type (`user` / `automation` / `system` / `unknown`)
- first_human_response_minutes (from earliest approved outbound where `messages.sender_type = user`; NULL when historical sender identity unavailable)

**Stage 4 additions:**
- ai_capture_by_field (JSONB — from `extracted_facts` + `opportunity_extractions`)
- ai_coverage_stamp (TEXT)

### 3.5 `vw_opportunity_messages_json` — Analytics view (Existing + change, 4 cols)
Ordered approved message context per opportunity.

| Column | Type | Notes |
|---|---|---|
| location_id | TEXT | Join key to `vw_opportunity_flat` |
| opportunity_id | TEXT | One row per mapped opportunity |
| message_count | INTEGER | COUNT(*) via current approved mappings |
| messages_json | JSONB | jsonb_agg of canonical message fields + mapping rule/confidence, ordered by message_timestamp |

### 3.6 `baseline_captures` — Measurement (Proposed, 9 cols)
**⚠ ALL COLUMNS DROPPED FROM DB** — Eduarda freezes baselines in a spreadsheet (window, sample size, caveats). Deadline unchanged: before auto-ack go-live. Not built as a table.

---

## Stage 4 — Written-channel AI extraction

**Objective:** Extract written-channel facts with evidence and project approved AI fields back to GHL safely.

### 4.1 `opportunities` — 21 AI Proposed cols (see §1.11 above)
10× meddic_N_ai, 10× meddic_N_evidence, ai_extraction_meta. All projected from canonical extraction tables below.

### 4.2 `extraction_runs` — AI (Existing + 2 Proposed, 10 cols)
Versioned AI model executions.

| Column | Type | Key | Status |
|---|---|---|---|
| id | UUID NOT NULL | PK | **Proposed** |
| location_id | TEXT NOT NULL | FK → installs | **Proposed** |
| model | TEXT | | Existing |
| prompt_version | TEXT | | Existing |
| status | TEXT NOT NULL | | Existing |
| started_at, finished_at | TIMESTAMPTZ | | Existing |
| input_tokens, output_tokens | INTEGER | | Existing (from AI provider) |
| cost | NUMERIC | | Existing (calculated from stored pricing version) |

### 4.3 `opportunity_extractions` — AI (Existing + 3 Proposed, 11 cols)
Point-in-time extraction boundary and channel coverage per opportunity.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| location_id | TEXT NOT NULL | FK → installs | Proposed |
| opportunity_id | TEXT NOT NULL | | Existing |
| run_id | UUID | FK → extraction_runs | Proposed |
| as_of, read_from, read_through | TIMESTAMPTZ | | Existing — extraction window |
| channels_covered | JSONB | | Existing |
| channels_missing | JSONB | | Existing |
| status | TEXT NOT NULL | | Existing |
| skip_reason | TEXT | | Existing (multi-open exclusions come from mapping status) |

### 4.4 `extracted_facts` — AI (Existing + 2 Proposed, 7 cols)
Canonical AI-derived facts with capture state, confidence, current-version status.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| extraction_id | UUID | FK → opportunity_extractions | Proposed |
| field | TEXT | | Existing (e.g. `meddic_1_ai`) |
| value | TEXT/JSONB | | Existing |
| capture_state | TEXT | | Existing |
| confidence | NUMERIC | | Existing |
| is_current | BOOLEAN | | Existing |

**Rule:** Versioned; one current fact per (opportunity, field), prior facts retained. No published fact without valid evidence. Rep-authored fields never overwritten.

### 4.5 `fact_evidence` — AI (Existing + 1 Proposed, 7 cols)
Verbatim message/transcript receipts supporting extracted facts.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| fact_id | UUID | FK → extracted_facts | Existing |
| message_id | TEXT NOT NULL | FK → messages.message_id | Existing |
| quote | TEXT | | Existing (exact span) |
| date | TIMESTAMPTZ | | Existing |
| sender | TEXT | | Existing |
| channel | TEXT | | Existing |

Every quote must resolve to an existing source message/transcript; preserves source date, sender, channel.

### 4.6 `ghl_writebacks` — AI (Existing + 3 Proposed, 9 cols)
Audit of controlled AI projections to approved GHL custom fields.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| location_id | TEXT NOT NULL | FK → installs | Proposed |
| opportunity_id | TEXT NOT NULL | FK → opportunities | Proposed |
| fact_id | UUID | FK → extracted_facts | Existing |
| field | TEXT | | Existing — only `meddic_N_ai`, `meddic_N_evidence`, `ai_extraction_meta` |
| value | TEXT | | Existing |
| status | TEXT NOT NULL | | Existing |
| attempts | INTEGER | | Existing |
| error | TEXT | | Existing |

Append-only write attempt history. Provider responses supply status/error.

---

## Stage 5 — Call transcription and call signals

**Objective:** Add call recordings, versioned transcripts and evidence-backed call signals to the same insight model.

### 5.1 `transcription_runs` — AI (Existing + 2 Proposed, 7 cols)
Versioned transcription attempts for call recordings.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| location_id | TEXT NOT NULL | FK → installs | Proposed |
| message_id | TEXT NOT NULL | FK → messages.message_id | Existing |
| model | TEXT | | Existing |
| status | TEXT NOT NULL | | Existing |
| error | TEXT | | Existing |
| cost | NUMERIC | | Existing |

Triggered from a call message's `recording_url`. Expired/inaccessible recording URLs fail visibly and can be retried.

### 5.2 `message_transcripts` — AI (Existing, 4 cols)
Speaker-labelled, versioned call transcript output.

| Column | Type | Key | Notes |
|---|---|---|---|
| run_id | UUID | FK → transcription_runs | Multiple versions may exist |
| segments | JSONB | | Speaker-diarised segments |
| full_text | TEXT | | |
| language | TEXT | | |

Versioned; never overwrite an earlier run.

### 5.3 `conversation_signals` — AI (Existing + 2 Proposed, 11 cols)
Questions, objections, responses, commitments and other evidence-backed sales signals.

| Column | Type | Key | Notes |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| location_id | TEXT NOT NULL | FK → installs | Proposed |
| opportunity_id | TEXT NOT NULL | FK → opportunities | Existing |
| rep_user_id | TEXT | FK nullable → users | Existing |
| signal_type | TEXT | | Existing — Question/objection/response/commitment/critical event |
| value | TEXT | | Existing |
| occurred_at | TIMESTAMPTZ | | Existing |
| client_type | TEXT | | Existing (from opportunity.client_type) |
| confidence | NUMERIC | | Existing |
| is_current | BOOLEAN | | Existing |
| extraction_id | UUID | FK → opportunity_extractions | Existing |

### 5.4 `signal_evidence` — AI (Existing + 2 Proposed, 7 cols)
Verbatim source receipts supporting conversation signals. Same shape pattern as `fact_evidence`.

Columns: id (PK Proposed), signal_id (FK Proposed → conversation_signals), message_id (FK Existing → messages), quote, date, sender, channel (all Existing).

---

## Stage 6 — Synthesis and marketing feedback

**Objective:** Turn validated evidence into coaching, battle cards, trend reporting and the Google Ads revenue feedback loop.

### 6.1 `battle_card_items` — AI (Existing + 2 Proposed, 6 cols)
Versioned selling guidance built from real questions, objections and successful responses.

| Column | Type | Key |
|---|---|---|
| id | UUID NOT NULL | PK (Proposed) |
| location_id | TEXT NOT NULL | FK (Proposed) |
| client_type, objection, question, recommended_response | TEXT | (all Existing) |

Drafted from aggregated `conversation_signals` and evidence, then versioned/approved by EGJ or the client.

### 6.2 `coaching_plans` — AI (Existing + 2 Proposed, 6 cols)
Approved monthly coaching plan per user.

| Column | Type | Key |
|---|---|---|
| id | UUID NOT NULL | PK (Proposed) |
| location_id | TEXT NOT NULL | FK (Proposed) |
| user_id | TEXT | FK → users |
| period | DATE | |
| status | TEXT NOT NULL | |
| authored_by | TEXT | FK/actor reference |

### 6.3 `coaching_actions` — AI (Existing + 1 Proposed, 6 cols)
Trackable actions and outcomes belonging to a coaching plan.

Columns: id (PK Proposed), plan_id (FK → coaching_plans), action, due_at, completed_at, outcome.

### 6.4 `offline_conversion_uploads` — AI (Existing + 5 Proposed, 11 cols)
Idempotent closed-Won revenue uploads to Google Ads with complete response history.

| Column | Type | Key | Status |
|---|---|---|---|
| id | UUID NOT NULL | PK | Proposed |
| location_id | TEXT NOT NULL | FK → installs | Proposed |
| opportunity_id | TEXT NOT NULL | FK → opportunities | Existing |
| idempotency_key | TEXT | UQ | Proposed (`location_id + opportunity_id + conversion action/version`) |
| click_id | TEXT | | Existing (from `opportunity.gclid`) |
| value | NUMERIC | | Existing |
| currency | TEXT | | Existing |
| status | TEXT NOT NULL | | Existing |
| uploaded_at | TIMESTAMPTZ | | Proposed |
| provider_response | JSONB | | Proposed |
| error | TEXT | | Proposed |

**Rule:** One logical Won conversion is uploaded once; final value, currency, conversion time and provider response are retained.

---

## What's in the CSV but explicitly DROPPED

James made cuts explicit throughout. Locked in:

1. **`raw_ghl_events` (Stage 1, 14 cols)** — DROPPED entirely. GHL is the re-fetch source. Replay-after-transform-bug sacrificed.
2. **`tag_history` (Stage 1, 9 cols)** — DROPPED. Folded into `opportunity_tags`/`contact_tags` views (`location_id + applied_at` added there). Removal history sacrificed.
3. **`opportunity_field_history` (Stage 2, 9 cols)** — DROPPED. Whys freshness computed by comparing current fields to `stage_history.custom_fields_snapshot` at last stage change. When/intermediate edits sacrificed.
4. **`baseline_captures` (Stage 3, 9 cols)** — DROPPED from DB. Eduarda freezes baselines in a spreadsheet.
5. **`ingest_event_id` columns** on `stage_history` + `messages` — DROPPED because `raw_ghl_events` is dropped.

---

## Standing conventions across every table

1. **`location_id` first** on every table. RLS scope. Tenant isolation from day one.
2. **Composite PKs (location_id, X)** on all reference tables (users, pipelines, pipeline_stages, tasks, notes, tags).
3. **Current-state projection** — source timestamps retained (`created_at_ghl`, `updated_at_ghl`), source deletion = soft deletion (`deleted_at`).
4. **`from_backfill` BOOLEAN** on core tables — ingestion provenance marker.
5. **`imported_at` + `updated_at`** on every table — database-generated timestamps.
6. **Every custom-field ID resolves via `ghl_custom_field_definitions`** — no bare fieldKey guessing.
7. **Multi-open-opportunity contacts** remain explicitly ambiguous or excluded from AI attribution.
8. **Versioning discipline** — extracted_facts, conversation_signals, coaching_plans, message_opportunity_map all versioned; earlier records superseded, never silently overwritten.
9. **Rep-authored fields never overwritten by AI** — meddic_1..10, why_want, why_buy, why_blocker are sacred.
10. **AI writes only to `*_ai` + `*_evidence` + `ai_extraction_meta`** — enforced by `ghl_writebacks` field allow-list.

---

## Nomenclature gotchas to remember

- `opportunity.first_contact__method` — **double underscore** (existing GHL key)
- `contact.file_upload__crittall_lead_form` — **double underscore**
- `contact.ienquiry_crittall_email` — **leading `i`** (existing GHL key)
- `contact.checkbox_2wpw` — operational assignment trigger, not analytics
- `contact.google_click_id` is canonical for gclid; `contact.gclid` is an approved alias
- Crittall handovers read `contact.marketing_consent_crittall` alongside `contact.marketing_consent`
- BGD legacy webchat lives under `contact.please_submit_your_enquiry_webchat` (COALESCE with canonical `please_explain_your_inquiry_webchat`)
- **Column name collisions:** `client_type`, `product_type` exist on BOTH `contacts` and `opportunities` — keep distinct

---

## What we have TODAY vs. what's in this blueprint

Our current pipelinePulse database has: `contacts`, `opportunities`, `stage_history`, `messages`, `installs`, `pending_opportunities`, `processed_events` (7 tables).

The blueprint has ~30 tables across 6 stages minus 5 dropped = **~25 tables to build**.

**Not yet in ours (that we need for Stage 1):**
- `sync_runs` (13 cols)
- `sweep_cursors` (3 cols)
- `ghl_custom_field_definitions` (12 cols)
- `users` (5 cols)
- `pipelines` (3 cols)
- `pipeline_stages` (5 cols)
- `tasks` (17 cols)
- `notes` (13 cols)
- `tags` (4 cols)
- Many new columns on `contacts`, `opportunities`, `messages`, `stage_history`

Ready for direction on which table(s) to start with.
