# Deploy — deal tags, the merged board, and the Deal AI fixes

Everything below is **already committed and pushed** (server `e70cb7d`,
dashboard `a3aecf4`). Nothing here is live yet.

One new migration (**134**) and both apps.

Read §0 first. Two steps are order-dependent in a way that is hard to see
afterwards.

---

## 0. Before you start

**Order matters: migration 134 BEFORE the new server code.**

Not the usual "migrations first" caution — this one has a specific failure.
The old `stageHistoryWriter.js` calls `reconcileTags` with
`entityType: 'opportunity'` and `opp.tags`, a field GHL never sends, so
always `[]`. `reconcileTags` closes every open row not in `currentTags`,
and does **not** scope that by `detected_via`.

So: old code + new rows = every tag 134 seeds gets closed on the next
opportunity event each deal receives. The filter would work, then silently
empty as deals were touched over the following hours. Running 134 first and
restarting promptly closes that window.

**Take a backup.** 134 is a bulk insert across every deal × every linked
contact's current tags. It is additive and idempotent, but it writes real
rows to `tag_history`.

**Postgres 15+**, as for every migration since 083 (`security_invoker`).

```sql
SHOW server_version;
```

---

## 1. Server

```bash
cd /path/to/pipelinePulse/server
git pull
npm ci --omit=dev
npm run migrate          # → ran 1 (134), skipped the rest
pm2 restart pipelinepulse-server
```

### What 134 does

Seeds `tag_history` with one `entity_type='opportunity'` row per
(deal, tag), from the union of every linked contact's **current** tags —
the primary (`opportunities.contact_id`) plus every additional one
(`opportunity_contacts`).

`detected_via = 'contact_fanout'` on every row, so these are
distinguishable from anything applied another way.

**Why this exists.** GHL has no opportunity tags — migration 048 states it:
*"no tags[] field on the opportunity object, no webhook for opportunity
tags."* The deals list tag filter queries
`tag_history WHERE entity_type = 'opportunity'`, a set that had never held
a single row, so it returned 0 for every tag ever picked.

### Check it landed

```sql
-- Was empty before this. Should now be non-zero.
SELECT count(*) FROM opportunity_tags WHERE removed_at IS NULL;

-- Spot-check one deal against its contacts.
SELECT ot.tag_name
  FROM opportunity_tags ot
 WHERE ot.location_id = '<loc>' AND ot.opportunity_id = '<deal>'
   AND ot.removed_at IS NULL
 ORDER BY 1;
```

The second query should match what GHL's own opportunity modal shows for
that deal — it is the same projection.

---

## 2. Dashboard

```bash
cd /path/to/pipelinePulse-dashboard
git pull
npm ci
npm run build
# deploy dist/ however this app is served
```

---

## 3. What changed

### Deal tags — now real

| | |
|---|---|
| Deals tag filter | Returned **0 for every tag**. Now filters properly. |
| Realtime | A contact's tags now fan out to every deal they are on. |

The fanout runs on five paths, so a tag reaches its deals however it was
applied:

| Trigger | Effect |
|---|---|
| `ContactTagUpdate` | recompute every deal that contact is on |
| `ContactCreate` / `ContactUpdate` | reconcile tags, then fan out |
| `RelationCreate` | recompute that deal |
| `RelationDelete` | recompute that deal |
| any opportunity event | recompute (covers a primary-contact change) |

The daily contact sync routes through `handleContactUpsert`, so a dropped
webhook self-heals on the next run.

**A deal's tags are recomputed, never patched.** Removing a tag from one
contact does not strip it from the deal if another contact on that deal
still carries it.

### The deals board — one grid

Was: one full-height board **per pipeline** when "All pipelines" was
selected. Eight pipelines meant eight screens, each with its own
scrollbar, almost all reading "No deals here".

Now: one grid. Stage names repeat across pipelines (each with its own
`stage_id`), so columns are keyed by NAME and each asks for every id
sharing it. Picking a pipeline narrows the same grid.

- `GET /api/deals` now accepts `stageId` as a comma-separated list
  (capped at 50), switching to `= ANY(...)`.
- Dragging a card resolves the stage id for **that deal's own pipeline** —
  a merged column holds one id per pipeline.
- Tag and Owner filters now reach the board at all. They never did: the
  count beside the heading sent them and the columns did not, which is why
  "Deals 0" sat above a board full of deals.

### Deal AI

| | |
|---|---|
| "draft a message" | Returned the literal words **"Working on that."** and no draft. |
| Save as note / Create task | Disabled on **every** deal. |

Three separate causes: a prompt left over from the old two-call design
telling the model to defer write requests; `proposedActions` being
overwritten by the detector so a tool-made draft was stored then dropped;
and `AskDeal` never receiving the `people` prop, so both buttons were
gated on an always-empty array.

Deal drafts also now carry the rep's signature, as portfolio drafts always
have.

### Smaller fixes

- **Grounding warning** ("Check this one") fired on correct answers — a
  skill's deals were invisible to it. Also fixed a false NEGATIVE: an
  invented deal went unflagged whenever a real one appeared earlier on the
  same line.
- **Skill charts** — a list view with a repeating date labelled four
  different customers "15 Sept"; a view carrying prose now renders as a
  table rather than charting the deal values beside it.
- **Skills editor** — the list no longer vanishes when you click Edit; the
  database view is a searchable dropdown rather than a typed name; cards
  sit side by side with the full description behind "View more"; Deal AI
  is now a selectable surface (unticked by default).
- **Deal contacts** — a person's name in the People list opens their
  contact record.
- **Notes rail** — a note's own title now shows, as the Tasks rail does.

---

## 4. Verify

**Tags.** Pick a tag you know is on a contact with a deal. The board and
list should both narrow. A tag that exists only on contacts without deals
correctly returns nothing — that is not a bug, and it is what "1st june
import" was.

**Realtime.** Add a tag to a contact in GHL, wait for the webhook, filter
deals by it. The contact's deals should appear without a re-run of 134.

**Board.** Select "All pipelines". One grid, one horizontal scrollbar.
Drag a card between columns and confirm in GHL that it landed in the right
stage of its own pipeline.

**Deal AI.** On a deal with a contact: *"draft a message"*. Expect a draft
and an action card, not "Working on that." Then try "Save as note".

---

## 5. Rollback

The fanout rows, leaving everything else:

```sql
UPDATE tag_history SET removed_at = now()
 WHERE entity_type = 'opportunity'
   AND detected_via = 'contact_fanout'
   AND removed_at IS NULL;
DELETE FROM schema_migrations WHERE filename LIKE '134%';
```

`detected_via` is what makes this safe — it only touches rows this feature
created.

To drop them entirely instead:

```sql
DELETE FROM tag_history
 WHERE entity_type = 'opportunity' AND detected_via = 'contact_fanout';
```

Then deploy the previous server commit. The index 134 adds
(`tag_history_entity_tag_open`) is harmless either way; leave it.

---

## 6. Expected, not bugs

- **A tag on contacts with no deals filters to nothing.** Correct — no
  deal carries it.
- **Two deals for the same contact get the same tags.** GHL treats a
  contact's tags as reaching all their opportunities; migration 048 says
  so explicitly.
- **A tag stays on a deal after one contact loses it** if another contact
  on that deal still has it. The deal's tags are the union.
- **`applied_at` can predate the deal.** It is the earliest moment any of
  the deal's contacts carried that tag, so "tagged before this deal
  existed" stays answerable.
- **The tag dropdown still lists account-wide tags**, including ones no
  deal carries. GHL's tag catalogue is account-wide; narrowing the picker
  to deal-only tags is a separate change, not done here.
