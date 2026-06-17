# RLS and you

Short version: every table in your gbrain's `public` schema needs Row Level
Security enabled. If one doesn't, `gbrain doctor` now fails, not warns, and the
process exits 1.

This guide explains why, what to do when you hit the check, and the escape hatch
for the cases where you really do want a table to stay readable by the anon key.

## Why RLS matters

Supabase exposes everything in the `public` schema via PostgREST. Whatever's
there is reachable by the anon key, which is a client-side secret by design.
If RLS is off on a public table, the anon key can read it. On anything sensitive
(auth tokens, chat history, financial data) that's an exfiltration vector, not
a footgun.

gbrain's service-role connection holds `BYPASSRLS`, so enabling RLS without
policies does NOT break gbrain itself. It just blocks the anon key's default
read. That's the security posture: deny-by-default to anon, full access for
the service role.

## What to do when doctor fails

Doctor's message names every table missing RLS and gives you a `ALTER TABLE`
line per table:

```
1 table(s) WITHOUT Row Level Security: expenses_ramp.
Fix: ALTER TABLE "public"."expenses_ramp" ENABLE ROW LEVEL SECURITY;
If a table should stay readable by the anon key on purpose, see
docs/guides/rls-and-you.md for the GBRAIN:RLS_EXEMPT comment escape hatch.
```

99% of the time, you want the fix. Run the SQL. Re-run `gbrain doctor`. Done.

## v0.26.7 — auto-RLS event trigger and one-time backfill

Starting in v0.26.7 (migration v35), gbrain ships two changes that close the
gap where a table could exist in your `public` schema without RLS for any
amount of time at all.

**1. The event trigger.** A Postgres DDL event trigger named
`auto_rls_on_create_table` runs `ALTER TABLE … ENABLE ROW LEVEL SECURITY`
on every newly created `public.*` table. It covers `CREATE TABLE`,
`CREATE TABLE AS … SELECT`, and `SELECT … INTO` — every syntax Postgres
reports as a table-creation command. Tables created by gbrain itself, by
your other apps sharing the same Supabase project (Baku, Hermes, anything),
or by a human running raw SQL all get RLS enabled the moment they exist.
Non-`public` schemas (`auth`, `storage`, `realtime`, etc.) are explicitly
ignored — Supabase manages those, and we should not touch them.

**2. The one-time backfill.** When you upgrade to v0.26.7, the migration
walks every existing `public.*` base table whose RLS is off and whose comment
doesn't carry the `GBRAIN:RLS_EXEMPT` exemption (see below) and enables RLS
on each. After the upgrade, `gbrain doctor`'s `rls` check should be a no-op
on every brain.

### Breaking change: read this before upgrading

If you have public tables that are intentionally RLS-off and you want them
to stay that way, you MUST add the `GBRAIN:RLS_EXEMPT` comment **before**
running `gbrain upgrade` to v0.26.7. The backfill flips RLS on for any public
table that doesn't carry the exact comment contract documented below. There
is no `--dry-run` flag on the migration.

The minimum cost of getting this wrong is one round-trip: the operator runs
the SQL to enable RLS on a table that should have been exempt, then
`ALTER TABLE … DISABLE ROW LEVEL SECURITY` and adds the exempt comment to
prevent a re-flip on a later doctor run. No data is lost.

### Cross-app implications

If a non-gbrain app (Baku, Hermes, a script you wrote, anything) creates
tables in the same Supabase project, the trigger will enable RLS on those
tables too. Two ways to handle that:

1. **The app's connection role has BYPASSRLS** (e.g. it's also using the
   `postgres` role). Newly created tables get RLS on but the app reads/writes
   freely because BYPASSRLS bypasses policies entirely.
2. **The app's role does NOT have BYPASSRLS.** Then the app needs to add a
   `CREATE POLICY` immediately after creating the table, granting itself
   the read/write access it needs. The trigger does NOT add policies — it
   only enables RLS, leaving the deny-by-default posture in place until the
   app's policy lands.

If neither condition holds, the app will fail to read its own freshly-created
tables. The fix is at the app side, not gbrain's: either grant BYPASSRLS or
ship a policy.

### What if the trigger gets dropped?

`gbrain doctor` includes a new `rls_event_trigger` check that verifies the
trigger is installed and enabled. If you drop it manually for any reason
(debugging, migration testing, anything), doctor warns and gives you the
recovery command:

```
gbrain apply-migrations --force-retry 35
```

Re-running migration v35 is idempotent — it `DROP EVENT TRIGGER IF EXISTS`
and recreates cleanly.

