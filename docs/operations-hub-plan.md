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
