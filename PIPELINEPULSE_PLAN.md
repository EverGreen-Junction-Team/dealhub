# PipelinePulse — Stage Velocity & Stalled Deal Alerts for GoHighLevel

**Project:** A public GHL Marketplace app that gives agencies visibility into pipeline movement and automatically flags stalled opportunities.

---

## 1. What we're building

GHL's native pipeline view shows you *where* every opportunity is, but never *how long* it's been sitting there or *how fast* it's moving compared to history. PipelinePulse fills that gap. It silently tracks every stage change in the background, computes per-stage velocity metrics, and pings the team when a deal stalls past a configurable threshold.

It is the productized, multi-tenant version of the stage-history pipeline we built for the convoVault client — but distributed as a public Marketplace app with self-serve onboarding, monthly SaaS billing, and an embedded dashboard inside GHL.

---

## 2. Problem we're solving

| Pain (today, without PipelinePulse) | What agencies do instead |
|---|---|
| No way to see how long an opportunity has been in its current stage | Manually check each deal, or write Zaps that break |
| No conversion rate between stages | Export CSV → pivot in Excel monthly |
| No alerting when a deal goes cold | Hope the salesperson notices |
| No "deals stuck > 14 days" view | Build a custom Smart List that doesn't actually capture this |
| Pipeline reports lost when re-importing snapshots | Just accept the data loss |

GHL has no roadmap commitment to solve any of this natively. The ideas board has 100+ upvoted requests for pipeline analytics that go back years.

---

## 3. Target customer

**Primary:** GHL agencies running 5–50 sub-accounts, where each sub-account has an active sales pipeline and the agency itself owns the workflow / training side. They feel the pain across multiple clients and will pay per sub-account.

**Secondary:** Single-tenant SMB GHL users (real estate brokerages, dental practices, home services) with one busy pipeline who want a "stalled deal alert" workflow without building it themselves.

**Not the target:** Solo users with <20 opportunities total — the pain is too small.

---

## 4. Core features (V1)

### 4.1 Stage History Tracking (the engine)

- Subscribe to GHL webhooks on install: `opportunity_stage_updated`, `opportunity_created`, `opportunity_deleted`
- **Forward-only tracking** — we capture everything that happens **after** the moment of install. No historical replay, no backfill of past opportunities. Day 1 dashboards will look sparse; they fill up as the pipeline moves.
- For every event, record a row in `stage_history` (one row per stage occupancy)
- Daily sweep for orphan opportunities (created but never moved since install)
- Idempotent — safe to replay webhooks without dupes

### 4.2 Dashboard (embedded in GHL via custom menu link)

- **Pipeline overview**: opportunities per stage, with avg time-in-stage shown beside the count
- **Stage funnel**: conversion rate between consecutive stages (entered Stage N → reached Stage N+1)
- **Stalled list**: every opportunity currently sitting > threshold in its stage, sortable by time-stuck, with one-click "open in GHL" links
- **Lost reason breakdown**: when opportunities are marked lost, group by lost-reason and show frequency
- **Per-rep view**: filter all the above by assigned user

### 4.3 Alerts

