# Message Sync Redesign — Plan

Investigating and fixing missing outbound emails in the `messages` table. Planning doc — no code changes until James signs off.

---

## 1. What broke — the two confirmed cases

### Danilo Bardella (`xEPdvNFf4CYS6QgZ6svi`)
- Outbound email sent by Brad Ricardo on **16 Jul 12:07 UK (11:07 UTC)** — exists in GHL, missing from Supabase
- Contact `updated_at` moved to 11:08 UTC (one minute after the send) so GHL did register the event
- `processed_events` has zero message events in the 10:50–11:30 UTC window that day — only opportunity events
- Supabase holds only 2 backfilled messages from 8 Jun for this contact

### Yusuf Lala (`0NPCj0nYf2SOaVYr96Al`)
- Handover email sent by Brad on **10 Jul 12:48 UK (11:48 UTC)** — exists in GHL, missing from Supabase
- Verbatim missing text: *"Good Afternoon, Yusuf — I thought I would drop you a message as Chris has passed me your enquiry and I will be working in this with you..."*
- 7 other messages in the same thread synced correctly (8–15 Jul)
- Yusuf's later reply on 13 Jul 10:15 UTC references the missing email directly ("Thanks for getting back to me")
- The 15 Jul 14:10 UTC import pulled 13–15 Jul messages but **skipped over** the 10 Jul email sitting between the previous import and this one

**The smoking gun:** the fetch is not "everything since last import." It jumped past an older message that was newly present at the time of the second import.

---

## 2. Root cause analysis

### 2.1 How the current sync actually works

- **Messages do NOT come via webhooks.** `processed_events` shows only opportunity events since 8 Jul. GHL never sends us `InboundMessage` / `OutboundMessage` — because we never subscribed to those webhook events in the marketplace app config.
- **Messages come via a fetch triggered by stage_history writes.** When a stage-change webhook fires, the writer calls `fetchContactMessagesViaExport(install, contactId, windowStart, windowEnd)`. Window boundaries are:
  - `windowStart` = the entered_at of the previously-open stage row
  - `windowEnd` = the incoming event's timestamp
- **The fetch iterates conversations.** `listContactConversations()` paginates `GET /conversations/search?contactId=...`, then for each conversation calls the bulk export endpoint twice (default + `channel=Email`).

### 2.2 Why the two emails were missed — three suspects

#### Suspect A — Time-window scoping (STRONG)
The `[windowStart, windowEnd]` window is anchored to stage transitions. If the missing email was sent **before the current open stage began**, or **after a stage transition that fired later**, it falls outside every window we ever query. Yusuf's case fits: Brad's 10 Jul handover email may have been sent while the opp was in a stage that had already closed by the time later stage changes fired, so no fetch ever spanned 10 Jul.

#### Suspect B — Missed conversations (STRONG for handover emails)
GHL creates a **new conversation** when a different rep starts a new email thread with the same contact ("Chris has passed me your enquiry" is a textbook handover). The new conversation has a new `conversationId`. If `/conversations/search?contactId=...` doesn't return the new conversation immediately (indexing lag, or returns only the "primary" conversation), we never fetch it. Yusuf's handover fits this exactly.

#### Suspect C — Export endpoint quirk (POSSIBLE, LOW)
The bulk export requires `channel=Email` as an explicit filter for emails to appear (a known GHL quirk we already handle with two-pass fetch). But if the message is on a **different** conversation, our per-conversation loop never gets to it.

### 2.3 Best guess

Most likely combination of A + B. The fetch:
1. Only fires when a stage changes
2. Only reads conversations returned by a specific `/conversations/search` call
3. Only within a window bounded by the last stage transition

Any email that sits outside all those constraints — a handover-thread email sent between stage changes — is invisible to the fetch.

---

## 3. Blast radius estimate

Every contact where any of the following is true is at risk:
- Contact has more than one GHL conversation thread (handovers, re-engagements, different departments)
- Rep sends an email that doesn't cause a stage move (very common — most follow-ups don't move the stage)
- Rep sends an email during a period when the opportunity has no open stage_history row (rare but possible)
- Messages arriving between imports get overtaken by newer messages that trigger the next import

