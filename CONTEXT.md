# PipelinePulse / Opportunity Stage History — Full Context

Paste this at the start of a new Claude session to resume work. Everything below is what has been built, what's live, what's decided, and what's next.

---

## 1. The client & the business

**Client:** James Stevens (Evergreen Junction / EGJ). Non-technical founder building a sales-improvement consultancy for glazing/window companies.

**Vendor:** Vaultsuite Team (you). Sign customer emails as "Vaultsuite Team" — never personal name. Client-facing UIs must be premium/polished.

**End customer:** Crittall (Sales Director: Charlie). Plus three sister companies James manages:
- Bespoke Glazing Design ("BGD") — used as staging/QA sandbox
- Veritas Glazing Solutions
- Omnia Glazing

**Domain:** Windows, doors, bifolds — high-ticket B2B/B2C glazing. Deals are £5k–£200k+. Long sales cycles, lots of back-and-forth over WhatsApp/email.

**Commercial to date:**
- Phase 1: $700 one-off + $55/month recurring for the webhook → Supabase pipeline. Delivered.
- Phase 2: to be quoted. Recommended **$5,000 fixed, 3 milestones**. Monthly support should rise to **$175/month** once phase 2 is live.

---

## 2. Infrastructure

**Hosting:**
- Node app + cloudflared tunnel: Ubuntu VM at `root@ubuntu-kuzev-u74328` (Netcup, provisioned by James)
- Database: **Supabase Cloud** (project ref `qxzpncjvnkmxhggeswpu`, EU-West-2)
- Previous self-hosted Supabase VM was decommissioned after migration
- Public hostname: `https://app.pipelineegj.com` (Cloudflare tunnel UUID `9d1a05df-7249-443c-a04b-166660de8f15`)

