# Calendar — full test report

**Date:** 25 November 2026
**Tested on:** the live app inside GHL (Chrome), dashboard build at `c909b33`
**Sub-accounts:** `IFcSg4YvuVlx56msjbdf` (12 people, 10 calendars, no appointments) and `fJNuIdxGgchGpJ9OoBbk` (appointments, including multi-day ones)
**Method:** every view and control exercised by hand in the browser; every fix verified live after deploy, plus server-side rendering and unit tests locally.

---

## Summary

| | Count |
|---|---|
| Test cases run | 45 |
| Passed first time | 18 |
| Failed, then **fixed and re-verified live** | 25 |
| Could not be fully tested (no data / blocked by CRM settings) | 2 |
| Open items (not fixed — see the end) | 8 |

**Most serious defects found and fixed**

1. **Clicks and drags landed at the wrong time.** Clicking 14:20 opened a booking for 12:15; a drop would have rescheduled the appointment in the CRM by the same error (15% of its distance from midnight, about 2 hours in the afternoon). Cause: the app's 85% zoom was not undone when converting the pointer to a time. *Fixed `0061dc3`; a drop onto Thu 16:00 landed exactly on Thu 16:00 in the live test.*
2. **The ‹ › arrows never moved the calendar.** The click threw inside the handler, so nothing happened. *Fixed `c5e637e`; verified live: › went to 30 Nov – 6 Dec, ‹ ‹ to 16–22 Nov.*
3. **Book was unreachable in People view.** A 12-person board made the page wider than the window and pushed Book off the edge. *Fixed `0061dc3` + `222dc9b`.*
4. **Accepted writes looked like failures.** After a move or status change the board reloaded our database before GHL's webhook had updated it, so the old state came back: a moved card sat in its old place for 6+ seconds, "Saved" appeared over an unchanged card. *Fixed `047f61e`; reinstate showed in under 3 seconds live, previously 12+.*
5. **A note typed in the booking card was never shown again.** *Fixed `42bae71`; the note "QA test note – side gate…" now shows in the hover card live.*

---

## Results by area

### Layout and navigation

| # | Test | Result | Notes |
|---|---|---|---|
| L1 | Week view loads, opens near the current time | ✅ Pass | |
| L2 | Scrolling the left rail with 22 entries | ✅ Fixed | Was scrolling the whole page; day headings and month title slid under the toolbar. Rail now scrolls inside itself. `0061dc3` |
| L3 | Page never wider or taller than the window | ✅ Fixed | `222dc9b` |
| L4 | Toolbar is one line in every view | ✅ Fixed | Month view added a second line and the page jumped 10px. `0061dc3` |
| L5 | ‹ › arrows | ✅ Fixed | Never worked. `c5e637e` |
| L6 | Today button | ✅ Pass | |
| L7 | Mini-month: pick a day, page months | ✅ Pass | |
| L8 | Mini-month band in Month view | ✅ Fixed | Whole picker turned green. `0061dc3` |
| L9 | Mini-month white ring around today | ✅ Fixed (earlier) | `51a26ba` |
| L10 | Timezone label in the hour gutter | ✅ Pass | "GMT" shown; no false "no timezone set" warning while loading (fixed `222dc9b`) |

### Views

| # | Test | Result | Notes |
|---|---|---|---|
| V1 | Day view | ✅ Pass | |
| V2 | Month view fills the window | ✅ Fixed | Stopped two-thirds down. `604400f` |
| V3 | Month: multi-day booking on each day it covers | ✅ Fixed | Showed on the first day only. `064ed95` |
| V4 | Month: multi-day booking label per day | ✅ Fixed | Every day said "00:00" / "10:30" as if it restarted. Now: start time, "All day", "until 11:00". `a7926f3` |
| V5 | People: 1 day / 3 days | ✅ Pass | |
| V6 | People: title for one day | ✅ Fixed | Said "25 – 25 November 2026". `0061dc3` |
| V7 | People: opens near now; hour labels | ✅ Fixed | Opened at midnight; labels straddled lines. `0061dc3` |
| V8 | People: "Busy only" | ✅ Fixed | Kept people with no work on the day shown (counted the whole fetched range). `0c3a484`. Empty day now says "showing everyone" (`604400f`) |
| V9 | People: multi-day booking on every day it covers | ✅ Fixed | Person showed "Free" after day one. `064ed95` |
| V10 | Week: multi-day booking | ✅ Fixed | Was a full-height slab hiding Tuesday and swallowing clicks. Now a bar across its days (`5f0b5b7`) plus a 10:30 start marker in the timeline (`064ed95`); name no longer squeezed out on a one-column bar (`280c801`) |

### Filters

