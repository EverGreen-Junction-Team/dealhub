# PipelinePulse — server

Private GHL Marketplace app implementing [`STAGE_HISTORY_WEBHOOK_PLAN.md`](../STAGE_HISTORY_WEBHOOK_PLAN.md).

Receives GHL opportunity webhooks → cleans the data → writes to self-hosted Supabase (Postgres). One canonical 4-table schema (`contacts`, `opportunities`, `stage_history`, `messages`) with `location_id` everywhere + Row-Level Security.

## What's built so far

| Layer | Status |
|---|---|
| OAuth install + uninstall callbacks | ✅ |
| Webhook receiver (RSA signature verify + idempotency) | ✅ |
| 4-table Postgres schema + RLS policies (migrations) | ✅ |
| Stage history writer (create / stage-update / delete) | ✅ |
| Message enrichment (fetch + filter conversation messages per stage window) | ✅ |
| Data cleaning (cheerio HTML strip + emoji regex) | ✅ |
| Orphan opportunity queue + daily sweep cron | ✅ |
| GHL API client with token refresh + retry | ✅ |

Not built yet: end-to-end deploy script (Phase 2 deliverable), production-grade alerting/monitoring, message_body_raw drop-after-validation cron.

## Layout

```
server/
├── migrations/
│   ├── 001_schema.sql           Plan Section 5 — 4 tables + indexes
│   ├── 002_rls.sql              Plan Section 6 — RLS policies
│   └── 003_internal.sql         installs · pending_opportunities · processed_events
├── src/
│   ├── index.js                 Express boot + cron start
│   ├── config.js                Env wiring (DATABASE_URL, GHL_*, etc.)
│   ├── db.js                    pg Pool · withTenant() · rawQuery()
│   ├── scripts/
│   │   └── migrate.js           Runs every .sql in /migrations
│   ├── routes/
│   │   ├── oauth.js             /oauth/callback · /oauth/uninstall
│   │   └── webhooks.js          /webhooks/ghl  (single ingress)
│   ├── services/
│   │   ├── ghlClient.js         OAuth exchange · token refresh · installs CRUD
│   │   ├── dataCleaner.js       HTML strip · emoji strip
│   │   ├── messageEnrichment.js Fetch messages within a stage window
│   │   ├── stageHistoryWriter.js Writes to contacts/opps/stage_history/messages
│   │   ├── orphanQueue.js       Enqueue/dequeue on create / move / delete
│   │   └── orphanSweep.js       Daily cron — emit stage row for stuck orphans
│   └── utils/
│       ├── logger.js            pino
│       └── verifySignature.js   RSA verify against GHL public key
```

## Run locally

```bash
cd server
cp .env.example .env
# fill in DATABASE_URL pointing at your self-hosted Supabase
# (and GHL_* + PUBLIC_BASE_URL once you've registered the marketplace app)
npm install
npm run migrate    # runs all .sql in /migrations against DATABASE_URL
npm run dev
```

