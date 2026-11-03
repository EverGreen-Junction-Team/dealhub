# GHL → Supabase Webhook Integration — Project Plan

**Project:** Stage History + Conversation Data → Self-hosted Supabase on EU (Germany) server

---

## 1. What we're building

The goal is to pull GoHighLevel (GHL) **conversation + opportunity stage data** out of the sub-account(s) and into a **database we control**, so that analytics and LLM summarization can later be built on top of the same dataset — without ever exporting CSV by hand. (Those downstream pieces are *not* in scope of this build — see Section 13.)

The new flow:

1. **GHL fires a webhook** at our server whenever an opportunity moves between stages (real-time). A separate once-per-day job sweeps for opportunities that were created but never moved (so nothing falls through the cracks).
2. **A private GHL Marketplace app** (we build, deployed on the EU server) receives that webhook, enriches it with conversation messages, cleans the data, and writes structured rows into **self-hosted Supabase** (Postgres) running on the same EU footprint.
3. **Analytics and LLM summarization can be built on top of the database** by you — same server, same data. **Not in scope** of this build (see Section 13).

Everything stays inside the EU (GDPR-compliant — Germany region agreed with the client; see Section 7).

```
   ┌──────────────┐    real-time on stage change       ┌─────────────────────────┐    INSERT/UPSERT      ┌─────────────────────┐
   │              │ ─────────────────────────────────→ │                         │ ────────────────────→ │                     │
   │  GoHighLevel │    daily sweep for orphan opportunities │  Private GHL App    │                       │  Self-hosted        │
   │  (sub-acct)  │ ─────────────────────────────────→ │  (Node.js, EU server)   │                       │  Supabase (Postgres)│
   │              │                                    │  + data cleaning        │                       │  (EU host)          │
   └──────────────┘                                    └─────────────────────────┘                       └─────────┬───────────┘
                                                                                                                   │
                                                                                                                   │ SQL queries / analytics
                                                                                                                   ▼
                                                                                            ┌──────────────────────────────────────────────┐
                                                                                            │  Analytics + LLM summaries                   │
                                                                                            │  (you can perform on top of Supabase —       │
                                                                                            │   NOT in scope of this build; see Section 13)│
                                                                                            └──────────────────────────────────────────────┘
```

---

## 2. Webhook Triggers (when does the system fire?)

### 2.1 — Real-time: Opportunity Stage Update
- Fires the moment an opportunity moves from one stage to another in GHL
- One webhook event **per message** (flat structure, not grouped) — so a stage with 6 messages fires 6 events

### 2.2 — Orphan opportunities (created but never moved)
The "lead came in, sat there" case — opportunities that exist but have no stage change and no communication.

**How we handle it:**
1. When an opportunity is **created** in GHL, we store a record of it internally (in our own tracking table — "pending stage update")
2. When that opportunity **gets a stage update**, we fire the normal real-time webhook (with messages bucketed into the stage window) AND remove the record from the pending list
3. **Once per day**, a sweep finds any records still sitting in the pending list (opportunities that have been created but never moved). For each, we fire the webhook **once**, then remove from the pending list

Each orphan opportunity is therefore notified at most **one time** — either when it finally moves, or once via the daily sweep when it's been sitting too long. We won't spam the system with the same orphan every day.

---

## 3. Webhook Payload — what each event looks like

One event = one (message × stage) row. Same flat shape as the CSV today. JSON shape:

```jsonc
{
  // identifiers
  "location_id": "QufTHN7dRygscPmKguNZ",
  "contact_id": "hGFKHeZCWwcx6R42bpHA",
  "opportunity_id": "nweP6H6lZsFm84CeKGWp",

  // opportunity snapshot (current values at webhook time)
  "opportunity": {
    "name": "Henrietta Haines",
    "pipeline_id": "DftlnFZD4tQKrloHE3UF",
    "pipeline_stage_id": "c9a93fef-23a5-44c9-8bd5-6a1aae709abd",
    "pipeline_name": "Sales Pipeline",
    "stage_name": "Won",
    "status": "open",                    // open | won | lost | abandoned
    "monetary_value": 5000,
    "assigned_to": "zT46WSCPbudrq4zhWMk6",
    "custom_fields": {
      "meddic_1": "...", "meddic_2": "...", "meddic_3": "...",
      "meddic_4": "...", "meddic_5": "...", "meddic_6": "...",
      "meddic_7": "...", "meddic_8": "...", "meddic_9": "...",
      "meddic_10": "...",
      "client_type": "...",
      "product_system": "Crittall",                       // brand/material — Crittall | Cortizo | Genosal | …
      "product_type": "Bifold Door",                       // specific product within the system
      "postcode": "SW1A 1AA",                              // opportunity-level postcode (NOT contact address postcode)
      "lead_source_opportunity": "...", "first_contact__method": "...",
      "inquiry": "...", "upload_from_enquiry": "..."
      // …any other opportunity custom fields, by exact field name
    }
  },

  // contact snapshot
  "contact": {
    "custom_fields": {
      "google_click_id": "...", "gbraid": "...", "wbraid": "...",
      "gad_source": "...",
      "utm_source": "...", "utm_medium": "...", "utm_campaign": "...",
      "utm_content": "...", "utm_term": "...",
      "marketing_consent_crittall": true,
      "ienquiry_crittall_email": "...", "file_upload_crittall_email": "...",
      "checkbox_2wpw": "..."
      // …any other contact custom fields
    }
  },

  // stage history (this opportunity × this stage)
  "stage_history": {
    "stage_id": "c9a93fef-23a5-44c9-8bd5-6a1aae709abd",   // stable internal pipeline_stage_id — canonical (use this for queries / joins)
    "stage_name": "Sales Qualified",                      // display name AT TIME OF STAGE CHANGE — snapshot, not live (so renames don't rewrite history)
    "entered_at": "2026-04-20T15:49:01.143Z",
    "left_at": null,                                     // null = still in this stage
    "in_stage_duration_seconds": 2388506,                // computed: now - entered_at, or left_at - entered_at
    "current_stage": true,                                // true if still in this stage
    "ghost_opportunity": false,                           // computed: true when the opportunity does NOT appear in GHL /opportunities/search
                                                          //           but IS referenced by activity events (deleted/merged opportunity)
    "custom_fields_snapshot": {                           // snapshot of opportunity.custom_fields AT THIS STAGE CHANGE.
      "product_system": "Crittall",                       // captures the value the field had when the opportunity entered this stage —
      "product_type": "Bifold Door",                      // so if the lead later switches Crittall → Cortizo mid-pipeline, the earlier
      "client_type": "...", "lead_source_opportunity": "...",
      "first_contact__method": "..." , "inquiry": "..."   // stage rows still show the original value.
      // …all opportunity custom fields, frozen at this moment
    }
  },

  // one message (one event = one message)
  "message": {
    "message_id": "IhcjqiP1KJpjOEejv2AP",
    "conversation_id": "wMjyjNMN6VaNOBsJ0AbF",
    "timestamp": "2026-04-27T11:22:15.366Z",
    "body": "Hi Shari, just confirming…",                // CLEANED (see Section 4)
    "direction": "outbound",                              // inbound | outbound
    "channel": "WhatsApp",                                // SMS | Email | WhatsApp | Call | Webchat | …
    "is_call": false
  }
}
```

### When there's no message in a stage window
The stage_history block still fires once (so empty stages are tracked), and `message` is `null` or has empty fields.

---

## 4. Data Cleaning (applied in the private app before INSERT)

GHL's raw message bodies contain stuff that's not analyst-friendly. We strip it out before storing.

### 4.1 Emails
- **Keep**: HTML content **inside** `<body>...</body>` (so links and formatting survive)
- **Strip**: email headers (`From:`, `To:`, MIME boundaries), footers, signatures, unsubscribe links, tracking pixels
- **Tech approach**: parse with `cheerio` (server-side jQuery for Node) — extract `body` element's inner HTML, then run a sanitizer pass to remove known footer/header patterns

