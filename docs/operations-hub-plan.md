# Operations Hub — build plan (hybrid model)

Source: the 24 TBCG screens in `Operations-Hub-TBCG-all-screens/` (s1–s24).
Decision (26 Nov 2026): **hybrid**. A project or remedial's *stage* lives in
GHL; everything GHL has no home for lives in Deal Hub.

## 1. Where each thing lives

| Thing | Lives in | Why |
|---|---|---|
| Project / remedial **stage** | GHL opportunity in an **Operations** or **Remedials** pipeline | Visible in GHL, moves by our existing opportunity webhooks, stage history already recorded |
| Job number, fitter, install dates, company, owners (showroom / ordering / admin) | Deal Hub `projects` table | Typed, queryable, no GHL custom-field sprawl |
| Remedial type / reason / category, parent project | Deal Hub `remedials` table | Same |
| Task ↔ project / remedial link | Deal Hub `ops_task_links` | GHL refuses task relations over OAuth ("Relations cannot be modified via OAuth channel") |
| Stage checklist steps | Deal Hub `ops_steps` (template per stage, instance per job) | GHL has no checklist |
| Order lines & deliveries | Deal Hub `ops_order_lines` | GHL has no equivalent |
| Time entries | Deal Hub `ops_time_entries` | GHL has no equivalent |
| Costs (remedials), payments (projects) | Deal Hub now; Xero later | Xero integration is a later slice |
| Visits (install, tiling, electrics, remedial visit) | GHL appointments, linked to the job in Deal Hub | Reuses the calendar and its deal link |
| Messages, calls, notes, files | Existing timeline, filtered to the job's contact + deal | Already synced |

**Creating the two pipelines.** GHL's v3 API has
`POST /opportunities/pipelines` (send `Version: v3`; scope `pipelines.create`;
pipeline names unique per location, stage names unique within a pipeline,
stages only through the `stages` array). So the app *can* create them, once
`pipelines.create` is added to the app's scopes in draft mode and the
sub-account reauthorises. Creating a pipeline changes the CRM's settings, so it
runs only on an explicit go-ahead — or they can be made by hand in GHL
Settings → Opportunities → Pipelines. Either way the app then maps them in the
Control panel.

Required stage names (the app matches by name, so they must be exact):

- **Operations:** Deposit · Ordering · Fitter's drawing · Deliveries & check ·
  Installation · Snagging · Balance & completion · Aftercare · Job analysis
- **Remedials:** Reported · Parts to order · Parts ordered · Ready to book ·
  Visit booked · Fixed and closed

## 2. How a sold deal becomes a project

**Open — asking the client (Q1 below).** Recommended: a **Start project**
action on a won deal creates a *new* opportunity in the Operations pipeline
(same contact, linked back to the sales deal in Deal Hub), so the sales deal
stays Won and sales reporting is untouched. Manual first; automatic-on-won can
follow once the flow is trusted.

**Log remedial** creates an opportunity in the Remedials pipeline, linked to
its original project. Reference: `R-<job no.>-<nn>`.

## 3. Slices

**Slice 1 — the spine** (this is the first build)
- Migration: `projects`, `remedials`, `ops_task_links`, `ops_steps`,
  `ops_time_entries` (all `location_id`-scoped with RLS like the rest).
- Control panel: map the two GHL pipelines; check stage names match.
- Start project / Log remedial.
- Screens: Home OPERATIONS section (s1), the operations top menu,
  Projects list (s5), Pipeline board for both (s3, s4), Project overview
  (s6) and Remedial overview (s15) with header, facts, stage bar and tabs,
  Tasks tab and the cross-job Tasks page (s7, s16, s24), Add time (s13, s22).
- Stage moves when all steps are ticked (writes the GHL stage).

### Slice 1 in detail

**The rule that keeps it independent of Q1:** an opportunity *in the mapped
Operations pipeline* **is** a project, and one in the mapped Remedials
pipeline **is** a remedial — however it got there (moved by hand in GHL,
created by a future "Start project", imported). Deal Hub keeps its own row
beside it (`projects` / `remedials`), created the first time anyone opens or
edits the job. So everything below works before Q1 is answered; Q1 only
decides how opportunities *arrive* in that pipeline.

**Migration 146 — `146_operations.sql`** (every table `location_id`-scoped,
`ENABLE ROW LEVEL SECURITY` + the usual `tenant_iso` policy):

