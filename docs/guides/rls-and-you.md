# Row Level Security

Cortex SaaS tenants should run with Row Level Security enabled on public tables
unless a table has an explicit, reviewed exemption.

## Why

The Cortex service role can perform trusted maintenance work, but anonymous or
low-privilege database roles should not be able to read tenant data directly.
RLS is defense in depth alongside app-level OAuth, source scoping, and skill
policy enforcement.

## Exemption Comment

If a table is intentionally readable, document it with an explicit comment:

```sql
COMMENT ON TABLE public.analytics_rollup IS
  'CORTEX:RLS_EXEMPT reason=analytics-only, anon-readable ok, owner=platform, 2026-04-22';
```

Exemptions should be rare and reviewed.

## Verify

```bash
cortex doctor --json
```

The doctor output should report missing RLS, missing event triggers, and any
known exemptions.