### 4.2 SMS / WhatsApp
- **Strip emojis** using Unicode regex: `/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu`
- Strip GHL UI placeholders like `>AUDIO<`, `>IMAGE<` (best-effort, not a blocker)

### 4.3 What stays raw (for audit)
- We keep a `message_body_raw` column for the first month so any "this body looks wrong" reports can be debugged against the original. Drop the column after validation period.

---

## 5. Database Schema (Supabase / Postgres)

**4 tables**, normalized. Each row has `location_id` for multi-tenant isolation (see Section 6).

### 5.1 `contacts`
One row per contact per sub-account. UTM/Google-ads fields promoted to dedicated columns for easy filtering; everything else lives in JSONB.

```sql
CREATE TABLE contacts (
  location_id        TEXT NOT NULL,
  contact_id         TEXT NOT NULL,
  -- Note: postcode is intentionally NOT here. The client uses the custom opportunity field
  -- `opportunity.postcode` (per-opportunity, not per-contact address). See opportunities.postcode below.
  gclid              TEXT,
  gbraid             TEXT,
  wbraid             TEXT,
  gad_source         TEXT,
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  utm_content        TEXT,
  utm_term           TEXT,
  marketing_consent  BOOLEAN,
  custom_fields      JSONB,
  imported_at        TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, contact_id)
);
CREATE INDEX ON contacts USING GIN (custom_fields);
```

### 5.2 `opportunities`
One row per opportunity. MEDDIC fields promoted; rest in JSONB.

```sql
CREATE TABLE opportunities (
  location_id          TEXT NOT NULL,
  opportunity_id       TEXT NOT NULL,
  contact_id           TEXT NOT NULL,
  name                 TEXT,
  pipeline_id          TEXT,
  pipeline_name        TEXT,
  current_stage_id     TEXT,
  current_stage_name   TEXT,
  status               TEXT,
  monetary_value       NUMERIC(12, 2),
  assigned_to          TEXT,
  meddic_1             TEXT, meddic_2  TEXT, meddic_3  TEXT,
  meddic_4             TEXT, meddic_5  TEXT, meddic_6  TEXT,
  meddic_7             TEXT, meddic_8  TEXT, meddic_9  TEXT,
  meddic_10            TEXT,
  client_type          TEXT,
  product_system       TEXT,    -- brand/material (Crittall, Cortizo, Genosal, …) — promoted from opportunity custom field
  product_type         TEXT,    -- specific product within the system (Bifold Door, Casement Window, …)
  postcode             TEXT,    -- opportunity-level postcode custom field (per-opportunity, NOT the contact address)
  first_contact__method    TEXT,
  lead_source_opportunity  TEXT,
  inquiry              TEXT,
  custom_fields        JSONB,
  is_ghost             BOOLEAN DEFAULT false,
  is_deleted           BOOLEAN DEFAULT false,
  created_at_ghl       TIMESTAMPTZ,
  imported_at          TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, opportunity_id),
  FOREIGN KEY (location_id, contact_id) REFERENCES contacts (location_id, contact_id)
);
CREATE INDEX ON opportunities (location_id, contact_id);
CREATE INDEX ON opportunities (location_id, status);
CREATE INDEX ON opportunities USING GIN (custom_fields);
```

### 5.3 `stage_history`
One row per (opportunity × stage_session). Immutable append-only history.

