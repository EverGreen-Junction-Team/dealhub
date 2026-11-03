# Message Sync — Fix Plan (v2)

**What this is about:** Some outbound emails are missing from Supabase, even though they exist in GHL. This document lays out what's happening, what we'll change, and what sign-off we need before starting.

**Status:** Plan v2 — reflecting James's feedback of 21 Jul. Approved to build on this basis.

**Date:** 21 Jul 2026

---

## 1. What we have today

Everything a rep does in GHL — creating a deal, moving it through stages, sending messages, marking it won or lost — flows into Supabase. From there it feeds the analytics, the pipeline views, and the monthly review.

There are four things we currently track per deal, one Supabase table each:

- **`contacts`** — who the customer is (name, email, phone, source, UTM tags, gclid, custom fields)
- **`opportunities`** — the deal itself (name, pipeline, stage, value, owner, MEDDIC fields, product info, custom fields)
- **`stage_history`** — every time a deal moves stage, we record `entered_at` and `left_at` — one row per stage session, plus the open row where `current_stage = true`
- **`messages`** — the emails, WhatsApp, SMS and calls between the rep and the customer, linked to the contact and (when known) to the opportunity + the stage_history row it fell inside

The first three (`contacts`, `opportunities`, `stage_history`) sync live and reliably. Every time something changes in GHL, we hear about it and update Supabase within seconds.

**The problem is with `messages`.**

---

## 2. How messages currently get into Supabase

Today, messages don't sync on their own. We only fetch them **when a deal changes stage.** When Brad moves a deal from "Initial Contact" to "Quote Sent", the system asks GHL for all the messages sent during that stage, and stores them.

This works when reps are moving deals through the pipeline regularly. It breaks in two situations:

**Situation A — The rep sends a message but doesn't move the stage.**
Very common. Follow-up emails don't usually cause a stage change. If Brad sends a chase email while the deal sits in "Quote Sent", we never get told to fetch it. The email exists in GHL, but it's invisible to us until the deal eventually moves again — which could be weeks, or never.

**Situation B — GHL creates a new email thread that we're not looking at.**
When a customer's enquiry is handed over to a different rep, GHL sometimes creates a brand new conversation thread. Our fetch may not know about the new thread yet, so it looks only at the old one and misses the new messages.

---

## 3. Two real examples we've confirmed

### Danilo Bardella (16 Jul)
Brad sent Danilo an email on Thursday 16 Jul at 12:07 UK time. GHL registered activity on Danilo's record one minute later, so we know the email went through GHL. But it never made it to Supabase. There's no message row for it. The deal probably didn't move stage that day, so nothing triggered a fetch.

### Yusuf Lala (10 Jul)
Brad sent Yusuf a handover email on Friday 10 Jul at 12:48 UK time — the "Chris has passed me your enquiry, could we arrange a call" message. Yusuf later replied on 13 Jul saying "Thanks for getting back to me, I'm free tomorrow morning" — clearly a reply to the missing email. But the original email from Brad isn't in Supabase. Seven other emails in the same conversation synced fine; only the 10 Jul one is missing. Most likely: the handover started a new email thread that the fetch didn't know to look at.

---

## 4. Why this matters

If outbound emails are missing, everything downstream is wrong:

- **Speed-to-lead numbers** look worse than reality — the deal looks unanswered when Brad has in fact replied
- **Follow-up counts** under-report rep activity
- **"Gone quiet" reports** flag active deals as abandoned
- **The AI extraction pass planned next** will read incomplete conversations and miss things the customer said (budget, timeline, decision maker)
- **The monthly revenue review** shows lower activity than actually happened

The fix has to land before the AI extraction goes live. Garbage in, garbage out.

---

## 5. What we'll change — scheduled sweep replaces the stage-triggered fetch

Nothing downstream needs real-time message sync. The clocks, reviews and extraction pass all work fine on day-old data. Speed-to-lead is measured from message timestamps, not sync time. So a scheduled sweep is the right tool — simpler than webhooks, self-reconciling, no missed-event risk.

### Move 1 — Scheduled sweep

A cron job runs every 12 hours (noon + midnight UK). Each run:

1. **Find contacts with recent activity** — any contact where `updated_at` moved in the last 12 hours (matching the sweep window). This keeps us inside GHL's rate limits — we don't sweep every contact every run, only the active ones.
2. **For each of those contacts**, fetch all messages from GHL across every conversation the contact has (both passes — default channels + explicit email pass, because GHL silently drops emails without the flag).
3. **Insert new messages** using `ON CONFLICT (location_id, message_id) DO NOTHING` — anything we already have is skipped; anything new lands.
4. **Run the opportunity-linking pass** for every message with `opportunity_id = NULL` (see Move 2 below).
5. **Log a summary** and alert on failure (see §9).

**Why this fixes both real examples:**
- Danilo (no stage change): sweep runs 12h later regardless, picks up the missing email
- Yusuf (handover to new thread): sweep re-queries all of the contact's conversations from scratch each time, so a newly-created thread is discovered on the next run

**Trade-off vs live sync:** worst case a message is 12 hours late reaching Supabase. Acceptable — no downstream deliverable needs faster.

### Move 2 — Opportunity linking, inside the sweep

When a message arrives, we always know the `contact_id`. GHL does not always tell us which `opportunity_id` the message belongs to — a contact can have multiple deals in the pipeline (e.g. a homeowner asking about both bifolds and rooflights). We handle it in three passes, all inside the sweep:

