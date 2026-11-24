# Deploy — the calendar and the appearance settings

Two migrations (143, 144), one new API route, the task-phantom fixes, and a
dashboard that Vercel has already shipped.

Everything is committed and pushed. Nothing here needs a code change.

---

## 0. Before you start

**The dashboard is already live and the backend is not.** Vercel deploys on
push to `main`, so the browser is currently asking a server that has neither
`/api/preferences` nor the `appointments` table. Both failures are handled —
Appearance shows "using standard size", the Calendar tab is hidden behind its
flag — but until step 1 runs, those two features do nothing.

**Take a backup.** Both migrations are additive (two `CREATE TABLE`s, no
rewrites, no drops), so this is routine rather than a precaution against
anything specific.

**Migration 143 needs four GHL scopes that may not be granted yet.** See §4.
The appointments table will be created and stay empty without them.

---

## 1. Server

```bash
cd /path/to/dealhub/server
git pull
npm ci --omit=dev
npm run migrate
pm2 restart pipelinepulse-server
```

`npm run migrate` should report **ran 2** — `143_appointments.sql` and
`144_ui_preferences.sql` — and skip the other 142. If it reports ran 1, check
which one it skipped before going on: 143 may already be in from an earlier
attempt, but 144 cannot be.

### What each migration creates

| Migration | Table | What it holds |
|---|---|---|
| 143 | `appointments` | HighLevel appointments and blocked time, mirrored. Empty until the scopes in §4 are granted and the first sync runs. |
| 144 | `ui_preferences` | Zoom and text size, per sub-account (`user_id NULL`) and per user. Empty until somebody saves one; the app's defaults apply meanwhile. |

Both are `location_id`-scoped with the usual `tenant_iso` RLS policy.

---

## 2. Check it came up

```bash
pm2 logs pipelinepulse-server --lines 40 --nostream
```

Then, from a browser already signed in to the dashboard, open **Control panel
→ Appearance**. If the warning strip is gone and the sliders move the page,
the route is live. Moving a slider changes nothing on the server until you
press Save, so this is safe to try.

To confirm from the database instead:

```sql
SELECT location_id, user_id, prefs, updated_by, updated_at
  FROM ui_preferences
 ORDER BY updated_at DESC;
```

A row with `user_id` NULL is that sub-account's default; a row with a user id
overrides it for that person.

---

## 3. What this deploy also carries

These shipped in the same range of commits and need no separate step — they
are live the moment the process restarts.

- **Task phantoms.** A task the CRM no longer recognises is now soft-deleted
  locally the first time a write to it is refused, and the rep is told it has
  been removed rather than "check the values and try again".
- **`npm run probe:task -- <location_id> <task_id>`** — asks GHL three
  separate questions about one task, for when a row is doing something
  inexplicable.
- **`tasksSync` instrumentation.** Each run now records `seen`, `sources`,
  `deletesSkipped` and `skipReasons` in `sync_runs.counts`. This is the
  outstanding diagnosis — see §5.
- **Calendar API** — `/api/appointments`, its resources filter, and the
  45-day window cap the month grid needs.

---

## 4. GHL scopes — needed before the calendar holds anything

The marketplace app needs four scopes it may not have:

```
calendars.readonly
calendars/events.readonly
calendars/events.write
locations.readonly
```

**Scopes can only be changed while the app is in draft.** If it has been
published, this needs the app put back to draft first, and every sub-account
has to reauthorise afterwards — so do it in one pass rather than discovering
a fifth scope later.

Until they are granted, 143's table exists and stays empty, the webhooks log
their payloads as unhandled, and the nightly reconcile reads nothing. Nothing
breaks; nothing arrives either.

### Then verify

1. Create an appointment in GHL on a calendar in this sub-account.
2. `SELECT id, title, start_time, assigned_user_id FROM appointments ORDER BY created_at DESC LIMIT 5;`
3. It should be there within seconds, by webhook.

**Blocked time has no webhook** — GHL fires nothing when you block an hour
out. Its only path is the nightly reconcile, and that path has not been
watched run yet. Block an hour in GHL, wait for the 3am sweep (or run
`npm run sync:appointments` if you do not want to wait), and check for a row
with `event_kind = 'blocked'`.

---

## 5. Still open after this deploy

**`tasksSync` has deleted nothing in ten nights.** That is what creates the
phantom rows in the first place; everything shipped so far catches them one
failed click at a time. The instrumentation to answer it is now live, so:

```bash
cd /path/to/dealhub/server && npm run sync:tasks
```

Read the per-location lines for `source`, `seen` and `truncated`. Each points
at a different fix:

- `seen: 0` — the sweep is reading nothing at all.
- `truncated: true` — it is paging out before it reaches the end, so the
  delete pass is correctly refusing to act on a partial list.
- `source: "per-contact"` — it is only looking at tasks attached to contacts
  it already knows, which cannot see a task whose contact has gone.

---

## 6. Dashboard

Nothing to do. Vercel deploys on push to `main`.

The Calendar tab is still behind `VITE_FEATURE_CALENDAR=true` as a Vercel
environment variable. The appearance settings are **not** gated — they are
live in the Control panel as soon as §1 runs.

---

## Rollback

```bash
cd /path/to/dealhub/server
git checkout <previous-sha>
npm ci --omit=dev
pm2 restart pipelinepulse-server
```

**Leave the migrations in place.** Both only add tables; an older server
ignores them entirely. Dropping `ui_preferences` would discard whatever
people had already set, and there is no reason to.