```sql
CREATE TABLE stage_history (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id                 TEXT NOT NULL,
  opportunity_id              TEXT NOT NULL,
  contact_id                  TEXT NOT NULL,
  stage_id                    TEXT,                     -- stable internal pipeline_stage_id — CANONICAL (use for queries / joins)
  stage_name                  TEXT NOT NULL,            -- display name AT TIME OF STAGE CHANGE — snapshot, not live
  entered_at                  TIMESTAMPTZ NOT NULL,
  left_at                     TIMESTAMPTZ,
  in_stage_duration_seconds   INTEGER,
  current_stage               BOOLEAN DEFAULT false,
  deleted                     BOOLEAN DEFAULT false,    -- computed: true on the row that closes a deletion event
  ghost_opportunity           BOOLEAN DEFAULT false,    -- computed: true when the opportunity doesn't exist in GHL's
                                                        -- /opportunities/search but IS referenced by activity
                                                        -- events (i.e. deleted/merged opportunity reconstructed from history)
  -- Per-stage snapshot of opportunity custom fields AT THE MOMENT OF THE STAGE CHANGE.
  -- The opportunities table holds the LIVE value; stage_history rows hold the HISTORICAL value.
  -- So if a lead switches Crittall → Cortizo mid-pipeline, the row for the earlier stage still
  -- shows "Crittall" — you can answer "what product were they interested in at Sales Qualified?".
  product_system              TEXT,                     -- promoted from custom_fields_snapshot for fast filtering
  product_type                TEXT,                     -- promoted from custom_fields_snapshot for fast filtering
  custom_fields_snapshot      JSONB,                    -- everything else: opportunity custom fields frozen at this stage transition
  imported_at                 TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id)
);
CREATE INDEX ON stage_history (location_id, opportunity_id, entered_at);
CREATE INDEX ON stage_history (location_id, stage_id);       -- query by stable stage id (renames don't break)
CREATE INDEX ON stage_history (location_id, stage_name);     -- still useful for human-readable reports
CREATE INDEX ON stage_history USING GIN (custom_fields_snapshot);
```

> **Stage identifier convention:** `stage_id` is the stable GHL `pipeline_stage_id` (UUID) — queries, joins, and downstream analytics should reference this. `stage_name` is a frozen *snapshot* of the display name at the time of the stage change, so historical rows continue to show the right label even if the stage is renamed in GHL later. Renames in GHL do not break any historical relationships.

### 5.4 `messages`
One row per message, optionally linked to a stage.

```sql
CREATE TABLE messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         TEXT NOT NULL,
  contact_id          TEXT NOT NULL,
  opportunity_id      TEXT,
  stage_history_id    UUID,
  message_id          TEXT,
  conversation_id     TEXT,
  message_timestamp   TIMESTAMPTZ NOT NULL,
  message_body        TEXT,            -- CLEANED
  message_body_raw    TEXT,            -- original (drop after validation)
  message_direction   TEXT,
  message_channel     TEXT,
  is_call             BOOLEAN DEFAULT false,
  imported_at         TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (location_id, opportunity_id) REFERENCES opportunities (location_id, opportunity_id),
  FOREIGN KEY (stage_history_id)             REFERENCES stage_history (id) ON DELETE SET NULL,
  FOREIGN KEY (location_id, contact_id)      REFERENCES contacts (location_id, contact_id)
);
CREATE INDEX ON messages (location_id, opportunity_id, message_timestamp);
CREATE INDEX ON messages (location_id, contact_id, message_timestamp);
CREATE INDEX ON messages (location_id, stage_history_id);
```

### Why this shape (plain English)
- **One opportunity = one row in `opportunities`**, no matter how many stages it passes through. If its monetary value changes, we update one row, not hundreds.
- **One stage occupancy = one row in `stage_history`**. Three stage transitions on the same opportunity = three rows.
- **One message = one row in `messages`**. Linked to whichever stage it fell inside via `stage_history_id`.
- **Custom fields use JSONB** so we don't have to migrate the schema every time GHL adds a new field. Frequently-queried ones (MEDDIC, UTMs) are promoted to dedicated columns for speed.

### Rebuilding the CSV at any time
A single JOIN reconstructs the exact CSV output we produce today:
```sql
SELECT c.contact_id, o.opportunity_id, o.monetary_value,
       sh.stage_name, sh.entered_at, sh.left_at, sh.in_stage_duration_seconds,
       sh.current_stage, sh.deleted,
       m.message_timestamp, m.message_body, m.message_direction, m.message_channel,
       m.message_id, m.conversation_id, m.is_call
FROM messages m
JOIN stage_history sh ON m.stage_history_id = sh.id
JOIN opportunities o  ON sh.opportunity_id = o.opportunity_id AND sh.location_id = o.location_id
JOIN contacts c       ON o.contact_id = c.contact_id AND o.location_id = c.location_id
WHERE o.location_id = $1
ORDER BY sh.opportunity_id, sh.entered_at, m.message_timestamp;
```