1. **Single-deal contacts** — if the contact has exactly one open opportunity, link every message from that contact to it.
2. **Multi-deal contacts — HARD EXCLUSION** — where a contact has 2+ open opportunities sharing a live email thread, we do NOT link. Timestamps alone can't tell which deal a message belongs to, and mis-attribution on the bigger deals breaks trust in the whole system. Messages are still stored (contact-only), but the AI extraction pass is instructed to skip these contacts entirely — no MEDDIC extraction writes to deals sharing a live thread until we have a proper attribution answer.
3. **Historical link-fill** — for any message with `opportunity_id = NULL` where a stage window can be reconstructed from `stage_history`, link it if the timestamp falls inside a known `[entered_at, left_at]` window on a single opportunity. This catches messages that came in when the contact had multiple deals but only one had activity in that time.

The `thread_id` column (see §7) is the path out of the multi-deal problem long-term — once we can group by thread, we can eventually attribute cleanly. For now it just gets captured, not used for linking.

### Old fetch removed after verification

The current stage-triggered message fetch is removed only after the sweep has run cleanly for a week and verification (§8) passes. Stage-change events continue to update the `opportunities` row and open/close `stage_history` rows — they just stop fetching messages.

---

## 6. Historical gap — filling in what's already missing

Once the sweep is running cleanly, we do a one-time backfill for messages that are missing from `messages` but exist in GHL. Same shape as the sweep, but with a much wider time window — we ask GHL for every conversation on every contact, from contact creation to now, and insert anything not already there. The `messages` table already has a unique index on `(location_id, message_id)`, so nothing gets duplicated — re-runs are safe.

Same opportunity-linking rules from Move 2 apply during backfill. Multi-deal contacts stay excluded from AI attribution.

Takes about 15 minutes per business (Crittall, BGD, Veritas, Omnia). No downtime.

**Order:** BGD first — it's your QA sandbox. You and Eduarda spot-check a few contacts against GHL to confirm the missing emails have now appeared. Then we run it on Crittall, Veritas, Omnia in sequence.

**Critical path callout:** Eduarda re-runs the quote-silence and follow-up baselines against the corrected data after BGD's backfill passes spot-check. Auto-acknowledgement goes live after that. So the BGD backfill is on the critical path — we'll flag the moment it's done.

---

## 7. Extra improvement — track email threads properly

While we're changing the message sync, one more thing worth adding: each email carries a **thread ID** (the equivalent of a subject line group in Gmail). We don't currently store it. Adding a `thread_id` column to `messages` (nullable — only emails have it, SMS/WhatsApp/calls stay NULL) means:

- Reconstruct email chains in the correct order for the AI extraction later
- Detect handovers (a new `thread_id` started by a different rep) — the Yusuf case would have been visible for exactly this reason
- Long-term path out of the multi-open-deal attribution problem — once we can group by thread, we can eventually attribute correctly across contacts with 2+ live deals

Small addition, ships alongside the sweep.

---

## 8. Verification before we retire the old fetch

"No gaps" is a positive test, not the absence of complaints. Before the stage-triggered fetch is removed:

- Pick a sample of BGD contacts across single-deal and multi-deal
- For each, count messages in GHL UI vs `SELECT COUNT(*) FROM messages WHERE contact_id = ...`
- **The counts must match.** Any mismatch is a gap; investigate before the removal ships.
- Repeat the check ~one week after the sweep goes live.

Only after a clean verification does Move 1 replace the old fetch as source of truth.

---

## 9. Failure alerting

With a scheduled job, the silent failure mode is real — the sweep doesn't run, nobody notices until the Tuesday review shows stale data.

We'll add:

- A "last successful sweep at" timestamp written on every completed run
- An email alert to the Vaultsuite team if a run fails, throws, or takes longer than 2× normal duration
- A "no sweep in last 24 hours" alert if the last-successful timestamp goes stale

Simple, deterministic, catches the silent-failure case James called out.

---

## 10. Multi-open-deal contacts — homework

James asked how many BGD contacts have 2+ open opportunities at once. That number decides how hard we work on the attribution problem later.

We'll run this SQL once the plan is approved and share the number:

```sql
SELECT COUNT(DISTINCT contact_id) AS multi_open_deal_contacts
FROM opportunities
WHERE location_id = 'IFcSg4YvuVlx56msjbdf'
  AND status = 'open'
  AND is_deleted = false
GROUP BY contact_id
HAVING COUNT(*) >= 2;
```

Plus a spot-check: for the top 5 such contacts, list the opportunity names + monetary values, so we can see whether these are the "bigger deals" James suspects.

---

## 11. What we're NOT doing in this fix

To be clear about scope — these are all Phase 2 work:

- Call transcription (Whisper on recorded calls)
- The nightly AI extraction pass (MEDDIC + evidence)
- Full contact → opportunity attribution for multi-open-deal contacts
- GCLID plumbing back to Google Ads
- Extending the analytics views with AI fields, three whys, forecast

This document is only about **fixing message sync** so those Phase 2 pieces have clean data to work with.

---

## 12. Sign-off — approved 21 Jul

James's reply approved the plan on this basis:

- [x] Scheduled sweep instead of live webhook sync — 12h cadence, contacts filtered by recent activity
- [x] Move 3 (safety net) dropped — sweep is that fix made permanent
- [x] NULL-opportunity linking runs inside the sweep, not on stage change
- [x] Multi-open-deal contacts parked with hard AI-extraction exclusion — `thread_id` still captured
- [x] Week-1 verification: manual message-count check GHL vs Supabase must pass
- [x] Backfill order: BGD → Crittall → Veritas → Omnia
- [x] Failure alerting added
- [x] BGD backfill flagged the moment it's done (baselines critical path)

Build proceeds on this basis. Any deviation from the above requires re-approval before shipping.
