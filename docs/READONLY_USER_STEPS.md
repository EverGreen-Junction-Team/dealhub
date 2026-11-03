# Creating Misha's read-only user — commands

Four sub-accounts, read-only:
`E0nGtwuWd1cmeoc6ilD1` · `fJNuIdxGgchGpJ9OoBbk` · `IFcSg4YvuVlx56msjbdf` · `kHcvavc8fEeqkEPTK2T8`

Script: `docs/READONLY_USER.sql`

---

## If you already hit "permission denied to alter role"

The script's `ALTER ROLE misha NOSUPERUSER ...` line caused it. `ALTER ROLE
... NOSUPERUSER` needs SUPERUSER rights **even to clear an attribute the role
does not have**, and the Supabase SQL editor is not a true superuser.

That line has been removed — it was never needed, because NOSUPERUSER,
NOBYPASSRLS, NOCREATEDB and NOCREATEROLE are already the defaults for
`CREATE ROLE`.

Clean up first, **as its own query**, then run the script.

> ⚠️ Do NOT paste this into `READONLY_USER.sql`. It is a separate step. Put it
> in the editor alone, run it, then clear the editor and paste the script.
> Dropped in the middle of the script it removes the role between its creation
> and the policies, and all 34 `CREATE POLICY` statements fail with
> `role "misha" does not exist`.

**Query 1 — cleanup (run alone, then clear the editor):**

```sql
DROP OWNED BY misha;
DROP ROLE IF EXISTS misha;
DROP FUNCTION IF EXISTS misha_locations();
```

`DROP OWNED BY` comes first — `DROP ROLE` fails while policies reference it. If
`misha` does not exist yet, the first two lines error harmlessly; carry on.

**Query 2 — the script:** paste `docs/READONLY_USER.sql` unmodified, with only
`REPLACE_ME` swapped for the password. Do not add, remove or reorder anything
else — the order matters: role → function → policies.

**Then check it worked:**

```sql
SELECT
  (SELECT count(*) FROM pg_roles    WHERE rolname    = 'misha')      AS role_exists,
  (SELECT count(*) FROM pg_policies WHERE policyname = 'misha_read') AS policies,
  (SELECT count(*) FROM pg_proc     WHERE proname    = 'misha_locations') AS fn;
```

Expect **`1 | 34 | 1`**. Anything else means the script did not complete —
re-read the editor output for the first error rather than re-running blindly.

---

## Step 0 — pick a password

```bash
openssl rand -base64 24
```

Keep it out of the repo, tickets and chat. It goes in the SQL once and in the
connection string once.

---

## Step 1 — run the script

**Use the Supabase SQL editor**, not the app's pooler URL:

> Supabase dashboard → project `qxzpncjvnkmxhggeswpu` → SQL Editor → New query

`CREATE ROLE` is DDL and needs a **session** connection. The app's
`DATABASE_URL` is the *transaction* pooler (port 6543, `?pgbouncer=true`), and
DDL through it is unreliable. The SQL editor runs as the service role on a
direct session, so it just works.

1. Open `docs/READONLY_USER.sql`
2. Replace `REPLACE_ME` with the password from Step 0
3. Paste the whole file into the editor
4. **Run**

Expect: `CREATE ROLE`, a run of `GRANT`/`REVOKE`, then 34 × `CREATE POLICY`.
No errors.

### If you'd rather use psql

Only with the **session** pooler (port **5432**, no `pgbouncer=true`):

```bash
psql "postgresql://postgres.qxzpncjvnkmxhggeswpu:<SERVICE_PASSWORD>@aws-1-eu-west-2.pooler.supabase.com:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f docs/READONLY_USER.sql
```

`ON_ERROR_STOP=1` matters — without it psql ploughs on after a failure and you
get a half-created role.

---

## Step 2 — verify (as misha, not as postgres)

```bash
PGPASSWORD='<PASSWORD>' psql \
  "postgresql://misha.qxzpncjvnkmxhggeswpu@aws-1-eu-west-2.pooler.supabase.com:6543/postgres" \
  -c "SELECT location_id, count(*) FROM contacts GROUP BY 1 ORDER BY 1;"
```

Expect **exactly four rows**, one per allowed location. If you see a fifth, the
policy is wrong — stop and say so.

Then confirm it is genuinely read-only. Each of these must fail:

```bash
PGPASSWORD='<PASSWORD>' psql \
  "postgresql://misha.qxzpncjvnkmxhggeswpu@aws-1-eu-west-2.pooler.supabase.com:6543/postgres" <<'SQL'
DELETE FROM contacts;                     -- permission denied for table contacts
UPDATE contacts SET first_name = 'x';     -- permission denied for table contacts
CREATE TABLE misha_test (id int);         -- permission denied for schema public
SQL
```

**Check the third one especially.** If `CREATE TABLE` *succeeds*, the
`REVOKE CREATE ON SCHEMA public` did not apply — the SQL editor's role does
not own the schema. Misha is still read-only on your data, but can create
their own tables in `public`. Fix it by running those two REVOKE lines as the
schema owner, and drop anything they made:

```sql
DROP TABLE IF EXISTS misha_test;
```

And the role's actual powers — expect `f | f | f | t`:

```sql
SELECT rolsuper, rolbypassrls, rolcreatedb, rolcanlogin
  FROM pg_roles WHERE rolname = 'misha';
```

---

## Step 3 — send the connection string

```
postgresql://misha.qxzpncjvnkmxhggeswpu:<PASSWORD>@aws-1-eu-west-2.pooler.supabase.com:6543/postgres
```

Two things that break it if changed:

- The username **must** carry the project-ref suffix
  (`misha.qxzpncjvnkmxhggeswpu`, not bare `misha`)
- It **must** be the pooler host — the direct URL is IPv6-only

Send it out of band. Misha needs no `SET` statement: the policies resolve the
four locations on their own.

---

## Changing the four locations later

Edit the one function and re-run it — no policy changes:

```sql
CREATE OR REPLACE FUNCTION misha_locations() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['loc1','loc2','loc3']
$$;
```

## Revoking access

```sql
DROP OWNED BY misha;   -- drops the 34 policies that reference the role
DROP ROLE misha;
DROP FUNCTION IF EXISTS misha_locations();
```

`DROP OWNED BY` first — `DROP ROLE` fails while policies still reference it.