| # | Test | Result | Notes |
|---|---|---|---|
| F1 | Everything / Appointments | ✅ Pass | |
| F2 | Blocked time | ⚠️ Partly tested | No blocked time exists in either sub-account, so only the empty state was tested |
| F3 | Empty board explains why | ✅ Fixed | Blocked time and People → None gave a blank month. Now a notice + "Show everything". `c5e637e` |
| F4 | People / Calendars All–None | ✅ Pass, target fixed | "All" was a ~14px target and was missed. `c5e637e` |
| F5 | Rail calendar names | ✅ Fixed | Ten "X's Personal Calendar" rows truncated identically; owner first + "Personal" tag. `0061dc3` |

### Cards and hover

| # | Test | Result | Notes |
|---|---|---|---|
| C1 | Hover card: wide, readable, name once | ✅ Pass | |
| C2 | Hover card: multi-day duration | ✅ Fixed | "8670 min" → "6 days"; 23:59 ends no longer "5 days 23 hr". `5f0b5b7`, `a7926f3` |
| C3 | Hover card vs ⋯ menu | ✅ Fixed | Both opened over each other. `280c801` |
| C4 | ⋯ menu offers only valid statuses | ✅ Fixed | Offered "Mark as attended" on an attended booking. `047f61e` |
| C5 | Cancelled booking styling | ✅ Pass | Struck through, plain white |

### Booking (writes to GHL — approved)

| # | Test | Result | Notes |
|---|---|---|---|
| B1 | Click slot → card at the clicked time | ✅ Fixed | See defect 1 |
| B2 | Draft updates as you type | ✅ Pass | |
| B3 | Book button default date | ✅ Fixed | Defaulted to a past day from last week's view. `280c801` |
| B4 | Customer search | ✅ Pass, fixed | Avatars invisible (portal token scope) and two identical "spyfu.com" rows; now coloured, with "No email, phone or business on file". `280c801` |
| B5 | Who's going / Calendar lists | ✅ Pass | Calendar list took ~8s once, fast afterwards |
| B6 | Create booking | ✅ Pass | `zz calendar QA 1`, SPYFU.COM, James io, James.io, Tue 1 Dec 14:15 |
| B7 | GHL refusal → "Book it anyway" | ✅ Pass | GHL refused an empty slot ("no longer available" — the James.io calendar's own availability rule); the override button appeared and booked it |
| B8 | Booking card stays inside the window | ✅ Fixed | Ran off the bottom when the refusal appeared. `42bae71` |
| B9 | Internal note saved and shown | ✅ Fixed | See defect 5 |
| B10 | Drag to move | ✅ Pass (after fix) | Landed on the exact drop time; showed late before `047f61e` |
| B11 | Mark attended | ✅ Pass | First click did not register (stale card replaced mid-click — see O3) |
| B12 | Mark no-show | ✅ Pass | First click did not register — cause not confirmed (O3) |
| B13 | Cancel | ✅ Pass | Toast: "the customer was not emailed" |
| B14 | Reinstate | ✅ Pass | Visible in <3s after `047f61e` |
| B15 | Drag to reassign | ⚠️ Refused by GHL | "The user id not part of calendar team" — only James io is on the James.io calendar's team, so a successful reassign could not be tested. App restored the card correctly; wording made plain (`c909b33`) |

**Test data left in the CRM:** one appointment, `zz calendar QA 1` — SPYFU.COM, James io, James.io calendar, **Thu 3 Dec 2026 16:00–16:30, cancelled**. The app cannot delete; remove it in GHL if wanted.

---

## Open items (not fixed)

| # | Item | Why not fixed / what's needed |
|---|---|---|
| O1 | Reassign lets you drop onto someone not on the calendar's team, then GHL refuses | Needs calendar team membership from GHL to grey those columns out during a drag. A feature, not a bug fix |
| O2 | GHL refused a visibly empty slot on James.io | GHL's own availability settings on that calendar (hours / slot interval / notice). Check the calendar in GHL; the override works meanwhile |
| O3 | 2 of 6 menu clicks did not register on first try | One explained (card replaced mid-click by the slow refresh, which `047f61e` removes). The other unexplained — watch for it |
| O4 | Blocked time not tested | No blocked time exists in either sub-account; block an hour in GHL and recheck |
| O5 | Person colours repeat after 9 people | Palette has 9 hues; 12-person sub-account has collisions |
| O6 | Home has no Calendar tile | Every other tab has one |
| O7 | Server changes need deploying | `42bae71` (store `description` as the note) and `c909b33` (plain-English refusal). The note already shows live; the server change makes it hold for the nightly sweep too |
| O8 | 11 dashboard test files were already broken before this work | Most point at a folder that no longer exists (`pipelinePulse/server`); `npm test` stops at the first, so most of the suite never runs |

---

## Commits

`0061dc3` `222dc9b` `604400f` `5f0b5b7` `064ed95` `364169d` `0c3a484` `a7926f3` `c5e637e` `280c801` `42bae71` `047f61e` `c909b33` — all on `main`, all pushed. Each was committed only after lint, the calendar tests and the build passed (except `064ed95`, which went out with one stale assertion and was corrected in `364169d`).
