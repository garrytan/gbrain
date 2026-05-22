# RLS and you

Short version: GBrain does not currently use database Row Level Security as its
primary authorization layer. Remote access is authorized in the MCP/app layer
with bearer tokens and operation scopes; Postgres is reached with service-role
credentials.

That means the dangerous state is not simply "RLS is off". The dangerous state
is RLS enabled with zero policies: service-role connections bypass it, while
non-bypass maintenance roles get mysteriously locked out. It looks safe and is
not. Cute trapdoor. We killed it.

## Current posture

Phase 4D sets the default posture to service-role-only:

- GBrain-owned tables have RLS disabled.
- Those tables carry a `GBRAIN:RLS_POSTURE` table comment explaining why.
- The legacy `auto_rls_on_create_table` event trigger is removed.
- Future anon/non-service tables may use RLS, but only with real policies.
- `gbrain doctor` fails on any public table that has RLS enabled with zero
  policies.

PGLite is skipped. It is embedded and single-user; RLS is not a meaningful
security boundary there.

## What doctor checks

Doctor audits every public base table and counts policies:

```sql
SELECT
  c.relname AS tablename,
  c.relrowsecurity AS rowsecurity,
  COALESCE(p.policy_count, 0)::int AS policy_count,
  COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN (
  SELECT polrelid, count(*) AS policy_count
  FROM pg_policy
  GROUP BY polrelid
) p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;
```

Healthy states:

1. RLS disabled with a `GBRAIN:RLS_POSTURE ...` comment for service-role-only
   GBrain-owned tables.
2. RLS enabled with one or more real policies for future anon/non-service DB
   access.

Bad state:

- RLS enabled with zero policies.

Doctor reports that as a failure and prints remediation SQL:

```sql
ALTER TABLE "public"."table_name" DISABLE ROW LEVEL SECURITY;
-- service-role-only, or CREATE POLICY before keeping RLS enabled
```

## Migration v39

Migration v39 (`rls_service_role_only_posture_v0_27_2`) performs the cleanup for
existing Postgres installs:

```sql
DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table;
DROP FUNCTION IF EXISTS auto_enable_rls();

ALTER TABLE public.pages DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.pages IS
  'GBRAIN:RLS_POSTURE service-role-only; RLS disabled; MCP/app bearer-token authorization is the security boundary.';
```

The real migration loops over every known GBrain-owned table and applies the
same posture. It is idempotent and skips tables that are not present.

Migration v35 is intentionally preserved as a no-op because old migration
ledgers may already reference it. Fresh installs should not recreate the old
auto-RLS event trigger.

## If you actually need RLS

Do not re-enable RLS as a checkbox. Write policies first, then enable it.
Minimum shape:

```sql
CREATE POLICY your_table_service_policy
  ON public.your_table
  FOR ALL
  TO your_non_service_role
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;
```

For anon-facing tables, narrow the policy to the exact read/write behavior the
client needs. If the table is sensitive and the app already goes through GBrain,
leave RLS disabled and use GBrain's bearer-token scopes instead.

## Verification queries

Find zero-policy trapdoors:

```sql
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN (
  SELECT polrelid, count(*) AS policy_count
  FROM pg_policy
  GROUP BY polrelid
) p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND COALESCE(p.policy_count, 0) = 0
ORDER BY c.relname;
```

Find disabled tables missing the posture comment:

```sql
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT c.relrowsecurity
  AND COALESCE(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'GBRAIN:RLS_POSTURE%'
ORDER BY c.relname;
```

Check the legacy trigger is gone:

```sql
SELECT evtname, evtenabled
FROM pg_event_trigger
WHERE evtname = 'auto_rls_on_create_table';
```

Expected result: zero rows.

## Rollback

Do not roll back to the old v35 auto-RLS trigger. If you need database-level RLS,
write explicit policies table-by-table and then enable RLS. Restoring the old
zero-policy default just brings the trapdoor back with a nicer hat.