- **Stalled deal alerts**: configurable threshold per stage (e.g. "alert if anything sits in Negotiation > 7 days"). Delivery channels: Slack, email, SMS (via the sub-account's own GHL SMS quota — no separate Twilio billing).
- **Daily digest** (optional): single morning email listing every stalled deal that crossed threshold yesterday
- **Weekly pipeline health email** to the agency owner: top 5 stalled deals, week-over-week conversion delta, deals lost this week

### 4.4 Settings

- Set stalled-deal threshold per stage (in days)
- Choose alert recipients per stage
- Enable/disable individual alert types
- "Pause alerts" toggle (for holidays)

---

## 5. Architecture

### High-level flow

Tracking is **anchored at the moment of install (T₀)**. Nothing before T₀ is captured.

```
                            ┌──────────────────────────────────────────┐
                            │  T₀ — INSTALL                            │
                            │  Agency installs PipelinePulse on a      │
                            │  GHL sub-account via the Marketplace.    │
                            │                                          │
                            │  On install we:                          │
                            │    • complete OAuth, store access token  │
                            │    • subscribe to 3 webhooks             │
                            │    • record install timestamp = T₀       │
                            │    • DO NOT replay any history           │
                            └──────────────────┬───────────────────────┘
                                               │
                                               ▼
            ════════════════════════ T > T₀ (forward-only) ════════════════════════

  ┌──────────────────────┐                              ┌────────────────────────┐
  │  GHL sub-account     │   webhook (HTTPS, signed)    │  PipelinePulse API     │
  │                      │ ───────────────────────────► │  (webhook receiver)    │
  │  fires events:       │                              │                        │
  │   • opportunity_     │                              │   • verify signature   │
  │     created          │                              │   • enqueue for write  │
  │   • opportunity_     │                              └────────────┬───────────┘
  │     stage_updated    │                                           │
  │   • opportunity_     │                                           ▼
  │     deleted          │                              ┌────────────────────────┐
  └──────────────────────┘                              │  Stage-history writer  │
            ▲                                           │  (worker)              │
            │                                           │                        │
            │ daily sweep                               │  translate event →     │
            │ (cron, every 24h)                         │  one stage_history row │
            │                                           └────────────┬───────────┘
            │                                                        │ INSERT
            │                                                        ▼
            │                                           ┌────────────────────────┐
            └───────────────────────────────────────────┤  MongoDB (Atlas)       │
                                                        │  (multi-tenant via     │
                                                        │   locationId + query   │
                                                        │   middleware)          │
                                                        └─────┬──────────┬───────┘
                                                              │          │
                                            ┌─────────────────┘          └────────────────┐
                                            ▼                                             ▼
                            ┌──────────────────────────────┐              ┌──────────────────────────┐
                            │  Alert engine                │              │  Dashboard API           │
                            │  (cron, every 15 min)        │              │                          │
                            │                              │              │  serves JSON to the      │
                            │  scan for opportunities      │              │  embedded UI             │
                            │  exceeding stage threshold;  │              └────────────┬─────────────┘
                            │  dedupe; dispatch alerts     │                           │
                            └──────────────┬───────────────┘                           ▼
                                           │                              ┌──────────────────────────┐
                            ┌──────────────┼──────────────┐               │  Embedded UI             │
                            ▼              ▼              ▼               │  (React, loaded inside   │
                         Slack          Email           SMS               │   the GHL menu)          │
                                                       (via sub-          │                          │
                                                        account's         │  • pipeline overview     │
                                                        own GHL           │  • stage funnel          │
                                                        quota)            │  • stalled list          │
                                                                          │  • settings              │
                                                                          └──────────────────────────┘
```

**Why forward-only:**
- Simpler architecture — no separate backfill worker, no rate-limit careful walk of historical APIs, no "what about deleted opportunities from 6 months ago" edge cases
- Cleaner promise to customers — "PipelinePulse starts measuring from the day you install"
- Day 1 dashboards will be near-empty by design; they fill up over the following days/weeks as opportunities move. We'll communicate this clearly in the onboarding wizard.

### Components

| Component | Tech | Responsibility |
|---|---|---|
| **Marketplace app shell** | GHL public app (OAuth) | Install flow per sub-account, scope grants, webhook subscription on install |
| **Webhook receiver** | Node.js (Express / Fastify) | Validates GHL signature, enqueues for processing |
| **Stage-history writer** | Node.js worker | Translates webhook event → stage_history document, runs data cleaning, writes to MongoDB |
| **Daily sweep job** | Cron — a scheduled job that runs automatically every 24h | Finds orphan opportunities (created but never moved since install) and emits "still-pending" history rows |
| **Alert engine** | Cron — runs automatically every 15 minutes (no human trigger needed) | Scans stage_history for opportunities exceeding threshold; deduplicates already-sent alerts; dispatches via Slack / email / GHL SMS |
| **Dashboard API** | Node.js REST | Runs aggregation pipelines against MongoDB; serves JSON to the embedded UI |
| **Embedded UI** | React (loaded via GHL custom menu link) | Renders charts (Recharts), stalled list, settings page |
| **Database** | MongoDB (Atlas managed cluster) | Multi-tenant via `locationId` field on every document + app-layer query middleware that injects the filter automatically |
| **Auth** | GHL OAuth + JWT for embedded UI sessions | Same `locationId` flows through every layer |
| **Billing** | Stripe (subscription) + GHL webhook listener for uninstall | Cancel on uninstall, prorate on upgrade |
| **Hosting** | AWS (eu-west-2) or fly.io | Multi-region option for UK customers later |

### Multi-tenancy

- Every MongoDB document has a `locationId` field
- A Mongoose middleware automatically injects `{ locationId: req.locationId }` into every query — no place in the code can forget the tenant filter
- Embedded UI requests carry a JWT signed at OAuth-callback time, containing the location ID — backend pulls it off the JWT and pins it to the request before any query runs
- This is the exact same multi-tenant pattern convoVault uses today (battle-tested)

### Reused from convoVault

- Stage history walker logic (opportunities walk, ghost-opp synthesis, message bucketing)
- GHL API client with retry/rate-limit handling
- Custom-field resolution pattern
- Data cleaning helpers (email body strip, emoji strip)
- **MongoDB + Mongoose setup, multi-tenant `locationId` middleware, and connection pooling** — drop-in reuse

### Net-new vs. convoVault

- OAuth install flow (convoVault is a private app — no OAuth)
- Marketplace listing + screenshots + onboarding wizard
- Embedded UI inside GHL (convoVault has a standalone admin UI)
- Recurring SaaS billing via Stripe (convoVault uses GHL's custom-charge meter)
- Multi-tenant from day one (convoVault is single-tenant per install)

---

## 6. Pricing

| Tier | Monthly | What's included |
|---|---|---|
| **Free** | $0 | 1 pipeline, up to 100 active opportunities, dashboard only (no alerts), 30-day history |
| **Pro** | $29 / sub-account | Unlimited pipelines, unlimited opportunities, all alert channels, weekly email, 1-year history |
| **Agency** | $79 / sub-account | Everything in Pro + white-label branding, multi-account aggregate view, priority support |

**Free tier intent:** Marketplace listings convert best when there's a no-friction trial. Free tier becomes the lead magnet; the Stalled list intentionally lacks alerting so paying customers actually act on the data.

**Billing logic:** Stripe subscription per sub-account. On uninstall, GHL webhook cancels Stripe. Upgrades pro-rate automatically.

---

## 7. Phases & Timeline

### Phase 1 — Marketplace app shell (1 week)
- GHL Marketplace app registration
- OAuth install flow + scope grant
- Webhook subscription on install
- Bare-minimum embedded page (placeholder)
- Stripe Connect / subscription scaffolding

### Phase 2 — Stage history engine + MVP dashboard (2 weeks)
- Webhook receiver + stage_history writer (reuses convoVault walker logic, minus the historical reconstruction)
- Daily orphan sweep
- Dashboard: opportunities-per-stage table with avg time-in-stage
- Stalled list view (read-only — no alerts yet)

### Phase 3 — Alerts engine (1 week)
- Alert engine cron + dedup
- Slack integration
- Email alerts via SendGrid / Brevo
- GHL SMS alert (via sub-account's own SMS quota)
- Settings page: per-stage thresholds + recipient config

### Phase 4 — Polish + launch (1 week)
- Weekly pipeline health email
- Onboarding wizard (first-time install experience)
- Marketplace listing copy + screenshots
- Pricing page + Stripe checkout flow
- Beta launch with 5 friendly agencies

**Total: ~5 weeks to public listing.**

---

## 8. Out of scope (V1)

- Forecasting / AI deal-scoring (Phase 5+)
- Custom report builder (use the dashboard, then export CSV)
- Mobile push notifications (Slack/SMS/email cover the use case)
- Cross-CRM support (HubSpot, Salesforce, Pipedrive)
- Public REST API for customers (V2)
- **Historical backfill of any kind** — we only track opportunities and stage moves that happen *after* the moment of install. Anything in the pipeline before install is invisible to PipelinePulse until it next moves.
- White-label custom-domain (Agency tier only)
- **Heavy regulatory compliance** (UK / EU data residency, SOC 2, HIPAA, ISO 27001). This is a general-market SaaS — not a regulated-client build like convoVault. The only compliance we ship at V1 is what the GHL Marketplace listing itself requires: a privacy policy, basic terms of service, and a "delete-on-uninstall" hook that wipes the sub-account's data when the app is removed.

---

## 9. Open questions / decisions needed

1. **Brand / domain**: `pipelinepulse.app`? `pipelinepulse.io`? `getpipelinepulse.com`? Need to check availability.
2. **Hosting region**: AWS us-east-1 (broader customer base — no data residency requirements at V1 since this is a general-market SaaS, not a regulated-client build).
3. **Database**: MongoDB Atlas (managed cluster). Same database engine and ODM as convoVault — maximum code reuse and team familiarity. No Postgres/Supabase needed.
4. **Embedded UI loader**: GHL's "custom menu link" iframes the URL; do we need a CSP / X-Frame-Options exception? Confirm against the marketplace SDK.
5. **Free-tier abuse**: how do we prevent agencies installing the free tier on 50 sub-accounts? Probably enforce "max 1 free install per agency-level account."
6. **GHL Marketplace approval**: review time is reportedly 2–4 weeks. Submit the listing during Phase 3 so approval lands by Phase 4 polish.
7. **Reuse vs. fork**: do we copy the convoVault stage-history walker as a starting commit, or extract it into a shared npm package? Cleaner long-term to share, but fork is faster for V1.

---

## 10. Success metrics (first 90 days post-launch)

- 50 free installs
- 10 paid conversions (Pro or Agency)
- $400+ MRR by day 90
- Less than 5% uninstall rate among paid customers
- At least 3 inbound referrals (someone telling a friend agency about us)

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| GHL changes the webhook contract | Same risk we already carry for convoVault — already wrote the walker defensively (numeric type fallbacks, schema-tolerant parsing) |
| Marketplace approval rejected | Submit early, iterate on feedback; have a "self-hosted" fallback distribution for early customers |
| A competitor ships first | None exist today on the GHL Marketplace per current research. Window is open. |
| GHL builds it natively | Even if they do, they'll ship the bottom 20% — alerts/customization will lag. Productized alerting is the moat. |
| Webhook reliability (GHL drops events) | Daily reconciliation sweep — re-walks the API to catch missed events |

---

## 12. Decision needed before code starts

1. **Approve repo name** `pipelinePulse` (current folder name) — or rename?
2. **Approve scope of V1** — anything in Section 4 that should drop, or anything in Section 8 that should move into V1?
3. **Approve the 5-week timeline** vs. compressing/extending
4. **Confirm pricing tiers** — happy with $0 / $29 / $79, or different anchor points?
5. **Confirm primary go-to-market channel** — Marketplace listing alone, or also outbound to known GHL agency communities (Facebook groups, Discord)?
