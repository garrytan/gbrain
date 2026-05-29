# Storage Tiering

Cortex tenants often ingest both durable company knowledge and large generated
artifacts such as transcripts, media, exports, and connector snapshots. Storage
tiering keeps those categories clear without positioning the product as a
single-user repository tool.

## Tiers

| Tier | Purpose |
|---|---|
| `db_tracked` | Tenant knowledge that should be visible, reviewable, and restorable through the control plane. |
| `db_only` | Bulk or generated artifacts that should live in managed storage and only be cached locally when a worker needs them. |

The database remains the system of record. Local files are worker cache,
operator convenience, or migration input.

## Configuration

Tenant source configuration can include a `storage` block:

```yaml
storage:
  db_tracked:
    - people/
    - companies/
    - deals/
    - concepts/
    - projects/

  db_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
    - exports/
```

Each path must end in `/`. The loader normalizes missing trailing slashes and
rejects overlap between `db_tracked` and `db_only`.

Deprecated keys from earlier builds, `git_tracked` and `supabase_only`, still
load with a warning so existing tenants can migrate without data loss.

## Worker Behavior

`cortex sync` and managed ingestion workers use the tier map to decide what can
be cached locally and what should be restored from managed storage on demand.

For `db_only` paths, workers:

- avoid treating local disk as authoritative
- restore missing artifacts from the tenant database or object store
- keep generated media out of source-control-oriented workflows
- report missing artifacts in storage health checks

For `db_tracked` paths, workers:

- preserve normal source sync behavior
- keep source metadata attached to imported pages
- surface validation errors before writes are accepted

## Restore

```bash
cortex export --restore-only --source <source-id>
cortex export --restore-only --type media --source <source-id>
cortex export --restore-only --slug-prefix media/x/ --source <source-id>
```

`--restore-only` exports only rows that belong to `db_only` paths and are
missing from the worker cache. This is useful for ephemeral deployments,
background processors, and disaster recovery checks.

## Status

```bash
cortex storage status --source <source-id>
cortex storage status --source <source-id> --json
```

The status output includes:

- counts by storage tier
- disk/cache usage by tier when local cache is enabled
- missing `db_only` artifacts
- validation warnings
- current tier directory listing

## SaaS Use Cases

| Scenario | Why Tiering Helps |
|---|---|
| Connector ingestion | Slack, docs, repos, meeting tools, and ticketing systems can produce large artifacts without bloating source caches. |
| Ephemeral workers | Fresh workers can restore only the artifacts needed for a job. |
| Tenant migration | Operators can verify that managed storage has everything needed before moving a tenant. |
| Compliance isolation | Source-scoped storage policy makes it clearer which team data is cached where. |

## PGLite Demo Note

Local PGLite demos use a local database file, so `db_only` still lives on the
same machine. The tiering model is still useful for tests and demos, but hosted
tenants should use managed Postgres plus object storage for the full durability
and isolation posture.

## Compatibility

- Tenants without a storage block continue to work.
- Deprecated key names load with warnings.
- Tier changes do not move data by themselves; run restore/status checks before
  changing production worker cache policy.