GHL needs to reach `PUBLIC_BASE_URL` over HTTPS. Locally that means [ngrok](https://ngrok.com/), [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), or similar. In production, Caddy fronts the Node process with a Let's Encrypt cert.

Health probe: `curl http://localhost:4000/health`

## One-time GHL Marketplace setup

Done once by the developer in the [GHL Marketplace developer dashboard](https://marketplace.gohighlevel.com/) — **not** per install:

1. **Create a Private app** (this is a single-client deployment)
2. **OAuth → Redirect URL:** `${PUBLIC_BASE_URL}/oauth/callback`
3. **Scopes** (minimum):
   - `opportunities.readonly`
   - `opportunities.write`  ← **required for editing, creating or deleting
     deals**, and for followers. Separate from `opportunities.readonly`. Add it
     and **reauthorise**. NOT the same as `pipelines.write`, which this app
     deliberately does not request.
   - `contacts.readonly`
   - `businesses.readonly`  ← required by the Businesses page (migration 056).
   - `businesses.write`  ← **required for creating, editing or deleting
     businesses.** Separate from `businesses.readonly`, and NOT covered by
     `contacts.write`. Add it and **reauthorise**.
     An install created before this scope was added must be **reauthorised**;
     businessesSync logs a 401/403 with a `businesses.readonly scope missing`
     hint until it is.
   - `conversations/message.readonly`
   - `conversations.readonly`
   - `locations.readonly`
   - `contacts.write`  ← **required for editing contacts, tasks AND tags.**
     Tasks and tags both live under the contact (`/contacts/{id}/tasks`,
     `/contacts/{id}/tags`), so one scope covers all three. Without it every
     save returns 403 with "the contacts.write permission is missing". Add it in
     the marketplace app config and **reauthorise** — an existing install's
     token does not gain scopes on its own.

     Note on tags: attaching a tag to a contact needs only `contacts.write`,
     and creates the tag in the location's catalogue automatically if it does
     not exist. Editing the CATALOGUE itself (renaming or deleting a tag
     definition location-wide) is a different API under `locations/tags.write`,
     which this app deliberately does not request — see below.
4. **Webhook subscriptions** for the three opportunity events, all pointing at the same URL:
   ```
   ${PUBLIC_BASE_URL}/webhooks/ghl
   ```
   GHL automatically delivers `OpportunityCreate`, `OpportunityStageUpdate`, `OpportunityDelete` events for every installed location once configured — no per-install subscribe call needed.
5. **Uninstall URL:** `${PUBLIC_BASE_URL}/oauth/uninstall`
6. **Download the webhook RSA public key** and paste it into `.env` as `GHL_WEBHOOK_PUBLIC_KEY` (escape literal newlines as `\n`)

## Writes: what goes back to GoHighLevel

GHL is the source of truth. Every write goes to their API; our tables are
updated by the webhook that follows, not by the write itself. The exception is
noted below.

| What | Endpoint | Our row updated by |
|---|---|---|
| Contact fields | `PUT /contacts/{id}` | `ContactUpdate` webhook |
| Contact tags | `POST`/`DELETE /contacts/{id}/tags` | `ContactTagUpdate` webhook → `reconcileTags` |
| Task create | `POST /contacts/{id}/tasks` | `TaskCreate` webhook |
| Task complete | `PUT /contacts/{id}/tasks/{taskId}/completed` | `TaskComplete` webhook + echo |
| Task edit | `PUT /contacts/{id}/tasks/{taskId}` | **the echo only — there is no `TaskUpdate` webhook** |
| Task delete | `DELETE /contacts/{id}/tasks/{taskId}` | `TaskDelete` webhook + local soft-delete |
| Note create | `POST /contacts/{id}/notes` | `NoteCreate` webhook |
| Note edit | `PUT /contacts/{id}/notes/{noteId}` | `NoteUpdate` webhook |
| Note delete | `DELETE /contacts/{id}/notes/{noteId}` | `NoteDelete` webhook + local soft-delete |
| Business create | `POST /businesses` | **the echo only — businesses have no webhooks** |
| Business edit | `PUT /businesses/{id}` | **the echo only** |
| Business delete | `DELETE /businesses/{id}` | **the echo only** + local `is_active = false` |
| Deal edit | `PUT /opportunities/{id}` | `OpportunityUpdate` webhook |
| Deal status | `PUT /opportunities/{id}/status` | `OpportunityStatusUpdate` webhook |
| Deal create | `POST /opportunities/` | `OpportunityCreate` webhook |
| Deal delete | `DELETE /opportunities/{id}` | `OpportunityDelete` webhook |
| Deal followers | `POST`/`DELETE /opportunities/{id}/followers` | `OpportunityUpdate` webhook |

Three constraints worth knowing before extending this:

**Tags must use the dedicated endpoints.** `PUT /contacts/{id}` replaces the
whole tag array, so sending a partial list deletes the rest. `buildContactPatch`
throws if handed `tags` for that reason; `POST`/`DELETE /contacts/{id}/tags` are
additive and cannot touch a tag they weren't given.

**Tasks and tags hang off the contact.** Both are `/contacts/{contactId}/...`,
so a task with no `contact_id` (which the schema permits — GHL doesn't always
attach one) cannot be written at all, and tags are always contact-scoped. A tag
set on an *opportunity* is not reachable through the contact endpoint, so the UI
shows those as read-only rather than offering an edit that would silently do
nothing.

**Deal writes never touch Postgres, and that rule is stricter here than
anywhere else.** Opportunities have full webhook coverage, and every event lands
in `stageHistoryWriter`, which opens and closes `stage_history` rows, records
field changes, reconciles tags and refreshes associations. `stage_history` is
the basis of every "days in stage" figure and is the one table that **cannot be
rebuilt from current state** — so writing the opportunities row here as well
would leave the two disagreeing permanently. There is deliberately no
`applyEcho` in `ghlOpportunityWrite.js`, unlike tasks and businesses.

Three deal-specific things:

- **Status has its own route.** `PUT /opportunities/{id}/status` is the only
  endpoint that accepts `lostReasonId`; marking a deal lost through the general
  update drops the reason silently. `PATCH /api/deals/:id` therefore **refuses**
  `status` with an error naming the right route.
- **A stage id must belong to the deal's own pipeline.** GHL rejects a mismatch
  with a message that doesn't say why, so the route checks `pipeline_stages`
  first. `GET /api/deals/:id/stages` now returns each stage's `id` — it used to
  send names only, which no write endpoint accepts.
- **Pipelines are deliberately not writable.** They need `pipelines.write` /
  `pipelines.create`, which this app does not request. Their update **replaces
  the whole stages array** and moves every opportunity out of a removed stage in
  bulk; their delete is a **hard delete of the pipeline and all its
  opportunities**. Both are location-wide changes triggered from a per-deal
  screen. If wanted, they belong in the Control panel.

**Businesses have no webhooks at all** — which is why `businessesSync` is a
nightly cron rather than a webhook handler. Every business write therefore
applies GHL's echoed response to Postgres directly; without that, a change would
be invisible in this app for up to 24 hours. Two of their rules are worth
knowing: `domainname` is **unique per location** (checked against our rows first
so the error names the clashing business), and a business with over 2000
contacts can be **renamed only once per 24 hours** — we can't see their contact
count, so that surfaces as a translated 422.

Business writes need **`businesses.write`**, which is a different scope from the
`businesses.readonly` the daily sync already uses. Migration 059 promoted
`domainname` and `companylogo` out of `raw_business` into real columns, and the
sync mapper was updated alongside — without that, the nightly run would blank
whatever an edit had just written.

**Notes cannot be restored.** GHL has a restore endpoint but it is not exposed
over OAuth (`restrictOAuthChannel`), so a delete through this app is final on
their side. Our row is soft-deleted and keeps the text, which is the only
recovery path available — worth knowing before wiring any bulk delete.

**At most two notes can be pinned per contact.** GHL rejects the third.
`ghlNoteWrite` counts first and returns a readable message; the editor shows
when there's no room. Migration 058 promoted `title`, `color` and `pinned` out of
`raw_note` into real columns — before it, a note whose author gave it a title
had that title rendered as body text while the UI invented a heading from the
first sentence.

**We do not request `locations/tags.write`.** `GET /locations/{id}/tags` (read,
under `locations.readonly`) fills the catalogue for autocomplete via the daily
`tagsSync`. The create/update/delete tag-definition endpoints are deliberately
not wired: renaming or deleting a tag definition affects every contact in the
location at once, and `tag_history` stores the name as applied, so a rename
would make historical rows disagree with the catalogue. Attaching tags already
creates missing ones automatically, so nothing needs that scope.

## How data flows end-to-end

```
1. Agency installs the app → /oauth/callback
   - Token exchange (services/ghlClient.js)
   - INSERT into installs (T₀ = installed_at)

2. GHL fires an opportunity webhook → /webhooks/ghl
   - utils/verifySignature.js verifies RSA signature
   - INSERT into processed_events (dedupes retries via UNIQUE constraint)
   - orphanQueue.enqueue / dequeue based on event type
   - stageHistoryWriter.handleOpportunityEvent:
       a. withTenant(locationId, ...)  → sets app.location_id, RLS on
       b. UPSERT contacts
       c. UPSERT opportunities
       d. close prior open stage_history row, open new one
       e. messageEnrichment.fetchContactMessagesInWindow(install, contactId,
                                                        windowStart, now)
       f. dataCleaner.cleanMessageBody(...) per message
       g. INSERT cleaned messages with stage_history_id linkage

3. Daily 03:00 UTC cron → orphanSweep.runOrphanSweep
   - For each pending_opportunities row older than 10 min:
       emit a synthetic stage_history row · clear the queue entry
```

## Postgres connection model

- **Migrations** use a fresh `pg.Client` (no pool, no RLS context) so they can DDL freely
- **Runtime per-tenant writes** go through `withTenant(locationId, async (client) => { ... })`
  - Begins a transaction
  - Sets `app.location_id` via `set_config(...)` so RLS activates
  - Commits on success, rolls back on throw
  - This is the only safe write path — a missing tenant filter is impossible because every query in the transaction is scoped by the session var
- **App-internal writes** (`installs`, `pending_opportunities`, `processed_events`) skip the tenant ceremony via `rawQuery(...)` — those tables don't have RLS

## Manually testing a webhook (dev mode)

When `GHL_WEBHOOK_PUBLIC_KEY` is empty and `NODE_ENV=development`, signature verification is skipped:

```bash
curl -X POST http://localhost:4000/webhooks/ghl \
  -H "Content-Type: application/json" \
  -d '{
    "id": "evt_test_1",
    "type": "OpportunityStageUpdate",
    "locationId": "your-test-location-id",
    "timestamp": "2026-05-26T10:00:00Z",
    "opportunity": {
      "id": "opp_123",
      "contactId": "cnt_456",
      "name": "Acme Corp",
      "pipelineId": "pl_1",
      "pipelineName": "Sales Pipeline",
      "pipelineStageId": "st_negotiation",
      "stageName": "Negotiation",
      "status": "open",
      "monetaryValue": 5000,
      "customFields": {
        "product_system": "Crittall",
        "product_type": "Bifold Door",
        "meddic_1": "Champion identified",
        "postcode": "SW1A 1AA"
      }
    },
    "contact": {
      "id": "cnt_456",
      "customFields": {
        "utm_source": "google",
        "utm_campaign": "spring_2026"
      }
    }
  }'
```

The install referenced by `locationId` must already exist (you'll need to complete the OAuth flow at least once for that location, or insert a row into `installs` manually for testing) — otherwise the receiver drops the event.

## Verifying it worked

```sql
SET app.location_id = 'your-test-location-id';
SELECT * FROM contacts;
SELECT * FROM opportunities;
SELECT * FROM stage_history ORDER BY entered_at DESC;
SELECT * FROM messages ORDER BY message_timestamp DESC LIMIT 20;
```

## Hosting checklist (per plan Sections 7–8)

- ✅ App server in EU — **Hetzner Falkenstein (DE)**, Ubuntu 22.04, 2 cores / 4 GB RAM / 40 GB SSD
- ✅ Supabase host in EU — **Netcup Nuremberg (DE)**, 2 cores / 4 GB RAM / 60 GB SSD via elest.io
- ☐ Caddy fronting the Node process for HTTPS + Let's Encrypt cert
- ☐ `ufw` allowing 443/tcp only; everything else closed
- ☐ Self-hosted Supabase via elest.io (managed Docker)
- ☐ Daily Postgres dump → EU-region S3-compatible bucket (7-day retention)
- ☐ `unattended-upgrades` for OS patches

EU residency (Germany) is confirmed acceptable by the client — UK-only is not required.