---

## 6. Multi-Tenant Isolation

If more clients onboard later, each client's data must be **completely walled off** from the others in the same Supabase instance.

We do this with Postgres **Row-Level Security (RLS)**:

```sql
ALTER TABLE contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages      ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso ON contacts        USING (location_id = current_setting('app.location_id'));
CREATE POLICY tenant_iso ON opportunities   USING (location_id = current_setting('app.location_id'));
CREATE POLICY tenant_iso ON stage_history   USING (location_id = current_setting('app.location_id'));
CREATE POLICY tenant_iso ON messages        USING (location_id = current_setting('app.location_id'));
```

**Plain English**: every table has a `location_id` column. Postgres enforces "you can only see rows where `location_id` matches the one your session declared." Even if a query forgets the `WHERE location_id = …` filter, Postgres blocks cross-tenant data automatically.

This is the standard Supabase multi-tenant pattern and is bulletproof when configured correctly.

---

## 7. EU Data Residency (Germany — Agreed with Client)

**Every byte of customer data stays inside the EU.** The client has confirmed that Germany (specifically: Hetzner Falkenstein for the app server, Netcup Nuremberg for self-hosted Supabase) is acceptable — UK-only residency is not required.

### Where data physically lives

| Component | Location | Notes |
|---|---|---|
| GHL sub-account | Wherever GHL stores it (US-based) | Out of our control — but data leaves GHL only as the webhook payload to OUR server |
| Webhook receiver (private app) | **Germany — Hetzner Falkenstein** | Ubuntu 22.04, 2 cores / 4 GB RAM / 40 GB SSD |
| Supabase (Postgres) | **Germany — Netcup Nuremberg** | Self-hosted via elest.io, 2 cores / 4 GB RAM / 60 GB SSD |
| Logs / backups | **Germany / EU** | Local filesystem + EU-region object storage for off-site backups |
| Developer access during build | From anywhere, but no copies kept outside the EU | We will not export data to laptops outside the EU during debug |

### What this rules out
- AWS US regions / any non-EU region
- Supabase Cloud (we use self-hosted regardless)
- Logging services that export to non-EU destinations (e.g. Datadog US, default Sentry)

### What we'll use
- Hetzner Falkenstein (app server, already provisioned)
- Self-hosted Supabase on Netcup Nuremberg via elest.io (already provisioned)
- Local filesystem logs + EU-region S3-compatible backups

---

## 8. Server Specifications

### Provisioned spec (as of 2026-05-26)
| Resource | Spec | Why |
|---|---|---|
| App server | **Hetzner Falkenstein (DE)** — Ubuntu 22.04, 2 cores / 4 GB RAM / 40 GB SSD | EU region, $0.023/hr via elest.io |
| Supabase host | **Netcup Nuremberg (DE)** — 2 cores / 4 GB RAM / 60 GB SSD | EU region, $0.022/hr via elest.io |
| OS | **Ubuntu 22.04 LTS** | LTS = supported until 2027; broadest community |
| Network | Public IPv4 + HTTPS reverse proxy (Caddy or Traefik) | For GHL to reach the webhook endpoint over HTTPS |
| Backup | Daily Postgres dump → EU-region object storage | 7-day retention; encrypted at rest |

### Software we'll pre-install
| Software | Version | Purpose |
|---|---|---|
| Docker + Docker Compose | latest stable | Run Supabase + private app as containers |
| Node.js | 20 LTS | The private app runtime |
| Caddy (or Traefik) | latest | HTTPS reverse proxy with auto-cert via Let's Encrypt |
| `git` | latest | Pull/deploy the private app code |
| `unattended-upgrades` | system | Auto-apply security patches |