| Table | Key | Holds |
|---|---|---|
| `ops_settings` | `location_id` | Which GHL pipeline is Operations and which is Remedials (a Deal Hub setting — no GHL change) |
| `projects` | `(location_id, opportunity_id)` → opportunities | job number, sales deal it came from, company (business), showroom / ordering / admin people, fitter, install start/end |
| `remedials` | `(location_id, opportunity_id)` → opportunities | reference, parent project, type, reason, category, fitter, how reported, taken by |
| `ops_task_links` | `(location_id, task_id)` | which job a GHL task belongs to, and at which stage (no FK to `tasks`: the row is written before GHL's TaskCreate webhook lands) |
| `ops_steps` | `id` | the "to do in this stage" checklist per job and stage: title, who, due, done |
| `ops_time_entries` | `id` | who, date, hours (0 < h ≤ 24), activity, notes; soft delete |

**Decision seams — one file each side, nothing else reads the answers:**
`server/src/services/opsDecisions.js` and
`dashboard/src/pages/operations/opsDecisions.js`.

| Question | Seam value now | What it does today | What changes when answered |
|---|---|---|---|
| Q1 start a project | `START_PROJECT = null` | `POST /api/ops/projects/start` answers 409 "waiting on the client's decision"; no button is shown | set `'new_linked'` or `'move_same'`; the route's two branches are stubbed in the seam |
| Q2 job numbers | `JOB_NUMBER_SOURCE = null`, `REMEDIAL_REF_FORMAT = null` | job number / ref are typed by hand (shown as "No job no." until then); the list falls back to the deal name | set `'dealhub'` (issue next per company) or a GHL field key; remedial refs then fill in |
| Q4 task links | `TASK_LINK_STORE = 'dealhub'` (the only one built) | tasks are GHL CRM tasks on the job's contact; the job link and stage live in `ops_task_links` | `'ghl_projects'` would swap in a second store behind the same 4 functions (`create`, `link`, `unlink`, `listForJob`) |

**Routes — `/api/ops`:** `GET/PUT /settings` (pipeline mapping + a
stage-name check against §1), `GET /decisions`, `GET /projects` (the board
groups this list by stage), `GET/PATCH /projects/:id`,
`GET /remedials`, `GET/PATCH /remedials/:id`, `POST /remedials` (Log
remedial: creates the opportunity in the Remedials pipeline at "Reported"),
steps (`POST /:kind/:id/steps`, `PATCH/DELETE /steps/:stepId`), time
(`GET/POST /:kind/:id/time`, `PATCH/DELETE /time/:entryId`), tasks
(`GET /tasks`, `POST /:kind/:id/tasks`, `PUT /tasks/:taskId/job`).
Ticking the last open step of a stage moves the GHL opportunity to the next
stage (an app write, like moving a deal on the board).

**Screens** (behind `VITE_FEATURE_OPERATIONS=true`, like the Calendar):
Home OPERATIONS section (s1); an "Operations hub" pill that switches the top
menu to Pipeline · Projects · Remedials · Tasks and "Deal hub" to switch back;
Pipeline board for projects and remedials (s3, s4); Projects list (s5) and
Remedials list (s14); job pages with header, facts, stage arrows and the
Overview / Tasks / Add time tabs (s6, s7, s13, s15, s16, s22); Tasks across
jobs (s24); a Set-up view to map the two pipelines. The other tabs on the job
page (Orders, Schedule, Money, Files, Activity) belong to later slices and are
not shown yet.

### Slice 1 — status (26 Nov 2026)

**Built, tested and pushed.** Server: `14770c6`. Dashboard: the commit after
it. Migration **146** must be run on the server.

- **Turn it on:** set `VITE_FEATURE_OPERATIONS=true` in Vercel and redeploy;
  without it nothing operations-related shows. Then **Operations hub → Set
  up** maps the two pipelines (a Deal Hub setting; nothing changes in GHL).
- **Tested:** 16 unit tests (`server/src/services/__tests__/operations.test.mjs`),
  8 wiring tests (`dashboard/src/pages/operations/__tests__/operations.test.mjs`),
  a 26-check end-to-end run of every route on Postgres 17 with GHL mocked,
  and every screen rendered with fixture data in a browser.
- **Not tested live:** the two GHL pipelines do not exist yet, so nothing has
  run against real GHL data.

**Waiting on the client — and exactly where each answer goes:**

| Question | Today | When answered, change |
|---|---|---|
| Q1 start a project | No "Start project" button; `POST /api/ops/projects/start` answers 409 `decision_pending`. A deal moved or created in the Operations pipeline in GHL becomes a project automatically. | `START_PROJECT` in `server/src/services/opsDecisions.js`, then fill the branch in `routes/operations.js` → `POST /projects/start`, then add the button. |
| Q2 job numbers / refs | Typed on each job (Edit); unique per location. Lists fall back to the deal name. | `JOB_NUMBER_SOURCE` (+ `issueJobNumber()` for `'dealhub'`) and `REMEDIAL_REF_FORMAT` in `opsDecisions.js`. A GHL field key makes the number read-only and read from that field. |
| Q3 pipelines | Nobody has created them. Set up lists the exact stage names and checks them. | Either add them in GHL Settings, or approve the app creating them (needs the `pipelines.create` scope + reauth; not built, and never done without an explicit yes). |
| Q4 task links | Deal Hub store: tasks are GHL CRM tasks on the customer; job + stage in `ops_task_links`. | `TASK_LINK_STORE` in `opsDecisions.js`; a GHL Projects store would implement the same four functions in `services/opsTaskStore.js`. |
| Q5–Q8 | Not needed by slice 1. | Slices 3–4 (TrueBlue, Xero/payments, money roles) and Q8 (one location or two) before anything company-specific. |

**Slice 2 — scheduling**
- Schedule tabs (s9, s18) from linked appointments + key dates.
- Install schedule (s23) on the existing People board: bars by job colour,
  "Not linked to a job", Not ready / Still to book side panels.
- Order-by / in-warehouse dates derived from install (−4 / −2 weeks);
  "Move install date" shifts them and drafts the client email.

**Slice 3 — orders & deliveries** (s8, s17): order lines, chase, checked-in,
"N items not in" flags, KPIs. Manual entry first; TrueBlue import if it has
an API (to confirm).

**Slice 4 — money & cost** (s10, s19): Xero read/push, payment link
(GoCardless or Stripe), true margin. Role-gated to finance/directors.

**Slice 5 — the rest**: Files & notes tabs (s11, s20), Activity tabs (s12,
s21) on the existing timeline, Operations overview (s2), postcode grouping
and "nearby" hints, fitter's drawing from the quote, Ask about any job.

## 4. Questions for the client (product)

1. **How does a won deal become a project?**
   - (a) *Recommended:* a "Start project" button creates a **new linked
     opportunity** in the Operations pipeline; the sales deal stays Won and
     sales reports don't change.
   - (b) The **same deal moves** into the Operations pipeline. Simpler, but it
     leaves the sales pipeline and stops counting as Won there.
   - Should it happen automatically when a deal is marked Won, or only when
     someone presses the button?
2. **Where do job numbers (TBCG-20049) come from?**
   - (a) *Recommended:* Deal Hub issues the next number per company, editable
     so a TrueBlue or quote number can be typed over it.
   - (b) They already exist somewhere (a GHL field, TrueBlue, a spreadsheet) —
     which, and in what format? Do the two companies share one sequence?
   - Remedial reference format: is `R-<job no.>-<nn>` right?
3. **The two GHL pipelines.** Are the stage names in §1 exactly right? Should
   the app create them (needs the `pipelines.create` permission) or will
   someone add them in GHL Settings?
4. **Tasks on a job.** GHL won't let an app link a CRM task to a deal. Options:
   - (a) *Recommended:* the link is kept in Deal Hub; tasks still live in GHL
     and show in GHL's task list, just without the job link there.
   - (b) Use **GHL Projects** (its project-management feature: spaces →
     folders → lists, tasks, comments, statuses — `/projects/*`, scopes
     `projects/workspace.*`, `projects/tasks.*`). Tasks there *can* be written
     by the app, but they are separate from CRM tasks and contacts. Does the
     team use GHL Projects today?
5. **TrueBlue** — is there an API, or an export (CSV/PDF) we can import?
6. **Xero and payments** — which payment link provider (GoCardless or
   Stripe)? Is Xero already connected to anything?
7. **Who sees money** — which GHL roles count as "finance and directors"?
8. **Two companies** (TBCG and The Tile & Bathroom Company) — one Deal Hub
   location or two? The screens show both in one list with a Company column.