**Database connection:** must use Supavisor **transaction pooler** URL (direct URL is IPv6-only, VM can't reach it):
```
DATABASE_URL="postgresql://postgres.qxzpncjvnkmxhggeswpu:<PASSWORD>@aws-1-eu-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true"
```
Username must include the project ref suffix (`postgres.qxzpncjvnkmxhggeswpu`, not bare `postgres`).

**Process manager:** PM2. Processes:
- `app` (id 1) — the Node webhook receiver
- `pp-tunnel` (id 2) — cloudflared (single instance; duplicate was cleaned up)
- `pm2-logrotate` module

**Boot order:** `/health` responds immediately, `pingDb()` runs in background so DB outages don't block liveness probes.

---

## 3. Codebase — `/pipelinePulse/server`

```
migrations/
  001_schema.sql               — 4 canonical tables (contacts, opportunities, stage_history, messages)
  002_rls.sql                  — RLS policies using set_config('app.location_id')
  003_internal.sql             — installs, pending_opportunities, processed_events
  004..009                     — nullable tokens, reinstalled_at, assigned_to_name, first_stage_*, message_status, triggered_by
  010_stage_history_dedup.sql  — unique index for backfill ON CONFLICT DO NOTHING
  011_from_backfill.sql        — `from_backfill BOOLEAN` on all 4 tables + partial indexes
  012_analytics_views.sql      — vw_opportunity_flat + vw_opportunity_messages_json

src/
  index.js                     — Express boot, pino-http slim logs, /health non-blocking
  config.js                    — env loader, softReq() for GHL creds
  db.js                        — pg.Pool, withTenant(locationId, fn) for RLS, rawQuery()
  routes/
    oauth.js                   — /oauth/callback (INSTALL). No /oauth/uninstall route (removed — UNINSTALL comes via signed webhook)
    webhooks.js                — RSA signature verify, dedup via processed_events, dispatch to writer
  services/
    stageHistoryWriter.js      — the core writer. handleOpportunityEvent(install, eventType, event)
    ghlClient.js               — OAuth + token refresh (5min buffer), ghlRequest() with axios-retry
    ghlEnrichment.js           — pipeline lookup, custom-field maps (dual fetch: default + ?model=opportunity), user names. In-memory cached.
    messageEnrichment.js       — TWO-PASS message fetch via /conversations/messages/export (default + channel=Email). Email is silently dropped without the explicit filter.
    dataCleaner.js             — cleanEmail (strips style+class attrs, keeps HTML), cleanText (strips emoji icons only), cleanMessageBody
    orphanQueue.js              — enqueues opps created without a stage change; handles flat webhook payload (event.id = opp id)
    orphanSweep.js             — daily cron: sweeps pending opps + purges processed_events older than 14 days
  scripts/
    migrate.js                 — runs every .sql in lexicographic order, idempotent
    backfill.js                — historical backfill script (see §5)
  utils/
    logger.js                  — pino with slimErr serializer (strips 50KB axios error objects, redacts Bearer tokens)
```

**Package scripts:**
```json
"start": "node src/index.js",
"dev": "node --watch src/index.js",
"migrate": "node src/scripts/migrate.js",
"backfill": "node src/scripts/backfill.js"
```

---

## 4. Data model — the 4 canonical tables

**contacts** — one row per (location_id, contact_id). Promoted columns: gclid/gbraid/wbraid/gad_source/utm_*/marketing_consent. Plus `custom_fields` JSONB. `from_backfill BOOLEAN`.

**opportunities** — one row per (location_id, opportunity_id). Promoted columns: meddic_1..10, client_type, product_system, product_type, postcode, first_contact_method, lead_source_opportunity, inquiry. Plus first_stage_id/name (write-once), current_stage_id/name, status, monetary_value, assigned_to + assigned_to_name, is_deleted, is_ghost, from_backfill.

**stage_history** — one row per stage session. current_stage=true is the open row (single-writer invariant). Columns: stage_id/name, pipeline_id/name, entered_at, left_at, in_stage_duration_seconds, deleted, ghost_opportunity, custom_fields_snapshot, triggered_by ('opportunity_created' | 'opportunity_stage_updated' | 'daily_sweep' | 'backfill'), from_backfill.

**messages** — one row per (location_id, message_id) dedup. message_body (cleaned) + message_body_raw. message_status, message_channel, message_direction, is_call, stage_history_id link. from_backfill.

**Internal tables:** installs (OAuth tokens), pending_opportunities (orphan queue), processed_events (webhook dedup, 14-day TTL).

---

## 5. Backfill script

`src/scripts/backfill.js` — one-shot historical backfill per location.

**Algorithm:**
1. Get active install for `--location <id>` (uses existing OAuth token)
2. Prime pipeline + custom-field caches
3. Paginate `/opportunities/search?location_id=...` (all pipelines, all statuses)
4. For each opp:
   - Enrich opp + contact + assigned-to user name in parallel
   - Fetch activity events via `GET /conversations/{convId}/messages?type=TYPE_ACTIVITY_OPPORTUNITY` (**string type name**, not numeric 29 — that returns 400)
   - Filter activity events to just this opp
   - Build stage sessions timeline (`buildStageSessions`) — mirrors convoVault's algorithm at `convoVault/convo-vault/src/routes/billing.js:1049+`
   - Fetch channel messages in `[firstEntry, lastEdge]` via two-pass export (default + Email)
   - Bucket messages into stage windows
   - Write everything in one `withTenant` transaction: contacts UPSERT → opps UPSERT → stage_history INSERT ON CONFLICT DO NOTHING → messages INSERT ON CONFLICT DO NOTHING
5. Progress log every 10 opps. Single-opp failures don't kill the run.

**Rate limit:** 125ms pacing (~8 req/sec, well under GHL's 100/10s).

**Idempotency guarantees:**
- Contacts/opps: UPSERT with COALESCE (preserve non-null existing values)
- stage_history: ON CONFLICT (location_id, opportunity_id, COALESCE(stage_id,''), entered_at) DO NOTHING via migration 010
- Messages: ON CONFLICT (location_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
- `from_backfill=true` set on INSERT only; ON CONFLICT branch leaves flag untouched (preserves provenance)

**Usage:**
```bash
npm run backfill -- --location <locationId>            # full run
npm run backfill -- --location <id> --limit 5          # first 5 opps only
npm run backfill -- --location <id> --dry-run          # no writes
```

**KNOWN QUIRK:** GHL doesn't have an `/opportunityHistory` endpoint. Stage transitions are reconstructed from **conversation activity messages** — the "Opportunity X moved from A → B" rows GHL synthesises into timelines. This is the same technique convoVault uses.

---

## 6. Analytics views (migration 012)

**`vw_opportunity_flat`** — one row per opportunity, all facts pre-joined. Designed for Claude-via-Supabase; no joins required at query time.

Columns: location_id, opportunity_id, contact_id, opportunity_name, pipeline_id/name, assigned_to, owner_name, business_name (CASE on location_id — all 4 businesses hardcoded), lead_source_opportunity, first_contact_method, utm_source/medium/campaign, gad_source, has_gclid (BOOL), product_system, product_type, client_type, postcode, inquiry, first_stage_name, current_stage_name, status, current_stage_entered_at, days_in_current_stage, total_pipeline_age_days (with COALESCE on created_at_ghl → imported_at fallback), monetary_value, created_at_ghl, updated_at, last_activity_at, first_response_minutes, message_count, inbound_count, outbound_count, has_call.

**Exclusions:** `WHERE is_deleted = false AND is_ghost = false`

**`vw_opportunity_messages_json`** — one row per opportunity, full ordered conversation as JSONB blob:
```json
{message_id, timestamp, direction, channel, body}
```
Kept SEPARATE from the flat view — heavy, only joined when feeding a deal to an LLM.

**Join key between the two views:** `(location_id, opportunity_id)` — same-shape, 1:1.

---

## 7. Locations & backfill status

| Business | location_id | Status |
|---|---|---|
| Crittall | `fJNuIdxGgchGpJ9OoBbk` | Live webhooks + backfill run |
| BGD (Bespoke Glazing Design) | `IFcSg4YvuVlx56msjbdf` | Install status TBC |
| Veritas Glazing Solutions | `kHcvavc8fEeqkEPTK2T8` | Install status TBC |
| Omnia Glazing | `E0nGtwuWd1cmeoc6ilD1` | Install status TBC |

BGD is the **QA sandbox** — hand-validate everything on BGD before rolling to the other three.

---

## 8. Security debt (must rotate before production)

The following secrets have been exposed in past chat transcripts. All need rotation:
- Supabase database password (`EverGreenJunction12345`)
- GHL Marketplace `GHL_CLIENT_SECRET` (`73736310-597b-436b-81c3-f2f9bf287874`)
- Old self-hosted Postgres password (`ecTl-445v-KzRlol2c-BA`)
- GHL access JWTs (Bearer tokens leaked in earlier debugging)
- Full .env contents including `JWT_SECRET`, `GHL_APP_SHARED_SECRET`, `INTERNAL_API_KEY`

Also deferred: RLS hardening (currently using superuser postgres role; should have a non-superuser app role with `USING + WITH CHECK`).

---

## 9. Phase 2 scope — the DELIVERABLES MAP

James shared a full HTML deliverables map. His scope for **Srinivas (you)** across the whole thing is **5 items**:

### 5.1. Contact → Opportunity attribution ⭐ HIGHEST LEVERAGE
- GHL conversations sit at contact level, MEDDIC at opp level; one contact can have multiple opps
- Build the mapping in Supabase + rule for multi-opp case
- Hand-validate on BGD before anything reads it
- **Unlocks 5 downstream deliverables**
- Blockers: none — start today

### 5.2. GHL custom field creation (25 fields)
- 10× `meddic_N_ai` (AI-written)
- 10× `meddic_N_evidence` (verbatim quote + date, paired)
- 1× `ai_extraction_meta` (stamp: when run + channels read)
- 3× `why_want`, `why_buy`, `why_blocker` (rep-entered)
- 1× `contact.gclid`
- Plus 2 Supabase-only: `messages.recording_url`, `messages.transcript`
- Blockers: none — start today

### 5.3. Nightly AI extraction pipeline
- Eduarda writes prompt spec (10 fields + verbatim quote + date + coverage stamp), tests on ~20 BGD deals by hand
- YOU build the nightly job: read conversations → LLM call → GHL write-back → evidence + stamp storage
- Rate-limit aware (21 fields × all open opps × nightly is real load)
- Idempotent (safe to re-run)
- Blockers: attribution done, GHL fields created, Eduarda's prompt spec
- NOT blocked by transcription — launches on written channels first with coverage stamp

### 5.4. Whisper transcription pipeline
- Pull `recording_url` from GHL → Supabase
- Run Whisper with speaker diarisation
- Store to `transcript` field
- Feed same nightly extraction pass
- Start with new calls; backfill later if worth it
- Blockers: none — parallel with attribution

### 5.5. GCLID plumbing + Google Ads offline conversions
- Hidden form field → contact.gclid
- Won deals → Google Ads Offline Conversion Upload API
- Blockers: capture — none. Feedback effect needs Won volume (time).

### The 5 standing rules (architectural constraints)
1. **Overwrite rule** — AI writes only to `*_ai`, `*_evidence`, `ai_extraction_meta`. Never touches rep fields.
2. **No naked facts** — every AI value carries verbatim quote + date, stored at extraction time. Never paraphrased, never regenerated.
3. **Coverage travels with output** — every AI surface states what it read + when. Phone-heavy deals say so.
4. **One nightly pass serves everything** — MEDDIC, coaching, battle cards, diagnostic all read same output.
5. **Carrot before stick** — data helps reps visibly before it's ever cited in performance conversations.

### Not your work
- Baselines, prompt spec, monthly review queries → **Eduarda**
- Director standing rules, monthly review HTML, walked session bookings → **James**

---

## 10. Recommended Phase 2 quote

**$5,000 fixed, 3 milestones, ~4 weeks:**

**M1 ($1,500 upfront):**
- Contact→opp attribution (Supabase logic, hand-validated on BGD)
- GHL field creation (25 fields)
- Supabase schema for AI mirror columns + transcript storage
- Whisper transcription pipeline

**M2 ($2,000 on delivery):**
- Nightly AI extraction pipeline (LLM + GHL write-back + evidence + stamp + rate-limit-aware + idempotent)
- Extended `vw_opportunity_flat` + new views (e.g. deal-death diagnostic)
- Hand-validated on 20+ BGD deals with Eduarda

**M3 ($1,500 on delivery):**
- GCLID capture (hidden form field)
- Google Ads offline conversion upload
- Docs + handover

**Passthrough (his bill, not ours):**
- LLM tokens: ~$50–150/month
- Whisper: ~$0.006/min audio (OpenAI) or self-hosted
- Google Ads API: free

**Monthly support:** $55/mo → **$175/mo** once phase 2 live.

**Do NOT quote hourly.** Do NOT quote below $3k. Do NOT anchor to local (India) rates.

---

## 11. Open user-facing questions (parked)

- Tags on contact + opportunity records not currently persisted → GHL sends `tags[]` in existing webhook payload, could add as column + persist without new webhook subscriptions. Small change, ~2 hours.
- Tasks + Notes not synced at all → requires new webhook subscriptions + new tables. Proper add-on scope, ~1 day.
- Reply drafted, waiting for James to greenlight scope.

---

## 12. Conventions & preferences

- **Emails to James:** sign as "Vaultsuite Team" (never personal name)
- **UI polish:** premium/polished, not just functional (client-facing)
- **Todos:** use TodoWrite proactively for multi-step work
- **Commits/PRs:** never unless explicitly asked. Never push without asking.
- **No comments** unless the WHY is non-obvious. Never explain WHAT the code does.
- **No premature abstraction.** Three similar lines beats a bad shared helper.
- **Trust internal code.** Only validate at system boundaries (webhooks, user input, external APIs).
- **Use `withTenant(locationId, fn)`** for every per-tenant write — bypassing it risks cross-tenant leaks
- **Use `rawQuery(sql, params)`** ONLY for internal tables (installs, processed_events, pending_opportunities)
- **Use skill `code-review` before merging significant changes**

---

## 13. Testing quick reference

```bash
# Health check
curl -i https://app.pipelineegj.com/health

# Postgres direct query
psql "$(grep ^DATABASE_URL /root/pipelinePluse/server/.env | cut -d= -f2- | tr -d '\"')"

# Table row counts
SELECT 'installs' t, COUNT(*) FROM installs UNION ALL
SELECT 'contacts', COUNT(*) FROM contacts UNION ALL
SELECT 'opportunities', COUNT(*) FROM opportunities UNION ALL
SELECT 'stage_history', COUNT(*) FROM stage_history UNION ALL
SELECT 'messages', COUNT(*) FROM messages;

# from_backfill audit
SELECT 'opportunities' t,
       COUNT(*) FILTER (WHERE from_backfill) AS from_backfill,
       COUNT(*) AS total
FROM opportunities;

# Sample flat view
SELECT * FROM vw_opportunity_flat LIMIT 5;

# Full deal + conversation
SELECT f.*, j.messages_json
FROM vw_opportunity_flat f
LEFT JOIN vw_opportunity_messages_json j
  USING (location_id, opportunity_id)
WHERE f.opportunity_id = '<id>';

# PM2 status + logs
pm2 status
pm2 logs app --lines 50 --nostream
```

---

## 14. Related codebase — convoVault (for reference)

The stage-history walking algorithm in `backfill.js` **mirrors** convoVault's implementation at:
- `convoVault/convo-vault/src/routes/billing.js:617` — `extractStageEvent()`
- `convoVault/convo-vault/src/routes/billing.js:1049+` — the timeline walker

If GHL changes activity-event shape, patch BOTH. Neither is a shared package — deliberate duplication.

---

## 15. What's next (as of this session)

1. **Deploy migration 012 to Supabase Cloud** (`npm run migrate`)
2. **Run backfill for BGD, Veritas, Omnia** once James confirms all 4 sub-accounts have the app installed
3. **Reply to James on Phase 2 pricing** — send the $5k / 3-milestone quote
4. **Reply on tags/tasks/notes question** — offer tags as goodwill, price tasks + notes as small add-on (~1 day, ~$500)
5. **Rotate leaked secrets before production traffic ramps**


ssh root@91.99.2.110