# misha → PipelinePulse handoff

How analysis done in misha's database becomes an Insights AI / Deal AI skill in ours.
Written 3 Oct 2026.

## The shape of it

misha keeps her own database and keeps analysing there. Nothing in this repo
connects to it. Work crosses over in two forms:

1. **Data** — a schema export, imported as numbered migrations. Done once
   already: `126_misha_schema.sql`, `127_misha_data.sql`,
   `128_misha_constraints.sql` loaded the `misha` schema (8 tables, 7,366
   rows) into our database.
2. **Analysis** — SQL she has proven against her copy. We turn it into a
   `public` view plus a skill registration.

She sends SQL. We review and migrate it. Nothing is applied to our database
outside `migrations/`.

## Why her SQL can't be a skill as written

A skill does not store SQL. It names a view, and `skillStore.js` builds the
SELECT itself:

```js
const sql = `SELECT ${cols} FROM ${skill.viewName}`
  + ` WHERE ${where.join(' AND ')}`
  + ` ORDER BY ${skill.orderBy}`
  + ` LIMIT ${limit}`;
```

So a query with CTEs, joins, or several parts becomes a VIEW first. One view
per skill. A three-part query is three views and three skills.

## Rules a view must satisfy

Enforced by `skillValidator.js` on save — a view that breaks these is refused:

1. **Lives in `public`.** The validator looks only in `public`, and its
   identifier regex `^[a-z][a-z0-9_]{0,62}$` forbids a dot, so `misha.replies`
   cannot be named by a skill. A `public` view reading `misha.*` is fine —
   same database, ordinary join.
2. **`WITH (security_invoker = true)`.** Without it the view runs as its owner
   and bypasses row-level security. This is the single most important line.
3. **Selects `location_id`.** `runSkill` appends `location_id = $n`
   unconditionally. The app connects as a role with `rolbypassrls = true`, so
   RLS is skipped in production — that explicit predicate is the real tenant
   boundary, and the view must expose the column for it.
4. **Every column named in `params` / `columns` / `orderBy` exists.** Column
   names are interpolated, not bound, so they are checked against the catalogue.

Conventions we hold to beyond the validator, learned across the existing 43:

5. **No brand CASE.** `WHEN 'IFcSg...' THEN 'BGD'` is dead weight — a skill
   only ever sees one account — and returns NULL for any account not listed.
6. **Join on BOTH `location_id` and the id.** `contact_id` and
   `opportunity_id` are unique per location, not globally. A join on the id
   alone crosses tenants.
7. **No `HAVING` floors.** Expose `min_*` as a parameter instead, so the model
   can choose the threshold rather than inherit someone's guess.
8. **Window functions partition by `location_id`.**
9. **Caveats go in the skill `description`, as instructions to the model** —
   not as SQL comments, which it never sees.

## What we send back

For each accepted query: a migration adding the view, a JSON file in
`data/skills/`, and a registry entry. Then `npm run seed:skills` registers it
per sub-account. See `data/skills/close-reason-list.json` for the shape.

## Known traps in the current misha data

Measured on the loaded copy, not estimated:

- **`replies` → `questions` is 95% orphaned.** Of 371 replies carrying a
  `customer_question_id`, 353 point at a question id that no longer exists:
  there is no FK on that column and `questions` was truncated to a 50-row
  legacy sample. An INNER JOIN returns 18 rows and raises no error.
  `phrases` was truncated the same way. Treat both as legacy.
- **`misha.deal_why_sentence` cannot back a skill** — hardcoded brand CASE, no
  tenant predicate, no `security_invoker`.
- **Theme vocabularies differ per location.** `requirement_theme_map` has
  "Technical/spec objection" for one account and "Technical/drawing/spec
  objection" for the other — same concept, different string. Never hardcode a
  theme list; read it from the table per location.
- **`requirement_theme_map` joins on a free-text label**, not an id, with no
  FK. Unmapped labels vanish on an inner join — prefer LEFT JOIN with an
  `(unmapped)` fallback.
- **`requirements` contains duplicates.** The same message appears extracted
  more than once with slightly different label wording, which slips past the
  `(location_id, message_id, requirement_label)` unique. Any raw count
  over-counts.
- **`jsonb_array_elements_text(client_type)` multiplies rows.** A deal typed
  `["Contractor","Architect"]` yields two rows, so a `count(*)` of joined
  replies double-counts. Correct for "per buyer-type", wrong for "replies".
- **The import is a snapshot, frozen 2 Oct 2026.** Migration 127 has no
  `ON CONFLICT`, so re-running the export naively would duplicate every row.
  A refresh needs a migration that truncates `misha.*` first, or upserts.

## Refresh

New data from misha = a new numbered migration, same as any schema change.
Never applied by hand.