### Networking
- Inbound: `443/tcp` only (Caddy handles HTTPS termination)
- Outbound: GHL API endpoints (whitelist if possible)
- All other ports closed by `ufw` firewall

---

## 9. Self-hosted Supabase vs Supabase Cloud

### Our recommendation: **self-hosted on the EU server**

| Criterion | Self-hosted (EU — Germany) | Supabase Cloud |
|---|---|---|
| **EU residency** | ✅ Guaranteed — runs on dedicated EU boxes | ✅ EU region available, but managed by Supabase |
| **Cost** | ✅ Free (just server cost — ~$0.045/hr combined) | $25/mo per project minimum, scales up fast |
| **Control** | ✅ Full — backup, restore, schema, RLS policies | ❌ Locked to their dashboard + limits |
| **Multi-tenant separation** | ✅ Postgres RLS, your rules | ✅ Same RLS, but data sits on their servers |
| **Setup complexity** | ⚠️ Docker compose + one-time setup | ✅ Click-to-deploy |
| **Maintenance** | ⚠️ You patch + monitor | ✅ Managed by Supabase |

Self-hosted gives full control over backups, schema, and RLS — and the elest.io managed-Docker option keeps the maintenance burden low.

The maintenance burden is real but manageable — Docker compose + cron-based backups + the same monthly $55 covers it.

---

## 10. Deliverables & Timeline

### Phase 1 — Documents
- ✅ This document
- 📋 Full webhook payload JSON spec (Section 3 expanded, plus error/retry semantics)
- 📋 Server provisioning script (`provision.sh`) — installs Docker, Node.js, Caddy, sets up firewall
- 📋 Supabase docker-compose with our schema migration files
- 📋 Setup instructions for the Marketplace user creation, server SSH, etc.

### Phase 2 — Build (estimated 1–2 weeks)
- Private GHL Marketplace app code
  - Webhook subscription for stage update (real-time)
  - Internal tracking table for opportunity-created events (orphan queue)
  - Daily sweep job that fires one-time notifications for orphan opportunities + clears them from the queue
  - Payload normalizer + data cleaner (HTML strip + emoji strip)
  - Supabase writer with retry + idempotency
  - Health-check endpoint + structured logs
- Deployed to the EU (Germany) server via the provided provision script
- End-to-end test: trigger a stage change in GHL → confirm row appears in Supabase within ~5 seconds

### Phase 3 — Validation
- Test reading from Supabase via direct SQL to confirm rows are queryable
- Confirm multi-tenant isolation (we'll add a test sub-account temporarily)
- Confirm EU residency is clean (review server region, no logs to non-EU destinations)

### Phase 4 — Go-live + ongoing
- Switch to production
- Monthly subscription kicks in
- Bug fixes / minor changes covered

---

## 11. Confirmations (all received)

1. ✅ **Self-hosted Supabase** on the EU (Germany) server — agreed
2. ✅ **Server specs** — Hetzner Falkenstein (app) + Netcup Nuremberg (Supabase), both provisioned via elest.io, Ubuntu 22.04 LTS, 2 cores / 4 GB RAM each
3. ✅ **EU data residency (Germany)** — agreed (UK-only not required by client)

---

## 12. Commercial Terms

| Item | Amount | When |
|---|---|---|
| **Setup fee** | $700 USD | Split 50/50 |
| – Half on confirmation | $350 | ✅ Received |
| – Half on completion | $350 | When webhook is live + writing to Supabase |
| **Monthly subscription** | $55 USD/month | Starts when the system goes live. Covers uptime monitoring, minor changes, bug fixes |
| **Major changes (out of scope)** | Quoted separately | Before any work begins |
| **Payment method** | ExportKit "Custom Charge" function | One charge per milestone; confirmation email sent after each |

---

## 13. Out of scope (so it's clear what's NOT included)

- Analytics jobs / queries on top of Supabase
- LLM summarization (prompts, model selection, output processing)
- Business Intelligence dashboard configuration
- GHL marketplace app distribution (this is a **private app**, just for this account)
- Historical data backfill — only forward-going from go-live (a separate one-time backfill can be quoted if needed)