**Rough estimate**: any BGD contact with multiple conversation threads is affected. To size properly:
```sql
SELECT COUNT(DISTINCT contact_id) AS contacts_with_multiple_convos
FROM messages
WHERE location_id = 'IFcSg4YvuVlx56msjbdf'
GROUP BY contact_id
HAVING COUNT(DISTINCT conversation_id) > 1;
```
And to detect suspected gaps (contacts where GHL says there's activity we don't have):
```sql
SELECT c.contact_id, c.updated_at, MAX(m.message_timestamp) AS last_msg_ts
FROM contacts c
LEFT JOIN messages m ON m.contact_id = c.contact_id AND m.location_id = c.location_id
WHERE c.location_id = 'IFcSg4YvuVlx56msjbdf'
GROUP BY c.contact_id, c.updated_at
HAVING c.updated_at > MAX(m.message_timestamp) + INTERVAL '1 hour';
```

**Impact on analytics:**
- `first_response_minutes` under-reports responsiveness (missed outbound → looks like we didn't reply)
- `outbound_count` under-reports rep activity
- `last_activity_at` reads stale
- `vw_opportunity_messages_json` shows an incomplete thread — LLM extraction of qualification facts will miss key statements
- "Quote-gone-quiet" and follow-up leak reports flag active deals as abandoned

---

## 4. Proposed fix — three parts, in priority order

### Part 1 (the real fix): subscribe to GHL message webhooks

**What changes:** subscribe to `InboundMessage` and `OutboundMessage` events in the GHL Marketplace app config. Add webhook handlers in `routes/webhooks.js` that write directly to the `messages` table.

**Why this fixes both cases:**
- Every message emits an event at send time, regardless of stage state
- No time-window scoping, no conversation enumeration — GHL pushes us the message with its `conversationId` inline
- Decouples message sync from stage transitions entirely

**What to design carefully:**
- Idempotency: same message id could be delivered multiple times (existing unique index on `(location_id, message_id)` covers this)
- Signature verification: same RSA verify path as opportunity events
- Contact + opportunity resolution: webhooks carry `contactId` but may not carry the associated `opportunity_id` — we'd link on write via the same rules the writer already uses (single opp = that one, multiple = leave `opportunity_id` NULL and let a nightly linker fill in)
- `stage_history_id` linkage: assign against whichever stage was open at the message's timestamp (may require a small lookup, not a hard join)
- Backwards compatibility: keep the stage-triggered fetch as a safety net for the first few weeks, then delete once webhook coverage is verified

**GHL webhook events we need to subscribe to** (verify in the marketplace docs before code):
- `InboundMessage` — customer → us
- `OutboundMessage` — us → customer
- `ConversationUnreadUpdate` — probably ignore
- `ConversationProviderOutboundMessage` — some GHL variants use this instead

### Part 2: on stage change, refresh opportunity metadata only — NOT messages

**What changes:** `stageHistoryWriter.js` stops calling `fetchContactMessagesViaExport()`. The message fetch is removed from the stage-change codepath entirely, because Part 1 handles messages independently.

**Why:**
- Removes the coupling that caused the bug
- Removes 2 × N GHL API calls per stage transition (where N = conversations for the contact) → less rate-limit pressure
- Simplifies the writer

**What still happens on stage change:**
- Contact upsert (custom fields, UTM, gclid)
- Opportunity upsert (name, value, MEDDIC, assignedTo, etc.)
- Close prior stage_history row, open new one
- Assigned-to user name refresh

### Part 3: widen the safety-net fetch (interim only, until Part 1 is proven)

**What changes:** while we're validating Part 1 works, keep the fetch but fix its scope:
- **Time window:** widen from `[open.entered_at, now]` to `[open.entered_at - 30 days, now]` so we catch handover emails sent slightly before the current stage opened
- **Conversation enumeration:** log every conversation returned by `/conversations/search?contactId=...` — if we ever see the count drop between successive calls for the same contact, that's the missed-conversation bug and we log a WARN
- **Fallback pull:** if the fetch returns zero messages but the contact has a recent `updated_at`, do a wider window pull as a last resort

Once Part 1 has run cleanly for 2 weeks with no gaps, Part 3 can be removed and the fetch deleted entirely (Part 2).

---

## 5. Emails and `threadId` — do we need to store it?

James raised: *"for email messages we need to start sync threadId as well because one email has multiple threads right?"*

**Answer: yes, add a `thread_id` column, but it's not the root cause of the missing-message bug.**

- GHL's email object exposes a `threadId` (Gmail-style — groups replies together)
- Currently we store `conversation_id` but not `thread_id`
- `conversation_id` = the GHL conversation container (one per contact-channel, roughly)
- `thread_id` = the email thread within that conversation (one per email chain / subject)
- One contact → many conversations → many threads → many messages

**Why we want it:**
- Lets us reconstruct an email chain in the correct order for the LLM extraction (Phase 2)
- Lets us detect handover emails (new `thread_id` from a different owner)
- Lets us group thread activity in analytics ("this thread has had 4 replies")

**Schema change:**
```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id TEXT;
CREATE INDEX IF NOT EXISTS messages_loc_thread_ts
  ON messages (location_id, thread_id, message_timestamp)
  WHERE thread_id IS NOT NULL;
```

Backfill from `messages.message_body_raw` where possible (email headers include the thread), but easier to just let it populate going forward from webhook payloads.

---

## 6. Backfill approach for the missing messages

**Once Part 1 is live** and we've verified webhook flow works, a one-time backfill for historical gaps:

- Extend the existing `backfill.js` with a new `--messages-only` mode
- For each contact in a location: hit `GET /conversations/search?contactId=...` **without** any startAfter filter (get every conversation, however GHL indexes it)
- For each conversation, run the two-pass export with a very wide window (contact creation → now)
- ON CONFLICT DO NOTHING on `(location_id, message_id)` — safe to re-run
- Log a summary: "backfilled X messages across Y contacts and Z conversations"

**Cost estimate:** ~1 API call per contact for the conversation list + ~2 API calls per conversation for the two-pass export. For BGD (~few hundred contacts, average ~1.5 conversations each): ~1,500 GHL calls, ~3–4 minutes at the current 125ms pacing.

**Rollout sequence:**
1. Ship Part 1 (message webhooks)
2. Verify 1 week of clean data — every new message arrives via webhook, no gaps vs. GHL UI spot-checks
3. Ship Part 2 (remove stage-triggered fetch)
4. Run the one-time backfill for historical gaps
5. Ship Part 3 deletion (once safety-net fetch is no longer needed)

---

## 7. What we're NOT doing

- **Not modifying the writer for stage transitions.** That part works.
- **Not touching webhooks for opportunity events.** Those work fine.
- **Not changing the analytics views** — same schema, same joins. Views auto-reflect the new data.
- **Not doing a mass historical backfill immediately.** Live data first, historical fill later once the live path is proven.

---

## 8. Risk & mitigation

| Risk | Mitigation |
|---|---|
| Webhook subscription config gets missed in marketplace app | Deploy Part 3 (widened fetch) FIRST as safety net, then Part 1, then Part 2 to remove the coupling |
| Duplicate messages (webhook + fetch both fire) | Existing `UNIQUE (location_id, message_id)` index handles it — `ON CONFLICT DO NOTHING` |
| Rate limit on backfill | Already paced at 125ms/call. If GHL tightens limits, drop to 200ms. |
| Contact→opp attribution when message webhook arrives | Same rule as Phase 2 attribution: single opp = link; multiple = null, resolve nightly |
| `thread_id` not always present | Nullable column, index is partial. Emails: populated. SMS/WhatsApp: null. |

---

## 9. Sequencing & owners

| Step | Owner | Blocker | Effort |
|---|---|---|---|
| **1. Investigation confirmation** — spot-check GHL for the two missing emails' conversation IDs | James / Srinivas | Nothing | 30 min |
| **2. Marketplace app webhook subscription** — enable InboundMessage + OutboundMessage events | Srinivas + James | Access to Marketplace dashboard | 30 min |
| **3. Widened safety-net fetch (Part 3)** — deploy first as insurance | Srinivas | Nothing | 2 hours |
| **4. Message webhook handlers (Part 1)** — routes/webhooks.js + writer | Srinivas | Step 2 done | 1 day |
| **5. `thread_id` column + population** | Srinivas | Part 1 shipped | 2 hours |
| **6. Remove stage-triggered fetch (Part 2)** | Srinivas | 1 week clean webhook data | 30 min |
| **7. One-time historical backfill for gaps** | Srinivas | Part 1 proven | 1 hour + wall clock |

**Total build effort: ~2 days.** Plus ~1 week wall-clock to verify Part 1 before removing the fallback.

---

## 10. Sign-off checklist for James

Before we write any code:
- [ ] Agree Part 1 (message webhooks) is the direction
- [ ] Confirm we can enable `InboundMessage` + `OutboundMessage` subscriptions in the Marketplace app config
- [ ] Agree that stage-change webhooks stop pulling messages once Part 1 is live
- [ ] Agree to add `thread_id` column for emails
- [ ] Agree the one-time backfill is safe (ON CONFLICT DO NOTHING; no data loss risk)
- [ ] Decide: run backfill just for BGD first, or all 4 locations?

Once James signs off, we implement in the sequence above. Nothing changes in Supabase or the sync code until then.