### Why no FORCE ROW LEVEL SECURITY?

Postgres has two RLS dials. `ENABLE` blocks anon/authenticated; `FORCE` also
blocks the table OWNER unless they hold BYPASSRLS. We use `ENABLE` only,
matching the posture in `src/schema.sql`, migrations v24, and v29. `FORCE`
would lock non-BYPASSRLS apps out of their own freshly-created tables (the
trigger function inherits the caller's role, not the gbrain role) — which
defeats the cross-app coexistence story above. If you want defense-in-depth
`FORCE` on a specific gbrain-owned table, add it explicitly in your own
migration; gbrain's auto-RLS does not opt you in by default.

## The 1% case: deliberate exemption

Sometimes a public table is supposed to be readable by the anon key. An
analytics view backing a public dashboard. A read-only reference table. A
plugin that ships its own frontend and intentionally uses the anon key for
reads.

gbrain has an escape hatch for these. It is deliberately painful to set up.
That is the feature.

### The format

```sql
-- In psql, connected as a BYPASSRLS role (e.g. postgres):
COMMENT ON TABLE public.your_table IS
  'GBRAIN:RLS_EXEMPT reason=<why this is anon-readable on purpose>';
```

Rules:

- The comment value MUST start with `GBRAIN:RLS_EXEMPT` (case-sensitive).
- It MUST include `reason=` followed by at least 4 characters of justification.
- No other prefix, no checkbox in a config file, no environment variable. Only
  a Postgres table comment counts.
- If RLS is also off on the table (which it must be for the anon key to
  actually read), you also need `ALTER TABLE ... DISABLE ROW LEVEL SECURITY;`
  explicitly. Disabling alone is not enough; the comment is what tells doctor
  this is intentional.

### Example

```sql
ALTER TABLE public.expenses_ramp DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses_ramp IS
  'GBRAIN:RLS_EXEMPT reason=analytics-only, anon-readable ok, owner=garry, 2026-04-22';
```

After that, `gbrain doctor` reports:

```
rls: ok — RLS enabled on 20/21 public tables (1 explicitly exempt: expenses_ramp)
```

Note that every subsequent run re-enumerates your exemptions by name. That's
intentional. The escape hatch is not a one-time sign-off, it's a recurring
reminder. If you ever want to know which tables are open, run `gbrain doctor`.

## Why SQL and not a CLI subcommand

gbrain does NOT ship a `gbrain rls-exempt add <table>` command. A CLI command
would make it easy for an agent to silently open a table to anon reads. The
comment-in-psql requirement forces the operator to type the justification
in SQL, which is:

- Visible in shell history.
- Visible in a git-tracked schema dump.
- Visible in `pg_dump` output the next time you restore.
- Visible in `gbrain doctor` output on every run.

An agent CAN still run the SQL, but it can't do it without the user seeing the
action. That's the "write it in blood" design.

## Auditing exemptions later

To see every exemption in the current DB:

```sql
SELECT
  c.relname AS table_name,
  obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND obj_description(c.oid, 'pg_class') LIKE 'GBRAIN:RLS_EXEMPT%';
```

If that list is longer than you remember signing off on, that's the signal.

## Removing an exemption

Just drop the comment and re-enable RLS:

```sql
ALTER TABLE public.expenses_ramp ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expenses_ramp IS NULL;
```

`gbrain doctor` stops listing the table as exempt and goes back to checking
it like any other.

## PGLite

If you're on PGLite (the zero-config default), doctor skips this check
entirely: PGLite is embedded, single-user, and has no PostgREST in front of
it. The public-schema-exposure risk doesn't exist. You'll see:

```
rls: ok — Skipped (PGLite — no PostgREST exposure, RLS not applicable)
```

If you migrate to Supabase or self-hosted Postgres later, the check starts
running and will flag any table that came over without RLS.

## Self-hosted Postgres

If you're running Postgres without PostgREST in front, the anon-key exposure
doesn't apply. But gbrain still fails the check on missing RLS, because:

- The framing is "RLS on all public tables" is a gbrain security invariant,
  not a Supabase-specific workaround.
- The `ALTER TABLE ... ENABLE RLS` fix is harmless on any Postgres: it only
  constrains non-bypass roles, which gbrain doesn't use.
- If you ever put PostgREST or a similar tool in front later, the guard is
  already in place.

If this framing doesn't fit your deployment, file an issue with the specifics
so we can decide whether a self-hosted-exempt mode is justified.
