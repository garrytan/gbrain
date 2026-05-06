# GBrain MCP request log partitioning runbook — Phase 4C

Date: 2026-05-06
Scope: `mcp_request_log` indexes, pg_partman monthly partitioning, and `access_tokens.last_used_at` hot-row cooling.

## Migration

Migration: `v38 mcp_request_log_indexes_partman_v0_27_1` in `src/core/migrate.ts`.

It does three things:

1. Adds request-log lookup indexes:
   - `idx_mcp_log_created_at` on `(created_at DESC)`
   - `idx_mcp_log_token_created` on `(token_name, created_at DESC)`
   - `idx_mcp_log_op_status` on `(operation, status)` where `status <> 'success'`
2. If Postgres has `pg_partman`, converts `public.mcp_request_log` to monthly RANGE partitions on `created_at` before the table reaches 100k rows.
3. Retains the renamed pre-partition table as `public.mcp_request_log_legacy` for rollback/inspection.

PGLite skips this migration body. Local PGLite is not the remote MCP auth/logging surface.

## Preconditions

Run before `mcp_request_log` reaches 100k rows:

```sql
SELECT count(*) FROM public.mcp_request_log;
```

If count is >= 100000, the migration refuses automatic conversion. Do a maintenance-window manual migration instead.

`pg_partman` should be available to the database role:

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman;
SELECT extname, n.nspname AS schema
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE extname = 'pg_partman';
```

If the extension is unavailable, v38 leaves the table unpartitioned but still creates the indexes.

## Verification

Indexes:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'mcp_request_log'
  AND indexname IN (
    'idx_mcp_log_created_at',
    'idx_mcp_log_token_created',
    'idx_mcp_log_op_status'
  )
ORDER BY indexname;
```

Partitioning:

```sql
SELECT c.relname, pt.partstrat
FROM pg_partitioned_table pt
JOIN pg_class c ON c.oid = pt.partrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'mcp_request_log';
```

pg_partman config:

```sql
SELECT parent_table, control, partition_interval, premake, retention, retention_keep_table
FROM partman.part_config
WHERE parent_table = 'public.mcp_request_log';
```

If the extension is installed into a non-`partman` schema, replace `partman.part_config` with the extension schema shown by the extension query above.

Query-plan checks:

```sql
EXPLAIN SELECT *
FROM public.mcp_request_log
ORDER BY created_at DESC
LIMIT 50;

EXPLAIN SELECT *
FROM public.mcp_request_log
WHERE token_name = 'hermes-operator'
ORDER BY created_at DESC
LIMIT 50;

EXPLAIN SELECT *
FROM public.mcp_request_log
WHERE operation = 'query'
  AND status <> 'success'
ORDER BY created_at DESC
LIMIT 50;
```

Expected: plans include index scans or bitmap index scans using the new indexes. Tiny tables may still use seq scan; set `enable_seqscan = off` for a forced smoke only, not as a production setting.

## Hot-row cooling verification

Legacy bearer-token paths now use a process-local LRU and SQL WHERE guard. Ten requests in one minute should still create ten `mcp_request_log` rows, but should issue at most one `access_tokens.last_used_at` update per token per process.

Unit coverage: `test/token-last-used.test.ts`.

Manual smoke:

```sql
SELECT name, last_used_at FROM access_tokens WHERE name = '<token-name>';
-- Send 10 authenticated MCP calls within 60 seconds.
SELECT name, last_used_at FROM access_tokens WHERE name = '<token-name>';
SELECT count(*) FROM mcp_request_log
WHERE token_name = '<token-name>'
  AND created_at > now() - interval '1 minute';
```

## Rollback

If partitioning causes trouble during the same release window:

```sql
BEGIN;
ALTER TABLE IF EXISTS public.mcp_request_log RENAME TO mcp_request_log_partitioned_bad;
ALTER TABLE IF EXISTS public.mcp_request_log_legacy RENAME TO mcp_request_log;
CREATE INDEX IF NOT EXISTS idx_mcp_log_created_at ON public.mcp_request_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_log_token_created ON public.mcp_request_log (token_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_log_op_status ON public.mcp_request_log (operation, status) WHERE status <> 'success';
COMMIT;
```

Then remove the pg_partman config row only after confirming no managed partitions are still needed:

```sql
DELETE FROM partman.part_config WHERE parent_table = 'public.mcp_request_log';
```

Do not drop `mcp_request_log_partitioned_bad` until request-log continuity is verified.
