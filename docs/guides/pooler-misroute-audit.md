# Pooler misroute audit

A brain whose `gbrain serve` read pool pipelined statements through a
transaction-mode pooler (Supavisor or PgBouncer on port 6543, or a URL with
`?prepare=false`) before v0.60.187.0 could hand a statement another
statement's rows (#6543). Most of the time that failed loudly
(`pg_statement_build_failed` with `error=UNDEFINED_VALUE`, `pg_connection_stuck`),
but a statement that bound a value from someone else's row and succeeded
leaves a persistence row whose identity belongs to another row.
`scripts/audit-pooler-misroute.ts` looks for those rows. It only reads.

**Say to your agent:** *"Run the gbrain pooler misroute audit for the window
the serve ran through the transaction pooler, and show me the result before
changing anything."*

## When to run it

Run it once after upgrading if, before the upgrade, any of these held for a
serve or worker on the brain:

- the database URL used port 6543 or `?prepare=false`;
- the log carried `pg_statement_build_failed`, `pg_connection_stuck` or
  `pg_connection_desync` lines;
- `/health?deep=1` showed `transport.max_pipeline` other than `0` behind such a
  URL.

The window is from the first such serve start (or the first warn line) until
the upgraded serve started.

## Run

The script is one self-contained file: it needs no checkout and imports
nothing from gbrain, only the postgres driver your install already ships
(`vendor/postgres` under the gbrain install; set
`GBRAIN_AUDIT_POSTGRES_DRIVER=<path to vendor/postgres/src/index.js>` if it is
not found). On a host without a checkout, copy `scripts/audit-pooler-misroute.ts`
from the gbrain repository at this version or later, then:

```bash
bun audit-pooler-misroute.ts \
  --url 'postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres' \
  --since 2026-10-01T00:00:00Z --until 2026-10-12T18:00:00Z --json > audit.json
```

- `--url` is explicit (never read from the environment) and must be the direct
  URL or the session pooler (Supabase: port 5432). A transaction-mode URL (port
  6543 or `?prepare=false`) is refused: the audit must not read through the
  transport it audits. It opens one connection.
- Each batch (`--batch-size`, default 500 rows) is one
  `REPEATABLE READ READ ONLY` transaction with a transaction-local timeout
  (`--batch-timeout-ms`, default 15000). There is no snapshot across batches;
  a row written while the audit runs is reported `unknown`
  (`changed_during_audit`). Running it beside a live serve is safe.
- Exit `0`: no mismatch. Exit `1`: at least one mismatch. Exit `2`: usage error
  or refused URL.

## Read the result

- `verified_ok` counts requests and effects whose identity values all agree.
- `mismatch` lists each row and field whose value belongs to another row:
  an effect whose `source_id`, `source_incarnation` or `worktree_id` differs
  from its own request (they are copied in one statement), a request whose
  `source_incarnation` is another source's (`belongs_to`), or a request whose
  `page_id` names a page in another source.
- `unknown` lists rows the audit cannot judge, with `reasons`
  (`unknown_by_reason` counts them): `changed_during_audit`,
  `compacted_history`, `token_reclaimed` (the claim stamp names another
  execution token), `source_removed`, `source_reincarnated`, `page_removed`,
  `page_slug_differs` (usually a later move) and `effect_identity_unset` (rows
  from before those columns). Unknown is not clean: it is a coverage gap.

## After a mismatch

Do not repair anything from the audit alone. A corrective write is a one-way
door: send `audit.json` (it holds row ids and identity values, no page
content) with the serve logs of the window to the brain's owner, and decide
the fix together from a preview. Re-running the audit is always safe.
