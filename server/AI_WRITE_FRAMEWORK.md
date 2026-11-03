# Co-Pilot AI Write Framework

Context for whoever picks this up next. Covers what was built, why it's shaped this way, what's confirmed vs. still needs a live check, and where to extend it.

## The problem this solves

Before this, Co-Pilot (both the portfolio-wide tab and Deal Hub's per-deal chat) was **entirely read-only** — a hard rule enforced by a test (`toolRegistry.test.mjs`'s old "every tool is read-only" check, which scanned every tool's source for `INSERT/UPDATE/DELETE`). The only thing resembling an "AI write" was the model's answer text seeding a normal `NoteEditor`/`TaskEditor` draft that a rep had to open and save themselves — the model never touched a write function.

The ask: let a rep say things like *"create a contact for Jane Doe, jane@x.com"*, *"attach this contact to the deal"*, *"change the owner to Priya"*, *"mark this lost, budget fell through"*, or *"send an email to this contact with subject X and this content"* — and have Co-Pilot actually do it, safely.

## The non-negotiable rule

**The model never calls a real GHL write function. Ever.** It can only ever *propose* one — insert a row into `ai_actions` describing what it wants to do. A rep reviews that proposal (rendered as an editable `ActionCard` in the chat), can edit any field, and clicks **Confirm**. Only that click reaches GHL.

This mirrors — and is enforced the same way as — every other write in this app already worked (`ghlContactWrite.js`'s own header: *"Writes stay on the routes a rep drives, where there is a UI, a confirmation and an audit trail"*). Nothing new was invented for AI writes; the framework just gives the model a way to *arrive at* the same confirm button a rep would click by hand.

Two tests exist specifically to keep this true forever, not just today:
- `every LOOKUP tool is read-only` — unchanged from before, scoped to lookup tools.
- `every PROPOSE tool only ever calls proposeAction — never a GHL write function` — a source-scan that fails the build if a propose tool ever calls `createGhlContact`/`updateGhlOpportunity`/`addDealContact`/`sendGhlMessage`/`ghlRequest` directly. If you add a new propose tool, this test will catch it if you accidentally wire it straight to GHL instead of through `proposeAction`.

## Architecture

```
Rep asks a question
        │
        ▼
Model calls a propose_* tool  ──────────────►  INSERT into ai_actions (status='pending')
        │                                              nothing reaches GHL yet
        ▼
Answer renders with an ActionCard
   (Confirm / Cancel, fields editable)
        │
        ▼
Rep clicks Confirm  ──────►  POST /api/ai/actions/:id/confirm
        │
        ▼
actionExecutor.confirmAction()
   - re-checks status='pending' (a double-click is a no-op, not a second write)
   - merges any rep edits over the model's proposed_payload
   - dispatches to the SAME write function a human-driven route would call:
       createGhlContact / addDealContact / updateGhlOpportunity /
       setGhlOpportunityStatus / sendGhlMessage
        │
        ▼
GHL API call  ──────►  webhook mirrors the result back into Postgres
   (same "GHL is not us" pattern every other write in this app follows —
    see ghlContactWrite.js's header for the full rationale)
```

### Two different AI architectures, one framework

The portfolio Co-Pilot (`askPortfolio.js`) and Deal Hub's Co-Pilot (`askDeal.js`) are built completely differently, and this framework respects that rather than forcing them onto one shape:

- **Portfolio tab** already runs an agentic tool-calling loop (`runToolLoop` / `toolLoop.js`). Propose tools are just more entries in that same loop's tool catalogue (`PROPOSE_TOOLS` in `registry.js`) — no new plumbing needed there beyond collecting `proposedActions` off the loop's result.

- **Deal Hub** is a single, schema-validated, *cached* call whose entire job is producing a citation-verified answer (`askDeal.js`'s own header: *"Read-only, so this is the first call shipped: no write path, no proposals to confirm"* — that was written before this framework existed, and is now only half true). Migrating it onto the tool-loop architecture was explicitly rejected as too large a change to the citation-verification pipeline. Instead, `dealActionDetector.js` is a **separate, small second call** that runs after the main answer, using the same `PROPOSE_TOOLS` plus a `search_contacts` lookup (needed to resolve "attach John Smith" to a real contact id, since Deal Hub's own context only knows the deal's *existing* contacts). A failure in this second call never breaks the citation-verified answer that already succeeded — it's wrapped in its own try/catch and just returns "nothing detected."

## The five actions

| Action type | Tool | Real write function | New GHL scope needed? |
|---|---|---|---|
| `create_contact` | `propose_create_contact` | `createGhlContact` (new — no create path existed before this) | No |
| `attach_contact` | `propose_attach_contact` | `addDealContact` (pre-existing) | No |
| `change_owner` | `propose_change_owner` | `updateGhlOpportunity` (pre-existing) | No |
| `change_status` | `propose_change_status` | `setGhlOpportunityStatus` (pre-existing) | No |
| `send_message` | `propose_send_message` | `sendGhlMessage` (new — first outbound-communication write in this app) | **Yes — `conversations/message.write`** |

Each propose tool validates its own required fields and, if something's missing, returns `{ needsInfo: [...] }` instead of inserting anything. The model reads that as "ask the rep for these fields" and the conversation continues naturally — this is the entire mechanism behind "ask for missing details conversationally." There is no separate orchestration layer for it; the tool's own validation IS the prompt for a follow-up turn.

### `send_message` is a different kind of risk

Every other action changes **internal CRM state** — a field, an association, an owner. `send_message` puts something in front of a **real customer** (an SMS or email). Deliberately handled with the *same* safeguard as everything else (propose → editable card → explicit confirm), not an extra gate — the reasoning: a rep already reviews and can edit the full subject/body/recipient before confirming, and adding more friction here would contradict the framework's own premise that "a human already looked at this before it happened" is sufficient. If that judgment call needs revisiting, this is the place to do it — see `ghlMessageWrite.js`'s header comment.

**Requires a new OAuth scope this app didn't request before: `conversations/message.write`.** Every already-installed sub-account needs to re-authorize (a GHL-side prompt, not silent) before `send_message` works for them — every other feature keeps working regardless. `sendGhlMessage` passes `scopeOptional: true` to `ghlRequest`, so a location without the scope yet gets a clean "reauthorise the app" error on *this* call only, rather than the whole install being flagged `reauth_required` and halting unrelated syncs (see `ghlClient.js`'s own comment on exactly this failure mode from an earlier incident).

**Not independently verified end-to-end.** The contact-create contract (`locationId` is GHL's only required field on `POST /contacts/`) was confirmed against GHL's own checked-in OpenAPI spec (`ai-backend/docs/public/contacts/contacts.json`), not a live call — no working `DATABASE_URL`/GHL connection was available in the environment this was built in. Same for `send_message`'s `POST /conversations/messages` shape, built directly from GHL's own documented DTO. **Test both against a real install before relying on them** — a live 400/403 the first time either fires would be the fastest way to find any spec drift.

## Files

**New:**
- `migrations/077_ai_actions.sql` — the `ai_actions` table (RLS-scoped, `pending → confirmed/rejected/failed/expired`)
- `migrations/078_ai_actions_send_message.sql` — widens the `action_type` CHECK to add `send_message`
- `src/services/ai/actionStore.js` — CRUD on `ai_actions` (`proposeAction`, `getAction`, `resolveAction`, `linkActionsToRun`)
- `src/services/ai/actionExecutor.js` — the *only* place a proposal becomes a real GHL call (`confirmAction`, `rejectAction`)
- `src/services/ai/dealActionDetector.js` — Deal Hub's separate second call
- `src/services/ghlMessageWrite.js` — `sendGhlMessage` / `buildMessageSend`
- `pipelinePulse-dashboard/src/pages/shared/ActionCard.jsx` — the confirm/edit/cancel card, shared by both Co-Pilots

**Changed:**
- `src/services/ai/tools/registry.js` — split `TOOLS` into `LOOKUP_TOOLS` (unchanged, still read-only) and new `PROPOSE_TOOLS`
- `src/services/ai/tools/toolLoop.js` — collects `proposedActions` (full `{actionId, actionType, proposed}` objects, not just ids) off the loop's result
- `src/services/ai/askPortfolio.js` — surfaces `proposedActions` on its response; backfills `run_id` onto proposals after `recordRun`
- `src/services/ai/askDeal.js` — calls `detectDealAction` after the main answer; surfaces `proposedActions`
- `src/services/contactPatch.js` — new `buildContactCreatePatch` (reuses `buildContactPatch`'s validation, adds "must be addressable" and drops update-only rules like tag protection)
- `src/services/ghlContactWrite.js` — new `createGhlContact`; shared `translateContactError` extracted from `updateGhlContact`'s own catch block
- `src/routes/ai.js` — `GET/POST /api/ai/actions/:id`, `.../confirm`, `.../reject`
- `pipelinePulse-dashboard/src/api/ai.js` — `getAction`, `confirmAction`, `rejectAction`
- `pipelinePulse-dashboard/src/pages/tabs/CopilotTab.jsx` / `src/pages/dealhub/AskDeal.jsx` — render one `ActionCard` per proposed action, alongside the existing `dealsRead`/`ReactionRow` UI

**Tests:** `contactPatch.test.mjs` (+12 for the create path), `toolRegistry.test.mjs` (+4, including both new safety-guarantee checks), `ghlMessageWrite.test.mjs` (new, 14 cases). Full `npm test` and the frontend's `npm run check` both pass.

## Extending this

To add a sixth action:
1. Add the `action_type` value to `ai_actions`'s CHECK constraint (new migration, same widen-the-constraint pattern as 078).
2. Write (or reuse) the real GHL write function, following `ghlContactWrite.js`/`ghlMessageWrite.js`'s shape: validate, call `ghlRequest`, translate errors, never touch Postgres directly (GHL is written first; a webhook mirrors the result back — this app has no compensating-transaction/rollback concept anywhere, and a new write shouldn't need one either).
3. Add a `propose_*` tool to `PROPOSE_TOOLS` in `registry.js` whose `run` only ever calls `proposeAction` — nothing else. The safety tests will catch it if this rule slips.
4. Add the dispatch case to `actionExecutor.js`'s `runWrite`.
5. Add the editable-fields layout to `ActionCard.jsx`'s `ActionFields` and a label to `ACTION_LABEL`.
6. If it should also work from Deal Hub, it already will — `dealActionDetector.js` is generic over `PROPOSE_TOOLS`, just update its `SYSTEM` prompt's tool count/description if you want the model reminded of it explicitly (its own tool description is usually enough).
