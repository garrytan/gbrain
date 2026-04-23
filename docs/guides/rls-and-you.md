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
